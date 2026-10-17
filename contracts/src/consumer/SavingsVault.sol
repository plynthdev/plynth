// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISignatureTransfer, IAllowanceTransfer} from "../interfaces/IPermit2.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {KeyChecks} from "../libs/KeyChecks.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";

interface ICanonicalRegistry {
    function isCanonical(address token) external view returns (bool);
}

/// Holds each saver's USDG and turns keeper-attested card spends into round-ups.
///
/// Two balances per user, in USDG base units:
///   available: topped up, not earmarked. Withdrawable any time.
///   pending:   earmarked by round-ups for the next crowd buy. Withdrawable any time until swept.
///
/// Trust: the keeper can only move a user's own available into their own pending (bounded by the
/// user's settings, weekly cap and replay guard) and pull the user's own fixed top-up into their own
/// available at most once per 7 days. Only CrowdBuy can take funds out (sweep), and only into CrowdBuy.
/// The CrowdBuy address is set once. The owner can rotate the keeper and nothing else: there is no
/// pause, no rescue and no owner path that moves user funds. withdraw never consults the owner or keeper.
///
/// Eligibility: once the owner sets the EligibilityRegistry (set once), choosing a buy mix (setMix) and
/// joining a crowd buy (CrowdBuy.join reads `eligibility` here) require `isEligible(user)`. Nothing on the
/// exit side (withdraw, cancel, claims) ever checks it, so a revoked or expired user can always leave.
/// Deploy scripts must call setEligibility before Stock Tokens are offered; while unset, buys are ungated.
contract SavingsVault is Ownable2Step, EIP712, ChangeDelay {
    using SafeERC20 for IERC20;

    struct Settings {
        uint8 roundTo; // whole USDG: 1, 5 or 10
        uint8 multiplier; // 1, 2 or 3
        uint64 weeklyCap; // base units, <= MAX_WEEKLY_CAP
        uint64 fixedTopUp; // base units: 0 (off), 25, 50 or 100 USDG
        uint8 mode; // 0 Open, 1 Quiet, 2 Hidden
    }

    /// Hidden delivery keys (todo 16): the note owner key (Poseidon2 of the spending secret, a bn254 field
    /// element) and the x25519 viewing public key notes are encrypted to. Kept beside Settings so the
    /// Settings ABI stays unchanged.
    struct HiddenKeys {
        bytes32 ownerPk;
        bytes32 viewingPub;
    }

    struct MixEntry {
        address stockToken;
        uint16 weightBps;
    }

    struct Account {
        uint256 available;
        uint256 pending;
        uint64 week; // week index of accruedThisWeek
        uint64 accruedThisWeek;
        uint64 lastTopUpAt;
    }

    uint256 public constant MAX_MIX = 5;
    uint256 private constant BN254_P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint64 public constant TOP_UP_SPACING = 7 days;
    bytes32 public constant LINK_TYPEHASH =
        keccak256("LinkWallet(address user,address wallet,uint256 nonce,uint256 deadline)");

    IERC20 public immutable usdg;
    address public immutable permit2;
    ICanonicalRegistry public immutable registry;
    uint256 public immutable unit; // 10 ** usdg.decimals()
    uint64 public immutable MAX_WEEKLY_CAP; // 500 USDG

    address public keeper;
    address public crowd;
    IEligibility public eligibility;

    mapping(address user => Account) private _accounts;
    mapping(address user => Settings) private _settings;
    mapping(address user => MixEntry[]) private _mix;
    mapping(bytes32 sourceKey => bool) public sourceUsed;
    mapping(address wallet => address user) public linkedUser;
    mapping(address wallet => uint256) public linkNonce;
    mapping(address user => HiddenKeys) private _hiddenKeys;

    event KeeperSet(address indexed keeper);
    event CrowdSet(address indexed crowd);
    event EligibilitySet(address indexed eligibility);
    event Deposited(address indexed user, uint256 amount, bool viaPermit2);
    event Withdrawn(address indexed user, address indexed to, uint256 amount, uint256 fromAvailable, uint256 fromPending);
    event SettingsSet(
        address indexed user, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, uint64 fixedTopUp, uint8 mode
    );
    event HiddenKeysSet(address indexed user, bytes32 ownerPk, bytes32 viewingPub);
    event MixSet(address indexed user, MixEntry[] mix);
    event WalletLinked(address indexed user, address indexed wallet, uint256 nonce);
    event WalletUnlinked(address indexed user, address indexed wallet);
    event Accrued(
        address indexed user, bytes32 indexed sourceTx, uint32 logIndex, uint256 spend, uint256 added, uint64 week
    );
    event TopUpPulled(address indexed user, uint256 amount);
    event Swept(address indexed user, address indexed crowd, uint256 amount);
    event Refunded(address indexed user, uint256 amount);

    error NotKeeper();
    error NotCrowd();
    error ZeroAddress();
    error ZeroAmount();
    error CrowdAlreadySet();
    error InsufficientBalance(uint256 requested, uint256 balance);
    error InvalidSettings();
    error InvalidMix();
    error WrongPermitToken();
    error AlreadyAccrued(bytes32 sourceTx, uint32 logIndex);
    error SignatureExpired();
    error BadSignature();
    error NotLinked();
    error NoFixedTopUp();
    error TopUpTooSoon(uint256 nextAt);
    error NoMix();
    error NotEligible(address user);
    error EligibilityAlreadySet();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyCrowd() {
        if (msg.sender != crowd || msg.sender == address(0)) revert NotCrowd();
        _;
    }

    constructor(IERC20 usdg_, address permit2_, ICanonicalRegistry registry_, address owner_, address keeper_)
        Ownable(owner_)
        EIP712("Plynth SavingsVault", "1")
    {
        if (address(usdg_) == address(0) || permit2_ == address(0) || address(registry_) == address(0)) {
            revert ZeroAddress();
        }
        usdg = usdg_;
        permit2 = permit2_;
        registry = registry_;
        unit = 10 ** IERC20Metadata(address(usdg_)).decimals();
        MAX_WEEKLY_CAP = SafeCast.toUint64(500 * unit);
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    // ---------------------------------------------------------------- owner

    /// A new keeper waits CHANGE_DELAY (48 h) in public; removing the keeper (zero) applies at once (it only stops
    /// round-ups and fixed top-ups; withdraw never needs the keeper).
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ != address(0) && !_delayed()) return;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    /// One-time: CrowdBuy is deployed after the vault. Fixing it stops the owner from pointing sweep elsewhere.
    function setCrowd(address crowd_) external onlyOwner {
        if (crowd != address(0)) revert CrowdAlreadySet();
        if (crowd_ == address(0)) revert ZeroAddress();
        crowd = crowd_;
        emit CrowdSet(crowd_);
    }

    /// One-time: fixing the registry stops the owner from swapping in one that gates differently.
    function setEligibility(IEligibility eligibility_) external onlyOwner {
        if (address(eligibility) != address(0)) revert EligibilityAlreadySet();
        if (address(eligibility_) == address(0)) revert ZeroAddress();
        eligibility = eligibility_;
        emit EligibilitySet(address(eligibility_));
    }

    /// True when no registry is set yet, otherwise the registry's answer. Used for buying only.
    function canBuy(address user) public view returns (bool) {
        IEligibility e = eligibility;
        return address(e) == address(0) || e.isEligible(user);
    }

    // ---------------------------------------------------------------- user

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _accounts[msg.sender].available += amount;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, false);
    }

    function depositWithPermit2(uint256 amount, ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig)
        external
    {
        if (amount == 0) revert ZeroAmount();
        if (p.permitted.token != address(usdg)) revert WrongPermitToken();
        _accounts[msg.sender].available += amount;
        ISignatureTransfer(permit2).permitTransferFrom(
            p, ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}), msg.sender, sig
        );
        emit Deposited(msg.sender, amount, true);
    }

    /// Never gated: no pause, keeper or owner check. Takes from available first, then pending.
    function withdraw(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Account storage a = _accounts[msg.sender];
        uint256 total = a.available + a.pending;
        if (amount > total) revert InsufficientBalance(amount, total);
        uint256 fromAvailable = amount <= a.available ? amount : a.available;
        uint256 fromPending = amount - fromAvailable;
        a.available -= fromAvailable;
        a.pending -= fromPending;
        usdg.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount, fromAvailable, fromPending);
    }

    function setSettings(Settings calldata s) external {
        if (s.roundTo != 1 && s.roundTo != 5 && s.roundTo != 10) revert InvalidSettings();
        if (s.multiplier < 1 || s.multiplier > 3) revert InvalidSettings();
        if (s.weeklyCap > MAX_WEEKLY_CAP) revert InvalidSettings();
        if (s.fixedTopUp != 0 && s.fixedTopUp != 25 * unit && s.fixedTopUp != 50 * unit && s.fixedTopUp != 100 * unit)
        {
            revert InvalidSettings();
        }
        if (s.mode > 2) revert InvalidSettings();
        _settings[msg.sender] = s;
        emit SettingsSet(msg.sender, s.roundTo, s.multiplier, s.weeklyCap, s.fixedTopUp, s.mode);
    }

    /// Registers (or clears, with both zero) the keys Hidden delivery uses. ownerPk must be a bn254 field
    /// element; zero ownerPk with a non-zero viewing key is rejected, and so is a low-order x25519 viewing key (every
    /// note encrypted to it would be readable by anyone, and the keeper's x25519 refuses it: audit M-6). Only the
    /// user can set their own keys.
    function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub) external {
        if (uint256(ownerPk) >= BN254_P) revert InvalidSettings();
        if ((ownerPk == 0) != (viewingPub == 0)) revert InvalidSettings();
        if (viewingPub != 0 && KeyChecks.isLowOrderX25519(viewingPub)) revert InvalidSettings();
        _hiddenKeys[msg.sender] = HiddenKeys(ownerPk, viewingPub);
        emit HiddenKeysSet(msg.sender, ownerPk, viewingPub);
    }

    function setMix(MixEntry[] calldata mix) external {
        if (!canBuy(msg.sender)) revert NotEligible(msg.sender);
        uint256 n = mix.length;
        if (n == 0 || n > MAX_MIX) revert InvalidMix();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address t = mix[i].stockToken;
            if (mix[i].weightBps == 0 || !registry.isCanonical(t)) revert InvalidMix();
            for (uint256 j; j < i; ++j) {
                if (mix[j].stockToken == t) revert InvalidMix();
            }
            sum += mix[i].weightBps;
        }
        if (sum != 10_000) revert InvalidMix();
        delete _mix[msg.sender];
        MixEntry[] storage m = _mix[msg.sender];
        for (uint256 i; i < n; ++i) {
            m.push(mix[i]);
        }
        emit MixSet(msg.sender, mix);
    }

    /// `walletSig` must be an EIP-712 LinkWallet signature by `wallet` (EOA or ERC-1271) naming msg.sender.
    function linkSpendingWallet(address wallet, uint256 deadline, bytes calldata walletSig) external {
        if (wallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired();
        uint256 nonce = linkNonce[wallet];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, msg.sender, wallet, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(wallet, digest, walletSig)) revert BadSignature();
        linkNonce[wallet] = nonce + 1;
        linkedUser[wallet] = msg.sender;
        emit WalletLinked(msg.sender, wallet, nonce);
    }

    function unlinkSpendingWallet(address wallet) external {
        if (linkedUser[wallet] != msg.sender) revert NotLinked();
        delete linkedUser[wallet];
        emit WalletUnlinked(msg.sender, wallet);
    }

    // ---------------------------------------------------------------- keeper

    /// Moves the user's round-up for one attested spend from available to pending, clipped to the
    /// weekly cap and to available. Each (sourceTx, logIndex) counts once ever, even when it adds 0.
    function accrue(address user, bytes32 sourceTx, uint32 logIndex, uint256 spendAmount)
        external
        onlyKeeper
        returns (uint256 added)
    {
        bytes32 key = keccak256(abi.encode(sourceTx, logIndex));
        if (sourceUsed[key]) revert AlreadyAccrued(sourceTx, logIndex);
        sourceUsed[key] = true;

        Account storage a = _accounts[user];
        Settings memory s = _settings[user];
        uint64 week = uint64(block.timestamp / 1 weeks);
        if (a.week != week) {
            a.week = week;
            a.accruedThisWeek = 0;
        }

        uint256 r = roundUp(spendAmount, s.roundTo, s.multiplier);
        uint256 room = s.weeklyCap > a.accruedThisWeek ? s.weeklyCap - a.accruedThisWeek : 0;
        added = r < room ? r : room;
        if (added > a.available) added = a.available;

        if (added != 0) {
            a.available -= added;
            a.pending += added;
            a.accruedThisWeek += uint64(added); // added <= room <= weeklyCap (uint64)
        }
        emit Accrued(user, sourceTx, logIndex, spendAmount, added, week);
    }

    /// Pulls the user's chosen fixed top-up through their Permit2 allowance. Amount and the 7-day
    /// spacing come from the user's settings and this contract, never from the keeper.
    function pullFixedTopUp(address user) external onlyKeeper {
        uint256 amount = _settings[user].fixedTopUp;
        if (amount == 0) revert NoFixedTopUp();
        Account storage a = _accounts[user];
        if (a.lastTopUpAt != 0) {
            uint256 nextAt = uint256(a.lastTopUpAt) + TOP_UP_SPACING;
            if (block.timestamp < nextAt) revert TopUpTooSoon(nextAt);
        }
        a.lastTopUpAt = uint64(block.timestamp);
        a.available += amount;
        IAllowanceTransfer(permit2).transferFrom(user, address(this), SafeCast.toUint160(amount), address(usdg));
        emit TopUpPulled(user, amount);
    }

    // ---------------------------------------------------------------- crowd

    function sweep(address user) external onlyCrowd returns (MixEntry[] memory mix, uint256 amount) {
        Account storage a = _accounts[user];
        amount = a.pending;
        mix = _mix[user];
        if (amount == 0) return (mix, 0);
        if (mix.length == 0) revert NoMix();
        a.pending = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit Swept(user, msg.sender, amount);
    }

    /// CrowdBuy approves this vault first; the refund is pulled so balances never run ahead of tokens.
    function refundFromCrowd(address user, uint256 amount) external onlyCrowd {
        if (amount == 0) revert ZeroAmount();
        _accounts[user].available += amount;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Refunded(user, amount);
    }

    // ---------------------------------------------------------------- views

    /// (ceil(spend / roundToUnits) * roundToUnits - spend) * multiplier, where roundToUnits = roundTo * unit.
    /// Exact multiples give 0. roundTo == 0 (no settings) gives 0.
    function roundUp(uint256 spend, uint8 roundTo, uint8 multiplier) public view returns (uint256) {
        if (roundTo == 0) return 0;
        uint256 u = uint256(roundTo) * unit;
        uint256 rem = spend % u;
        return rem == 0 ? 0 : (u - rem) * multiplier;
    }

    function accountOf(address user) external view returns (Account memory) {
        return _accounts[user];
    }

    function balancesOf(address user) external view returns (uint256 available, uint256 pending) {
        Account storage a = _accounts[user];
        return (a.available, a.pending);
    }

    function settingsOf(address user) external view returns (Settings memory) {
        return _settings[user];
    }

    function hiddenKeysOf(address user) external view returns (HiddenKeys memory) {
        return _hiddenKeys[user];
    }

    function mixOf(address user) external view returns (MixEntry[] memory) {
        return _mix[user];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
