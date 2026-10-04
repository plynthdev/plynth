// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ShieldedPool, IHonkVerifier} from "./ShieldedPool.sol";
import {IParkAdapter} from "./park/IParkAdapter.sol";
import {Poseidon2} from "./verifiers/Poseidon2.sol";
import {StockRouter} from "../core/StockRouter.sol";

/// Hidden Vault v2 (todo 25): private sell, buy, park and unpark of shielded notes, plus `settle`.
///
/// One `swap` proof (circuits/swap) spends a note of `assetIn`, keeps a v1 change note, and fixes an output
/// note except for its amount: `outPartial = H(assetOut, ownerPk, blinding)`. In the same transaction this
/// module takes `amountIn` out of the pool, pays `relayerFee` (in assetIn) to msg.sender, trades the rest, and
/// inserts the output note `H(outPartial, actualOut)` (a v2 "partial note", hidden/src/lib.nr) after checking
/// `actualOut >= minOut`. Any failure (slippage, oracle hold, deadline, cap) reverts the whole transaction,
/// so the input note stays unspent.
///
///   assetIn  -> assetOut         kind     how
///   USDG     -> Stock Token      Buy      StockRouter.buy (oracle minimum + slippage cap)
///   Stock    -> USDG             Sell     StockRouter.sell
///   USDG     -> park share       Park     IParkAdapter.park (adapter must be allow-listed and enabled)
///   share    -> USDG             Unpark   IParkAdapter.unpark (never gated)
///
/// A v2 note can be swapped again directly; `settle` (circuits/settle) turns it into a v1 note for
/// transfer/withdraw. Exits are never gated: `settle` and `unpark` check nothing the owner, a pause or a
/// keeper controls, and an adapter, once applied, stays the unpark route for its share token forever (park
/// shares can also always be settled and withdrawn from the pool as shares, then redeemed at the adapter).
///
/// The owner manages the park adapter allow-list only: adding takes ADAPTER_DELAY (48h) like a cap raise,
/// disabling (new parks only) applies at once. Buy, sell and park outputs count against the pool's deposit
/// caps and stop while pool deposits are paused; unpark does neither.
///
/// Units: notes hold raw token base units; a Stock Token `uiMultiplier` change never touches a note.
contract ShieldedTrade is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        Buy,
        Sell,
        Park,
        Unpark
    }

    /// Public inputs of a swap proof, in circuit order.
    struct PublicSwap {
        bytes32 root;
        bytes32 nullifier;
        bytes32 changeCommitment;
        address assetIn;
        uint256 amountIn; // leaves the note: relayerFee to msg.sender, the rest is traded
        uint256 relayerFee;
        address assetOut;
        uint256 minOut;
        bytes32 outPartial;
        uint64 deadline;
    }

    struct AdapterProposal {
        IParkAdapter adapter;
        uint64 eta;
    }

    uint64 public constant ADAPTER_DELAY = 48 hours;
    uint256 public constant MAX_RAW = type(uint128).max;
    uint256 private constant P = Poseidon2.P;

    ShieldedPool public immutable pool;
    IHonkVerifier public immutable swapVerifier;
    IHonkVerifier public immutable settleVerifier;
    StockRouter public immutable router;
    address public immutable usdg;

    /// share token -> adapter; set when an adapter is applied and never removed (the unpark route).
    mapping(address shareToken => IParkAdapter) public adapterOf;
    /// New parks allowed through this adapter.
    mapping(IParkAdapter adapter => bool) public parkEnabled;
    mapping(address shareToken => AdapterProposal) public adapterProposal;

    event Swapped(
        Kind indexed kind,
        address indexed assetIn,
        address indexed assetOut,
        uint256 amountIn,
        uint256 relayerFee,
        uint256 amountOut,
        bytes32 outCommitment
    );
    /// The v2 output note: commitment = H(outPartial, amount). The owner's SDK finds its note by `outPartial`.
    event PartialNoteFilled(bytes32 indexed outPartial, bytes32 commitment, uint256 amount);
    event Settled(bytes32 indexed nullifier, bytes32 commitment);
    event AdapterProposed(address indexed shareToken, address indexed adapter, uint64 eta);
    event AdapterApplied(address indexed shareToken, address indexed adapter);
    event ParkEnabled(address indexed adapter, bool enabled);

    error ZeroAddress();
    error BadPair(address assetIn, address assetOut);
    error BadAmount();
    error Expired(uint64 deadline);
    error Paused();
    error ParkDisabled(address adapter);
    error Slippage(uint256 minOut, uint256 got);
    error InputNotConsumed(uint256 left);
    error NotAFieldElement();
    error InvalidProof();
    error BadAdapter();
    error NoProposal();
    error TooEarly(uint64 eta);

    constructor(
        ShieldedPool pool_,
        IHonkVerifier swapVerifier_,
        IHonkVerifier settleVerifier_,
        StockRouter router_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(pool_) == address(0) || address(swapVerifier_) == address(0)
                || address(settleVerifier_) == address(0) || address(router_) == address(0)
        ) revert ZeroAddress();
        pool = pool_;
        swapVerifier = swapVerifier_;
        settleVerifier = settleVerifier_;
        router = router_;
        usdg = address(router_.usdg());
    }

    // ---------------------------------------------------------------- owner: park allow-list

    /// Proposes `adapter` (its share token becomes a note asset). Applies after ADAPTER_DELAY via `applyAdapter`.
    function proposeAdapter(IParkAdapter adapter) external onlyOwner {
        address share = _checkAdapter(adapter);
        uint64 eta = uint64(block.timestamp) + ADAPTER_DELAY;
        adapterProposal[share] = AdapterProposal(adapter, eta);
        emit AdapterProposed(share, address(adapter), eta);
    }

    /// Anyone, once the delay has passed. Enables parking through the adapter.
    function applyAdapter(address shareToken) external {
        AdapterProposal memory p = adapterProposal[shareToken];
        if (p.eta == 0) revert NoProposal();
        if (block.timestamp < p.eta) revert TooEarly(p.eta);
        delete adapterProposal[shareToken];
        adapterOf[shareToken] = p.adapter;
        parkEnabled[p.adapter] = true;
        emit AdapterApplied(shareToken, address(p.adapter));
        emit ParkEnabled(address(p.adapter), true);
    }

    /// Stops new parks at once. Unparking is unaffected. Re-enabling goes through `proposeAdapter` again.
    function disablePark(IParkAdapter adapter) external onlyOwner {
        parkEnabled[adapter] = false;
        emit ParkEnabled(address(adapter), false);
    }

    // ---------------------------------------------------------------- swaps

    /// Private buy / sell / park / unpark. Returns the amount received and the inserted output commitment.
    /// `maxSlippageBps` is only used for buy/sell (StockRouter's oracle guard); the proof's `minOut` binds always.
    function swap(
        bytes calldata proof,
        PublicSwap calldata pub,
        uint16 maxSlippageBps,
        bytes calldata encryptedChange,
        bytes calldata encryptedOut
    ) external nonReentrant returns (uint256 out, bytes32 outCommitment) {
        Kind kind = _begin(proof, pub);
        out = _trade(pub, kind, maxSlippageBps);
        outCommitment = _finish(pub, kind, out, encryptedChange, encryptedOut);
    }

    /// Checks, spends the nullifier and verifies the proof.
    function _begin(bytes calldata proof, PublicSwap calldata pub) private returns (Kind kind) {
        kind = kindOf(pub.assetIn, pub.assetOut);
        _checkSwap(pub, kind);
        pool.tradeSpend(pub.root, pub.nullifier);
        _verify(swapVerifier, proof, _swapInputs(pub));
    }

    /// Takes amountIn from the pool, pays the relayer, trades the rest; enforces minOut.
    function _trade(PublicSwap calldata pub, Kind kind, uint16 bps) private returns (uint256 out) {
        pool.tradeTake(pub.assetIn, pub.amountIn);
        if (pub.relayerFee != 0) IERC20(pub.assetIn).safeTransfer(msg.sender, pub.relayerFee);
        out = _execute(kind, pub.assetIn, pub.assetOut, pub.amountIn - pub.relayerFee, bps);
        if (out < pub.minOut || out == 0) revert Slippage(pub.minOut, out);
        if (out > MAX_RAW) revert BadAmount();
    }

    /// Credits the output to the pool and inserts the change note and the filled v2 output note.
    function _finish(PublicSwap calldata pub, Kind kind, uint256 out, bytes calldata encChange, bytes calldata encOut)
        private
        returns (bytes32 outCommitment)
    {
        outCommitment = bytes32(Poseidon2.hash2(uint256(pub.outPartial), out));
        IERC20(pub.assetOut).forceApprove(address(pool), out);
        pool.tradeCredit(pub.assetOut, out, kind != Kind.Unpark);

        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = pub.changeCommitment;
        leaves[1] = outCommitment;
        bytes[] memory notes = new bytes[](2);
        notes[0] = encChange;
        notes[1] = encOut;
        pool.tradeInsert(leaves, notes);

        emit PartialNoteFilled(pub.outPartial, outCommitment, out);
        emit Swapped(kind, pub.assetIn, pub.assetOut, pub.amountIn - pub.relayerFee, pub.relayerFee, out, outCommitment);
    }

    /// Turns one v2 note into a v1 note of the same asset and amount (nothing is public but the nullifier and
    /// the new commitment). Never gated.
    function settle(bytes calldata proof, bytes32 root, bytes32 nullifier, bytes32 outCommitment, bytes calldata encryptedOut)
        external
        nonReentrant
    {
        _field(outCommitment);
        pool.tradeSpend(root, nullifier);
        bytes32[] memory inputs = new bytes32[](3);
        inputs[0] = root;
        inputs[1] = nullifier;
        inputs[2] = outCommitment;
        _verify(settleVerifier, proof, inputs);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = outCommitment;
        bytes[] memory notes = new bytes[](1);
        notes[0] = encryptedOut;
        pool.tradeInsert(leaves, notes);
        emit Settled(nullifier, outCommitment);
    }

    // ---------------------------------------------------------------- views

    /// The trade a pair means; reverts for any other pair.
    function kindOf(address assetIn, address assetOut) public view returns (Kind) {
        if (assetIn != assetOut && assetIn != address(0) && assetOut != address(0)) {
            if (assetIn == usdg) return address(adapterOf[assetOut]) != address(0) ? Kind.Park : Kind.Buy;
            if (assetOut == usdg) return address(adapterOf[assetIn]) != address(0) ? Kind.Unpark : Kind.Sell;
        }
        revert BadPair(assetIn, assetOut);
    }

    /// USDG value of `shares` of a park share token (adapter's convertToAssets / Morpho share price).
    function parkValue(address shareToken, uint256 shares) external view returns (uint256) {
        IParkAdapter a = adapterOf[shareToken];
        if (address(a) == address(0)) revert BadAdapter();
        return a.convertToAssets(shares);
    }

    /// v2 commitment for (outPartial, amount), as `swap` computes it.
    function commitmentV2(bytes32 outPartial, uint256 amount) external pure returns (bytes32) {
        return bytes32(Poseidon2.hash2(uint256(outPartial), amount));
    }

    // ---------------------------------------------------------------- internal

    function _checkAdapter(IParkAdapter adapter) private view returns (address share) {
        if (address(adapter) == address(0)) revert ZeroAddress();
        share = adapter.shareToken();
        if (adapter.asset() != usdg || share == address(0) || share == usdg) revert BadAdapter();
        if (router.registry().isCanonical(share)) revert BadAdapter();
        IParkAdapter existing = adapterOf[share];
        if (address(existing) != address(0) && existing != adapter) revert BadAdapter();
    }

    function _checkSwap(PublicSwap calldata pub, Kind kind) private view {
        if (block.timestamp > pub.deadline) revert Expired(pub.deadline);
        if (pub.amountIn > MAX_RAW || pub.minOut > MAX_RAW || pub.relayerFee >= pub.amountIn) revert BadAmount();
        _field(pub.changeCommitment);
        _field(pub.outPartial);
        if (kind != Kind.Unpark && pool.depositsPaused()) revert Paused();
        if (kind == Kind.Park) {
            IParkAdapter a = adapterOf[pub.assetOut];
            if (!parkEnabled[a]) revert ParkDisabled(address(a));
        }
    }

    function _swapInputs(PublicSwap calldata pub) private pure returns (bytes32[] memory inputs) {
        inputs = new bytes32[](10);
        inputs[0] = pub.root;
        inputs[1] = pub.nullifier;
        inputs[2] = pub.changeCommitment;
        inputs[3] = bytes32(uint256(uint160(pub.assetIn)));
        inputs[4] = bytes32(pub.amountIn);
        inputs[5] = bytes32(pub.relayerFee);
        inputs[6] = bytes32(uint256(uint160(pub.assetOut)));
        inputs[7] = bytes32(pub.minOut);
        inputs[8] = pub.outPartial;
        inputs[9] = bytes32(uint256(pub.deadline));
    }

    /// Trades `net` of assetIn held here; returns assetOut received (balance delta). Leaves no balance or
    /// allowance behind: the venue must take exactly `net`.
    function _execute(Kind kind, address assetIn, address assetOut, uint256 net, uint16 bps)
        private
        returns (uint256 out)
    {
        IERC20 tin = IERC20(assetIn);
        IERC20 tout = IERC20(assetOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));
        address spender;
        if (kind == Kind.Buy || kind == Kind.Sell) {
            spender = address(router);
            tin.forceApprove(spender, net);
            if (kind == Kind.Buy) router.buy(assetOut, net, bps, address(this));
            else router.sell(assetIn, net, bps, address(this));
        } else {
            IParkAdapter a = adapterOf[kind == Kind.Park ? assetOut : assetIn];
            spender = address(a);
            tin.forceApprove(spender, net);
            if (kind == Kind.Park) a.park(net, address(this));
            else a.unpark(net, address(this));
        }
        tin.forceApprove(spender, 0);
        uint256 used = inBefore - tin.balanceOf(address(this));
        if (used != net) revert InputNotConsumed(net - used);
        out = tout.balanceOf(address(this)) - outBefore;
    }

    function _field(bytes32 x) private pure {
        if (uint256(x) >= P) revert NotAFieldElement();
    }

    function _verify(IHonkVerifier v, bytes calldata proof, bytes32[] memory inputs) private view {
        bool ok;
        try v.verify(proof, inputs) returns (bool r) {
            ok = r;
        } catch {
            ok = false;
        }
        if (!ok) revert InvalidProof();
    }
}
