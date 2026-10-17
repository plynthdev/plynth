// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ShieldedPool, IHonkVerifier} from "../consumer/ShieldedPool.sol";
import {Poseidon2} from "../consumer/verifiers/Poseidon2.sol";
import {Valuer} from "../core/Valuer.sol";
import {ITierSource} from "../interfaces/ITierSource.sol";
import {ISleeve} from "../interfaces/ISleeve.sol";
import {ITreasuryAccount} from "../interfaces/ITreasuryAccount.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";

/// What PeriodClose and the PolicyGuard read from an account's private sleeve.
interface IPrivateSleeve {
    /// The private part of a period close: a `circuits/treasury_close` proof that the sleeve's unspent notes at
    /// `root` are worth at least `navUsd` (USD 1e18) at the pinned prices and keep the book inside its bands.
    struct PrivateClose {
        bytes proof;
        bytes32 root;
        uint256 navUsd;
        bytes32[8] nullifiers; // 0 = padding slot
    }

    /// Cash / equity / basis USD (1e18) of the public book and the bands (bps) of the policy version in force.
    struct BookContext {
        bytes32 policyHash;
        uint256 pubNav;
        uint256[3] pubBandUsd;
        uint16[3] bandMin;
        uint16[3] bandMax;
    }

    function band() external view returns (uint8);
    function bookUsd() external view returns (uint256);
    /// The book is not empty and its last proof is older than the policy period + PROOF_GRACE (no new shields).
    function bookStale() external view returns (bool);
    function checkClose(PrivateClose calldata p, BookContext calldata ctx) external view returns (bytes32);
    function onClose(uint256 provenUsd) external;
}

