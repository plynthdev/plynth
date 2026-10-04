// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Valuer} from "../core/Valuer.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryAccount} from "./TreasuryAccount.sol";
import {AssetValuation} from "../libs/AssetValuation.sol";
import {ISleeve, IPeriodStartNav} from "../interfaces/ISleeve.sol";
import {ITierSource, Tier} from "../interfaces/ITierSource.sol";
import {IPrivateSleeve} from "./PrivateSleeve.sol";

/// Optional hook on the fee recipient (FeeRouter, todo 30).
interface ICloseFeeHook {
    function onCloseFee(address account, uint256 amount) external;
}

/// Every period ends with a statement the chain itself checks. The controller signs a `Close`; `commit`
/// recomputes, in the same call, everything the statement claims about the account's holdings:
///
/// - `navUsd` must equal `account.navUsd()` exactly (no tolerance), so a statement cannot claim money that
///   is not there;
/// - `cashBps` / `equityBps` must equal the band weights from the sleeves' own `valueOf`;
/// - `positionsHash` must equal keccak256(abi.encode(Position[])) over every held asset (raw > 0), sorted
///   by address, each with its raw balance, USD price per whole token, multiplier and Chainlink round id;
/// - no held, canonical Stock Token's feed may be on hold (`HoldAtClose`; the service retries when markets
///   reopen). A delisted held token is recorded at price 0 and does not block the close (it is already
///   worth 0 in NAV);
/// - `policyHash` / `policyVersion` must be the TreasuryPolicy version in force at `periodEnd`, and the
///   signer must be that version's controller (EIP-712; ERC-1271 for a contract controller).
///
/// `bundleHash` is the keccak256 of the off-chain bundle JSON (positions, prices, desk actions, guard
/// denials) the CFO pack renders from; the chain only stores the hash.
///
/// After the checks a platform fee of navUsd x 25 bps x elapsed / 365 days is paid from the account's idle
/// cash (USDG) to `feeRecipient`; what idle cash cannot cover is carried as `feeOwed` to the next close.
/// `periodStartNav` (read by the PolicyGuard drawdown rule) becomes the NAV after the fee. The fee recipient
/// is the FeeRouter in production.
///
/// Weekly close: when `tiers` is set, a period shorter than `WEEKLY_BELOW` (28 days) is accepted only while
/// the account's board holds a staking tier with `weeklyClose` (`TierTooLow` otherwise). Non-upgradeable.
///
/// Private sleeve (`commitWithPrivateSleeve`): when the account has a PrivateSleeve, NAV = the public part
/// (recomputed on-chain exactly as above) + a private lower bound proven by a circuits/treasury_close proof over
/// the sleeve's unspent notes at prices pinned from the Valuer in the same call; the proof also shows the band
/// weights (with the exact private value) are inside the policy bands of the version in force. `cashBps` /
/// `equityBps` count the proven private part in the sleeve's band; `positionsHash` covers public positions only;
/// the bundle notes the private part (root, proven NAV, prices commitment, nullifiers: `PrivateSleeveProven`).
/// The plain `commit` is refused while the sleeve's book is not empty, so a shielded book cannot drop out of a
/// statement (an empty sleeve proves 0 with an all-padding proof).
///
/// Deployed either directly (constructor) or as an EIP-1167 clone by TreasuryFactory (`initialize`, once; the
/// EIP-712 domain uses the clone's own address). All-zero constructor arguments deploy a locked implementation.
contract PeriodClose is EIP712, IPeriodStartNav {
    struct Close {
        uint64 periodEnd;
        uint256 navUsd;
        uint16 cashBps;
        uint16 equityBps;
        bytes32 positionsHash;
        bytes32 bundleHash;
        bytes32 policyHash;
        uint32 policyVersion;
    }

    struct Position {
        address asset;
        uint256 raw;
        uint256 price; // USD (1e18) per 10**decimals raw units
        uint256 multiplier; // 1e18; Stock Tokens: uiMultiplier (already inside price), others 1e18
        uint80 roundId; // Chainlink round of the price; 0 for cash and vault shares
    }

    bytes32 public constant CLOSE_TYPEHASH = keccak256(
        "Close(uint64 periodEnd,uint256 navUsd,uint16 cashBps,uint16 equityBps,bytes32 positionsHash,bytes32 bundleHash,bytes32 policyHash,uint32 policyVersion)"
    );
    uint256 public constant FEE_BPS = 25;
    uint256 public constant YEAR = 365 days;
    uint256 private constant BPS = 10_000;
    uint32 public constant WEEKLY_BELOW = 28 days;

    TreasuryAccount public account;
    TreasuryPolicy public policy;
    Valuer public valuer;
    IERC20 public cash;
    uint8 public cashDecimals;
    address public feeRecipient; // zero = no fee
    uint64 public startTime; // fee accrual start of the first period
    ITierSource public tiers; // zero = no tier gating (weekly close always allowed)
    bool private _initialized;

    Close[] private _closes;
    uint256 public periodStartNav;
    uint256 public feeOwed; // cash raw units not yet paid

    event PeriodClosed(
        uint256 indexed index, uint64 indexed periodEnd, Close close, uint256 feeRaw, uint256 feePaid, uint256 feeOwed
    );

    error ZeroAddress();
    error PeriodInFuture(uint64 periodEnd, uint256 nowTs);
    error PeriodTooEarly(uint64 periodEnd, uint64 earliest);
    error NoPolicyAt(uint64 periodEnd);
    error PolicyMismatch(bytes32 hash, uint32 version);
    error HoldAtClose(address token);
    error NavMismatch(uint256 expected, uint256 claimed);
    error WeightsMismatch(uint16 cashBps, uint16 equityBps);
    error PositionsMismatch(bytes32 expected);
    error BadSignature();
    error TierTooLow(address board);
    error AlreadyInitialized();
    error NoPrivateSleeve();
    error PrivateBookOpen(uint256 bookUsd);

    event PrivateSleeveProven(
        uint256 indexed index, bytes32 root, uint256 privateNavUsd, bytes32 pricesCommitment, bytes32[8] nullifiers
    );

    constructor(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        EIP712("Plynth PeriodClose", "1")
    {
        if (
            address(account_) == address(0) && address(cash_) == address(0) && feeRecipient_ == address(0)
                && address(tiers_) == address(0)
        ) {
            _initialized = true; // implementation for clones: never usable itself
            return;
        }
        _init(account_, cash_, feeRecipient_, tiers_);
    }

    /// Clone setup (TreasuryFactory), once. The account must already be initialized (policy and guard are read).
    function initialize(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        external
    {
        _init(account_, cash_, feeRecipient_, tiers_);
    }

    function _init(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        private
    {
        if (_initialized) revert AlreadyInitialized();
        if (address(account_) == address(0) || address(cash_) == address(0)) revert ZeroAddress();
        _initialized = true;
        account = account_;
        policy = account_.policy();
        valuer = account_.guard().valuer();
        cash = cash_;
        cashDecimals = cash_.decimals();
        feeRecipient = feeRecipient_;
        startTime = uint64(block.timestamp);
        tiers = tiers_;
    }

    // ---------------------------------------------------------------- commit

    function commit(Close calldata c, bytes calldata controllerSig) external {
        uint64 prevEnd = _checkTiming(c.periodEnd);
        address controller = _checkPolicy(c);
        _checkTier(prevEnd, c.periodEnd);
        address ps = account.privateSleeve();
        if (ps != address(0)) {
            uint256 book = IPrivateSleeve(ps).bookUsd();
            if (book != 0) revert PrivateBookOpen(book);
        }

        (bytes32 posHash,) = _positions(true);
        (uint256 nav,) = account.navUsd();
        if (c.navUsd != nav) revert NavMismatch(nav, c.navUsd);
        (uint16 cashBps, uint16 equityBps) = _weightsOf(_bandUsd(), nav);
        if (c.cashBps != cashBps || c.equityBps != equityBps) revert WeightsMismatch(cashBps, equityBps);
        if (c.positionsHash != posHash) revert PositionsMismatch(posHash);

        if (!SignatureChecker.isValidSignatureNow(controller, digest(c), controllerSig)) revert BadSignature();

        _record(c, prevEnd);
        (periodStartNav,) = account.navUsd();
    }

    /// `commit` for an account with a private sleeve: `c.navUsd` = public NAV + `p.navUsd` (proven lower bound).
    function commitWithPrivateSleeve(
        Close calldata c,
        bytes calldata controllerSig,
        IPrivateSleeve.PrivateClose calldata p
    ) external {
        uint64 prevEnd = _checkTiming(c.periodEnd);
        address controller = _checkPolicy(c);
        _checkTier(prevEnd, c.periodEnd);
        IPrivateSleeve ps = IPrivateSleeve(account.privateSleeve());
        if (address(ps) == address(0)) revert NoPrivateSleeve();

        (bytes32 posHash,) = _positions(true);
        if (c.positionsHash != posHash) revert PositionsMismatch(posHash);
        bytes32 pc = _checkPrivate(c, p, ps);
        if (!SignatureChecker.isValidSignatureNow(controller, digest(c), controllerSig)) revert BadSignature();

        uint256 index = _record(c, prevEnd);
        ps.onClose(p.navUsd);
        (uint256 pubAfter,) = account.navUsd();
        periodStartNav = pubAfter + p.navUsd;
        emit PrivateSleeveProven(index, p.root, p.navUsd, pc, p.nullifiers);
    }

    /// Stores the close and pays the fee on its NAV.
    function _record(Close calldata c, uint64 prevEnd) private returns (uint256 index) {
        _closes.push(c);
        index = _closes.length - 1;
        (uint256 feeRaw, uint256 paid, uint256 owed) = _fee(c.navUsd, c.periodEnd - prevEnd);
        emit PeriodClosed(index, c.periodEnd, c, feeRaw, paid, owed);
    }

    /// NAV and weights with the private part in the sleeve's band, then the proof against the public book and the
    /// bands of the policy version the close names (already checked to be the one in force).
    function _checkPrivate(Close calldata c, IPrivateSleeve.PrivateClose calldata p, IPrivateSleeve ps)
        private
        view
        returns (bytes32)
    {
        IPrivateSleeve.BookContext memory ctx;
        (ctx.pubNav,) = account.navUsd();
        uint256 nav = ctx.pubNav + p.navUsd;
        if (c.navUsd != nav) revert NavMismatch(nav, c.navUsd);
        ctx.pubBandUsd = _bandUsd();
        uint256[3] memory withPrivate = _bandUsd(); // a fresh copy: memory arrays alias on assignment
        withPrivate[ps.band()] += p.navUsd;
        (uint16 cashBps, uint16 equityBps) = _weightsOf(withPrivate, nav);
        if (c.cashBps != cashBps || c.equityBps != equityBps) revert WeightsMismatch(cashBps, equityBps);

        (TreasuryPolicy.Policy memory pol,,) = policy.policyAt(c.policyVersion);
        ctx.policyHash = c.policyHash;
        ctx.bandMin = [pol.cash.minBps, pol.equity.minBps, pol.basis.minBps];
        ctx.bandMax = [pol.cash.maxBps, pol.equity.maxBps, pol.basis.maxBps];
        return ps.checkClose(p, ctx);
    }

    // ---------------------------------------------------------------- views

    function latest() external view returns (Close memory c) {
        if (_closes.length != 0) c = _closes[_closes.length - 1];
    }

    function closeAt(uint256 index) external view returns (Close memory) {
        return _closes[index];
    }

    function closeCount() external view returns (uint256) {
        return _closes.length;
    }

    /// Earliest `periodEnd` the next commit accepts, and the policy period it was derived from.
    function nextPeriodEnd() public view returns (uint64) {
        if (_closes.length == 0) return startTime;
        uint64 prev = _closes[_closes.length - 1].periodEnd;
        uint32 v = policy.versionAt(prev);
        (TreasuryPolicy.Policy memory p,,) = policy.policyAt(v);
        return prev + p.periodSeconds;
    }

    function digest(Close calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLOSE_TYPEHASH,
                    c.periodEnd,
                    c.navUsd,
                    c.cashBps,
                    c.equityBps,
                    c.positionsHash,
                    c.bundleHash,
                    c.policyHash,
                    c.policyVersion
                )
            )
        );
    }

    /// What `commit` would recompute right now: the held positions (sorted), their hash, NAV, band weights and
    /// whether a held feed is on hold (`holdToken` = the first one, zero if none). The close service builds its
    /// statement from this and retries if the chain moves before inclusion.
    function preview()
        external
        view
        returns (
            Position[] memory positions,
            bytes32 positionsHash,
            uint256 navUsd,
            uint16 cashBps,
            uint16 equityBps,
            address holdToken
        )
    {
        (positionsHash, positions, holdToken) = _positionsView();
        (navUsd,) = account.navUsd();
        (cashBps, equityBps) = _weightsOf(_bandUsd(), navUsd);
    }

    /// Fee in cash raw units for `navUsd` (1e18) over `elapsed` seconds.
    function feeFor(uint256 navUsd, uint256 elapsed) public view returns (uint256) {
        if (feeRecipient == address(0)) return 0;
        uint256 usd = navUsd * FEE_BPS * elapsed / (BPS * YEAR);
        uint8 dec = cashDecimals;
        if (dec <= 18) return usd / 10 ** (18 - dec);
        return usd * 10 ** (dec - 18);
    }

    // ---------------------------------------------------------------- internal

    function _checkTiming(uint64 periodEnd) private view returns (uint64 prevEnd) {
        if (periodEnd > block.timestamp) revert PeriodInFuture(periodEnd, block.timestamp);
        uint64 earliest = nextPeriodEnd();
        if (periodEnd < earliest) revert PeriodTooEarly(periodEnd, earliest);
        prevEnd = _closes.length == 0 ? startTime : _closes[_closes.length - 1].periodEnd;
    }

    function _checkPolicy(Close calldata c) private view returns (address controller) {
        uint32 v = policy.versionAt(c.periodEnd);
        if (v == 0) revert NoPolicyAt(c.periodEnd);
        (TreasuryPolicy.Policy memory p, bytes32 h,) = policy.policyAt(v);
        if (c.policyVersion != v || c.policyHash != h) revert PolicyMismatch(h, v);
        controller = p.controller;
    }

    /// The period length is the one in force at the period's start (`prevEnd`), as in `nextPeriodEnd`; before
    /// the first policy version it is the one in force at `periodEnd`.
    function _checkTier(uint64 prevEnd, uint64 periodEnd) private view {
        if (address(tiers) == address(0)) return;
        uint32 v = policy.versionAt(prevEnd);
        if (v == 0) v = policy.versionAt(periodEnd);
        (TreasuryPolicy.Policy memory p,,) = policy.policyAt(v);
        if (p.periodSeconds >= WEEKLY_BELOW) return;
        address board = account.board();
        if (!tiers.tierOf(board).weeklyClose) revert TierTooLow(board);
    }

    /// Public cash / equity / basis USD from the sleeves' own `valueOf` (a private sleeve's is 0).
    function _bandUsd() private view returns (uint256[3] memory usd) {
        address[] memory sl = account.sleeves();
        for (uint256 i; i < sl.length; ++i) {
            (uint256 v,) = ISleeve(sl[i]).valueOf(address(account));
            uint8 band = ISleeve(sl[i]).band();
            usd[band > 2 ? 2 : band] += v;
        }
    }

    /// A basis sleeve (2) is in NAV but in neither weight.
    function _weightsOf(uint256[3] memory usd, uint256 nav) private pure returns (uint16 cashBps, uint16 equityBps) {
        if (nav == 0) return (0, 0);
        cashBps = uint16(usd[0] * BPS / nav);
        equityBps = uint16(usd[1] * BPS / nav);
    }

    function _positions(bool revertOnHold) private view returns (bytes32 h, address holdToken) {
        (h,, holdToken) = _positionsView();
        if (revertOnHold && holdToken != address(0)) revert HoldAtClose(holdToken);
    }

    function _positionsView() private view returns (bytes32 h, Position[] memory out, address holdToken) {
        (address[] memory assets, uint8[] memory kinds,) = account.trackedAssets();
        Position[] memory tmp = new Position[](assets.length);
        uint256 n;
        for (uint256 i; i < assets.length; ++i) {
            uint256 raw = IERC20(assets[i]).balanceOf(address(account));
            if (raw == 0) continue;
            Position memory p = tmp[n++];
            p.asset = assets[i];
            p.raw = raw;
            p.multiplier = 1e18;
            if (kinds[i] == AssetValuation.KIND_CASH) {
                p.price = 1e18;
            } else if (kinds[i] == AssetValuation.KIND_CASH_VAULT) {
                IERC4626 v = IERC4626(assets[i]);
                uint256 one = 10 ** IERC20Metadata(assets[i]).decimals();
                p.price = AssetValuation.to1e18(v.convertToAssets(one), IERC20Metadata(v.asset()).decimals());
            } else if (valuer.registry().isCanonical(assets[i])) {
                Valuer.Quote memory q = valuer.quote(assets[i]);
                p.price = q.priceUsdPerToken;
                p.multiplier = q.multiplier;
                p.roundId = q.roundId;
                if (q.hold && holdToken == address(0)) holdToken = assets[i];
            } else {
                p.multiplier = 0; // delisted: no trusted price, valued 0 in NAV
            }
        }
        out = new Position[](n);
        for (uint256 i; i < n; ++i) {
            // insertion sort by address (n <= MAX_SLEEVES x MAX_ASSETS_PER_SLEEVE)
            Position memory p = tmp[i];
            uint256 j = i;
            while (j > 0 && out[j - 1].asset > p.asset) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = p;
        }
        h = keccak256(abi.encode(out));
    }

    function _fee(uint256 nav, uint256 elapsed) private returns (uint256 feeRaw, uint256 paid, uint256 owed) {
        if (feeRecipient == address(0)) return (0, 0, 0);
        feeRaw = feeFor(nav, elapsed);
        uint256 due = feeOwed + feeRaw;
        uint256 idle = cash.balanceOf(address(account));
        paid = due < idle ? due : idle;
        owed = due - paid;
        feeOwed = owed;
        if (paid != 0) {
            account.payCloseFee(address(cash), feeRecipient, paid);
            // Tell a contract recipient (the FeeRouter) which treasury paid, so it can carve out the template
            // author's share. Best effort: a recipient without the hook (or one that reverts) never blocks a close.
            if (feeRecipient.code.length != 0) {
                try ICloseFeeHook(feeRecipient).onCloseFee(address(account), paid) {} catch {}
            }
        }
    }
}