/// Private sleeve: Equity (or Basis) holdings of one TreasuryAccount moved into ShieldedPool notes, so the book
/// is not readable on-chain. Unlocked by the `privateSleeve` staking tier of the account's board.
///
/// Notes are owned by `ownerPk` = H(spending secret), the secret derived off-chain from the policy controller's
/// signature (sdk vault `deriveVaultKeys`). The controller sets the key here; this contract is the
/// depositor (pool origin) of every note it shields, and every unshield it performs pays the account.
///
/// Flows:
/// - shield (`run`, via TreasuryAccount.execute): only through the board-designated private desk (the account
///   enforces it), only while the board holds the tier. Pulls a declared asset from the account, deposits a
///   note for `ownerPk` and adds the asset's Valuer value to `bookUsd`.
/// - unshield (`unshield`): anyone may submit a withdraw proof whose recipient is this sleeve and whose relayer
///   fee is 0; it is never gated (no tier, desk, pause or guard check). The sleeve forwards what it received to the
///   account and `bookUsd` drops by its value. The recipient is the sleeve, not the account (audit L-10): a proof
///   submitted straight to `ShieldedPool.withdraw` then still lands here, and `sweep` (anyone) forwards it and
///   debits the book, so an unshield can never be counted both in the account and in the book.
/// - refund (`refund`): a deposit still pending in the pool returns to the account, ungated.
/// - close (`checkClose` / `onClose`, from PeriodClose): a treasury_close proof replaces `bookUsd` with the
///   proven private NAV.
///
/// `bookUsd` is the guard's view of the sleeve between closes: the last proven value plus shields minus
/// unshields, valued at the time of each flow. Private trades inside the pool (ShieldedTrade) and price moves
/// are not seen until the next close: band checks for private holdings use the last proven value until then
/// (documented limit). `valueOf` is 0: nothing here is visible on-chain, so `account.navUsd()` is the public
/// NAV and PeriodClose adds the proven private part.
///
/// Staleness (audit L-6): `lastProvenAt` is when the book was last proven (a proven close or a permissionless
/// `PeriodClose.refreshPrivateBook`), or when it was last opened from empty (a shield into an empty book: the book
/// is then exactly the shield). Once the book is not empty and that is older than the policy's period plus
/// PROOF_GRACE, `bookStale` is true and the guard refuses new shields (rule 10, code 18) until a fresh proof;
/// unshield, refund and sweep stay open. Residual: within the bound the book can still drift (private trades and
/// prices are unseen), and the guard keeps using it for NAV, bands and drawdown.
///
/// Trust: whoever holds the spending secret (the controller) can spend the notes inside the pool, including a
/// withdraw to any address; the guard bounds what enters the sleeve, and the next close shows (as lower NAV)
/// anything that left it. The proof shows the notes it opens; it cannot show that no note was left out, so the
/// proven NAV is a lower bound and the band check is over the notes shown (the controller signs the close).
contract PrivateSleeve is IPrivateSleeve, ISleeve, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ASSETS = 4;
    uint256 public constant MAX_NOTES = 8;
    uint256 public constant MAX_PRICE = (1 << 96) - 1; // circuit range-checks prices to 96 bits
    uint256 public constant MAX_USD = type(uint128).max; // circuit range-checks USD amounts to 128 bits
    /// Slack on top of the policy period before an unproven book is stale (closes wait for open markets).
    uint256 public constant PROOF_GRACE = 4 days;

    address public immutable account;
    ShieldedPool public immutable pool;
    Valuer public immutable valuer;
    ITierSource public immutable tiers; // zero = no tier gating
    IHonkVerifier public immutable closeVerifier;
    uint8 private immutable _band;

    address[] private _assets;
    mapping(address asset => bool) public isPrivateAsset;

    bytes32 public ownerPk;
    bytes32 public viewingPub;
    uint256 public bookUsd;
    /// Last proof of the book (or last time it was opened from empty).
    uint64 public lastProvenAt;
    mapping(uint256 pendingId => uint256 usd) public pendingUsd;

    event KeysSet(bytes32 ownerPk, bytes32 viewingPub);
    event Shielded(address indexed asset, uint256 raw, uint256 usd, uint256 indexed pendingId);
    event Unshielded(address indexed asset, uint256 raw, uint256 usd);
    event Swept(address indexed asset, uint256 raw, uint256 usd);
    event Refunded(uint256 indexed pendingId, address indexed asset, uint256 raw, uint256 usd);
    event BookReset(uint256 provenUsd);

    error ZeroAddress();
    error BadBand();
    error BadAssets();
    error NotAccount();
    error NotDesignated();
    error NotController();
    error NotPeriodClose();
    error NotAFieldElement();
    error NoKeys();
    error NotPrivateAsset(address asset);
    error TierTooLow(address board);
    error BadRecipient();
    error FeeNotAllowed();
    error UnknownRoot(bytes32 root);
    error NullifierSpent(bytes32 nullifier);
    error DuplicateNullifier(bytes32 nullifier);
    error HoldAtClose(address asset);
    error OutOfRange();
    error InvalidProof();

    constructor(
        address account_,
        ShieldedPool pool_,
        Valuer valuer_,
        ITierSource tiers_,
        IHonkVerifier closeVerifier_,
        uint8 band_,
        address[] memory assets_
    ) {
        if (
            account_ == address(0) || address(pool_) == address(0) || address(valuer_) == address(0)
                || address(closeVerifier_) == address(0)
        ) revert ZeroAddress();
        if (band_ != 1 && band_ != 2) revert BadBand();
        if (assets_.length == 0 || assets_.length > MAX_ASSETS) revert BadAssets();
        for (uint256 i; i < assets_.length; ++i) {
            address a = assets_[i];
            if (a == address(0) || isPrivateAsset[a] || !valuer_.registry().isCanonical(a)) revert BadAssets();
            if (IERC20Metadata(a).decimals() != 18) revert BadAssets(); // circuit values raw * price / 1e18
            isPrivateAsset[a] = true;
            _assets.push(a);
        }
        account = account_;
        pool = pool_;
        valuer = valuer_;
        tiers = tiers_;
        closeVerifier = closeVerifier_;
        _band = band_;
    }

    // ---------------------------------------------------------------- ISleeve

    function band() external view override(IPrivateSleeve, ISleeve) returns (uint8) {
        return _band;
    }

    /// Nothing is tracked by the account: the shielded book is not visible on-chain.
    function assets() external pure returns (address[] memory assets_, uint8[] memory kinds) {
        return (assets_, kinds);
    }

    /// 0: the private value enters NAV only through a proven close (PeriodClose) or the guard's `bookUsd`.
    function valueOf(address) external pure returns (uint256, bool) {
        return (0, false);
    }

    function privateAssets() external view returns (address[] memory) {
        return _assets;
    }

    // ---------------------------------------------------------------- keys

    /// The policy controller registers the note key it derived. New shields use it; notes under an older key stay
    /// spendable by that key's holder.
    function setKeys(bytes32 ownerPk_, bytes32 viewingPub_) external {
        (TreasuryPolicy.Policy memory p,,) = ITreasuryAccount(account).policy().current();
        if (msg.sender != p.controller) revert NotController();
        if (uint256(ownerPk_) >= Poseidon2.P || ownerPk_ == 0) revert NotAFieldElement();
        ownerPk = ownerPk_;
        viewingPub = viewingPub_;
        emit KeysSet(ownerPk_, viewingPub_);
    }

    // ---------------------------------------------------------------- shield (private desk only)

    /// TreasuryAccount.execute → run(abi.encode(asset, raw, blinding, encryptedNote)). The account has approved
    /// `raw` of `asset` to this contract for the call. Returns abi.encode(pendingId).
    function run(bytes calldata data) external nonReentrant returns (bytes memory) {
        if (msg.sender != account) revert NotAccount();
        if (ITreasuryAccount(account).privateSleeve() != address(this)) revert NotDesignated();
        _checkTier();
        bytes32 pk = ownerPk;
        if (pk == 0) revert NoKeys();
        (address asset, uint256 raw, bytes32 blinding, bytes memory note) =
            abi.decode(data, (address, uint256, bytes32, bytes));
        if (!isPrivateAsset[asset]) revert NotPrivateAsset(asset);

        (uint256 usd,) = valuer.value(asset, raw);
        IERC20(asset).safeTransferFrom(account, address(this), raw);
        IERC20(asset).forceApprove(address(pool), raw);
        uint256 pendingId = pool.deposit(asset, raw, pk, blinding, note);
        if (bookUsd == 0) lastProvenAt = uint64(block.timestamp); // opened from empty: the book is this shield
        bookUsd += usd;
        pendingUsd[pendingId] = usd;
        emit Shielded(asset, raw, usd, pendingId);
        return abi.encode(pendingId);
    }

    // ---------------------------------------------------------------- unshield / refund (never gated)

    /// Anyone: runs `pool.withdraw` for a note of this sleeve's key, paid to this sleeve, then forwards it to the
    /// account and debits the book. The proof binds the recipient; this contract insists it is itself and that no
    /// relayer fee leaves the treasury.
    function unshield(bytes calldata proof, ShieldedPool.PublicWithdraw calldata pub) external nonReentrant {
        if (pub.recipient != address(this)) revert BadRecipient();
        if (pub.relayerFee != 0) revert FeeNotAllowed();
        pool.withdraw(proof, pub);
        (uint256 raw, uint256 usd) = _sweep(pub.asset);
        emit Unshielded(pub.asset, raw, usd);
    }

    /// Anyone: forwards whatever of `asset` this sleeve holds (an unshield proof submitted straight to the pool,
    /// or a transfer) to the account, debiting its value from the book. The sleeve holds nothing between calls.
    function sweep(address asset) external nonReentrant {
        (uint256 raw, uint256 usd) = _sweep(asset);
        emit Swept(asset, raw, usd);
    }

    /// Anyone: a shield still pending in the pool goes back to the account.
    function refund(uint256 pendingId) external nonReentrant {
        ShieldedPool.Pending memory p = pool.pending(pendingId);
        pool.refundPending(pendingId);
        IERC20(p.asset).safeTransfer(account, p.raw);
        uint256 usd = pendingUsd[pendingId];
        delete pendingUsd[pendingId];
        _debit(usd);
        emit Refunded(pendingId, p.asset, p.raw, usd);
    }

    // ---------------------------------------------------------------- close

    /// Reverts unless `p.proof` is a treasury_close proof for this sleeve's key over a published pool root, with
    /// unspent distinct nullifiers, prices pinned from the Valuer now (none on hold) and the given public book and
    /// bands. Returns the prices commitment (for the close event).
    function checkClose(PrivateClose calldata p, BookContext calldata ctx) external view returns (bytes32 pc) {
        if (pool.rootSeq(p.root) == 0) revert UnknownRoot(p.root);
        if (p.navUsd > MAX_USD || ctx.pubNav > MAX_USD) revert OutOfRange();
        bytes32 pk = ownerPk;
        if (pk == 0) revert NoKeys();
        pc = pricesCommitment();

        bytes32[] memory inputs = new bytes32[](24);
        inputs[0] = p.root;
        inputs[1] = pk;
        inputs[2] = bytes32(uint256(ctx.policyHash) % Poseidon2.P);
        inputs[3] = pc;
        inputs[4] = bytes32(p.navUsd);
        inputs[5] = bytes32(ctx.pubNav);
        for (uint256 b; b < 3; ++b) {
            if (ctx.pubBandUsd[b] > MAX_USD) revert OutOfRange();
            inputs[6 + b] = bytes32(ctx.pubBandUsd[b]);
            inputs[9 + b] = bytes32(uint256(ctx.bandMin[b]));
            inputs[12 + b] = bytes32(uint256(ctx.bandMax[b]));
        }
        inputs[15] = bytes32(uint256(_band));
        for (uint256 i; i < MAX_NOTES; ++i) {
            bytes32 n = p.nullifiers[i];
            inputs[16 + i] = n;
            if (n == 0) continue;
            // The verifier reduces inputs mod p: n + p would pass the proof but miss the spent map.
            if (uint256(n) >= Poseidon2.P) revert NotAFieldElement();
            for (uint256 j; j < i; ++j) {
                if (p.nullifiers[j] == n) revert DuplicateNullifier(n);
            }
            if (pool.nullifierSpent(n)) revert NullifierSpent(n);
        }
        bool ok;
        try closeVerifier.verify(p.proof, inputs) returns (bool v) {
            ok = v;
        } catch {
            ok = false;
        }
        if (!ok) revert InvalidProof();
    }

    /// PeriodClose, after a proven close (or a proven refresh): the guard's book becomes the proven private NAV.
    function onClose(uint256 provenUsd) external {
        address pc = ITreasuryAccount(account).periodClose();
        if (msg.sender != pc || pc == address(0)) revert NotPeriodClose();
        bookUsd = provenUsd;
        lastProvenAt = uint64(block.timestamp);
        emit BookReset(provenUsd);
    }

    /// True while the book is not empty and its last proof is older than the policy period + PROOF_GRACE.
    function bookStale() external view returns (bool) {
        if (bookUsd == 0) return false;
        (TreasuryPolicy.Policy memory p,,) = ITreasuryAccount(account).policy().current();
        return block.timestamp > uint256(lastProvenAt) + p.periodSeconds + PROOF_GRACE;
    }

    /// acc_{k+1} = H(acc_k, H(asset, price, multiplier, roundId)) over MAX_ASSETS slots (unused slots zero),
    /// prices from the Valuer now. Reverts if a declared asset's feed is on hold or its price is out of range.
    function pricesCommitment() public view returns (bytes32) {
        uint256 acc;
        for (uint256 k; k < MAX_ASSETS; ++k) {
            uint256 h;
            if (k < _assets.length) {
                address a = _assets[k];
                Valuer.Quote memory q = valuer.quote(a);
                if (q.hold) revert HoldAtClose(a);
                if (q.priceUsdPerToken > MAX_PRICE) revert OutOfRange();
                h = Poseidon2.hash4(uint256(uint160(a)), q.priceUsdPerToken, q.multiplier, q.roundId);
            } else {
                h = Poseidon2.hash4(0, 0, 0, 0);
            }
            acc = Poseidon2.hash2(acc, h);
        }
        return bytes32(acc);
    }

    // ---------------------------------------------------------------- internal

    function _checkTier() private view {
        if (address(tiers) == address(0)) return;
        address board = ITreasuryAccount(account).board();
        if (!tiers.tierOf(board).privateSleeve) revert TierTooLow(board);
    }

    function _sweep(address asset) private returns (uint256 raw, uint256 usd) {
        raw = IERC20(asset).balanceOf(address(this));
        if (raw == 0) return (0, 0);
        usd = _valueOrZero(asset, raw);
        IERC20(asset).safeTransfer(account, raw);
        _debit(usd);
    }

    function _debit(uint256 usd) private {
        uint256 b = bookUsd;
        bookUsd = b > usd ? b - usd : 0;
    }

    /// Unshield never fails on valuation: an asset without a trusted price counts 0 against the book.
    function _valueOrZero(address asset, uint256 raw) private view returns (uint256) {
        if (raw == 0 || !isPrivateAsset[asset] || !valuer.registry().isCanonical(asset)) return 0;
        try valuer.value(asset, raw) returns (uint256 usd, bool) {
            return usd;
        } catch {
            return 0;
        }
    }
}
