// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {ShieldedTradeBase} from "./ShieldedTradeBase.sol";
import {ExpectVerifier} from "./ShieldedPoolBase.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

/// Private sell / buy through the ShieldedPool on a real (etched) Uniswap v4 PoolManager.
contract ShieldedTradeTest is ShieldedTradeBase {
    // ------------------------------------------------------------ round trip

    function test_privateSellBuyRoundTrip_onLocalV4Pool() public {
        _note(address(stock), 10e18); // 10 mTSLA at $250
        uint256 leaves = pool.nextLeaf();

        // Sell 4 mTSLA for >= 990 USDG.
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 990 * U);
        (uint256 usdgOut, bytes32 c) = _swap(s);
        assertGe(usdgOut, 990 * U);
        assertLe(usdgOut, 1000 * U);
        assertEq(c, bytes32(Poseidon2.hash2(uint256(s.outPartial), usdgOut)), "v2 commitment = H(partial, amount)");
        assertEq(trade.commitmentV2(s.outPartial, usdgOut), c);
        assertTrue(pool.nullifierSpent(s.nullifier));
        assertEq(pool.nextLeaf(), leaves + 2, "change + output inserted");
        assertEq(pool.shielded(address(stock)), 6e18);
        assertEq(pool.shielded(address(usdg)), usdgOut);
        _assertBacked(_two(address(usdg), address(stock)));

        // Buy back with the whole (unsettled, v2) USDG note.
        ShieldedTrade.PublicSwap memory b = _pub(address(usdg), usdgOut, 0, address(stock), 3.9e18);
        (uint256 stockOut,) = _swap(b);
        assertGe(stockOut, 3.9e18);
        assertLt(stockOut, 4e18, "round trip pays two pool fees");
        assertEq(pool.shielded(address(usdg)), 0);
        assertEq(pool.shielded(address(stock)), 6e18 + stockOut);
        assertEq(pool.nextLeaf(), leaves + 4);
        _assertBacked(_two(address(usdg), address(stock)));
    }

    function test_swapEmitsPartialFillAndKind() public {
        _note(address(stock), 1e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        uint256 expectOut = _quoteSell(1e18);
        bytes32 c = bytes32(Poseidon2.hash2(uint256(s.outPartial), expectOut));
        vm.expectEmit(address(trade));
        emit ShieldedTrade.PartialNoteFilled(s.outPartial, c, expectOut);
        vm.expectEmit(address(trade));
        emit ShieldedTrade.Swapped(ShieldedTrade.Kind.Sell, address(stock), address(usdg), 1e18, 0, expectOut, c);
        _swap(s);
        assertEq(uint8(trade.kindOf(address(stock), address(usdg))), uint8(ShieldedTrade.Kind.Sell));
        assertEq(uint8(trade.kindOf(address(usdg), address(stock))), uint8(ShieldedTrade.Kind.Buy));
    }

    function test_relayerFeePaidInAssetInToSubmitter() public {
        _note(address(stock), 2e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 2e18, 0.01e18, address(usdg), 0);
        (uint256 out,) = _swap(s);
        assertEq(stock.balanceOf(relayer), 0.01e18);
        assertEq(pool.shielded(address(stock)), 0);
        assertGt(out, 490 * U); // 1.99 mTSLA sold
        _assertBacked(_two(address(usdg), address(stock)));
    }

    // ------------------------------------------------------------ reverts leave the note unspent

    function test_slippageRevertLeavesNoteUnspent() public {
        _note(address(stock), 4e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 1000 * U); // above any fill
        bytes32 rootBefore = pool.currentRoot();
        uint256 leavesBefore = pool.nextLeaf();
        vm.prank(relayer);
        vm.expectRevert();
        trade.swap("", s, BPS, "", "");
        assertFalse(pool.nullifierSpent(s.nullifier), "note stays unspent");
        assertEq(pool.currentRoot(), rootBefore);
        assertEq(pool.nextLeaf(), leavesBefore);
        assertEq(pool.shielded(address(stock)), 4e18);
        _assertBacked(_two(address(usdg), address(stock)));

        // The same note (same nullifier) can then be sold with a sane minimum.
        s.minOut = 980 * U;
        _swap(s);
        assertTrue(pool.nullifierSpent(s.nullifier));
    }

    function test_proofMinOutChecked_exactRevertSelector() public {
        _note(address(stock), 4e18);
        // Oracle minimum (1% slippage) passes, but the proof asks for more than the pool pays.
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 999 * U);
        uint256 fill = _quoteSell(4e18);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.Slippage.selector, 999 * U, fill));
        trade.swap("", s, BPS, "", "");
    }

    function _quoteSell(uint256 raw) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        stock.mint(address(this), raw);
        stock.approve(address(router), raw);
        out = router.sell(address(stock), raw, BPS, address(this));
        vm.revertToState(snap);
    }

    function test_oracleGuardRevertLeavesNoteUnspent() public {
        _note(address(stock), 4e18);
        feed.set(300e8); // oracle +20%, pool still at $250: StockRouter's oracle minimum cannot be met
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 0);
        vm.prank(relayer);
        vm.expectRevert();
        trade.swap("", s, BPS, "", "");
        assertFalse(pool.nullifierSpent(s.nullifier));
    }

    function test_marketHoldRevertsAndLeavesNoteUnspent() public {
        _note(address(stock), 4e18);
        vm.warp(block.timestamp + 2 days); // feed stale -> hold
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 0);
        s.deadline = uint64(block.timestamp + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.MarketOnHold.selector, address(stock)));
        trade.swap("", s, BPS, "", "");
        assertFalse(pool.nullifierSpent(s.nullifier));
    }

    function test_expiredDeadlineReverts() public {
        _note(address(stock), 1e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        vm.warp(s.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.Expired.selector, s.deadline));
        trade.swap("", s, BPS, "", "");
    }

    function test_invalidProofRevertsAndLeavesNoteUnspent() public {
        _note(address(stock), 1e18);
        sv.set(false, false);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        vm.expectRevert(ShieldedTrade.InvalidProof.selector);
        trade.swap("", s, BPS, "", "");
        sv.set(true, true); // verifier reverts -> also InvalidProof
        vm.expectRevert(ShieldedTrade.InvalidProof.selector);
        trade.swap("", s, BPS, "", "");
        assertFalse(pool.nullifierSpent(s.nullifier));
    }

    function test_doubleSpendRejected() public {
        _note(address(stock), 2e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        _swap(s);
        s.root = pool.currentRoot();
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, s.nullifier));
        trade.swap("", s, BPS, "", "");
    }

    function test_unknownRootRejected() public {
        _note(address(stock), 1e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        s.root = bytes32(uint256(123));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, s.root));
        trade.swap("", s, BPS, "", "");
    }

    /// M-5 (external audit 2026-10): 101 newer roots (busy honest transfers) do not expire the root a swap or a
    /// settle was proven against; tradeSpend inherits the pool's "every published root" rule.
    function test_M5_inFlightSwapAndSettleSurviveRootChurn() public {
        _note(address(stock), 2e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        bytes32 old = s.root;
        uint256 seq = pool.rootSeq(old);
        for (uint256 i; i < 101; ++i) {
            ShieldedPool.PublicTransfer memory t;
            t.root = pool.currentRoot();
            t.nullifiers = [bytes32(5000 + i * 2), bytes32(5001 + i * 2)];
            t.outCommitments = [bytes32(7000 + i * 2), bytes32(7001 + i * 2)];
            t.asset = address(stock);
            bytes[2] memory e;
            pool.transfer("", t, e);
        }
        assertGt(pool.rootCount() - seq, 100);
        _swap(s);
        assertTrue(pool.nullifierSpent(s.nullifier));
        vm.prank(relayer);
        trade.settle("", old, bytes32(uint256(31337)), bytes32(uint256(31338)), "");
        assertTrue(pool.nullifierSpent(bytes32(uint256(31337))));
    }

    function test_badPairsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.BadPair.selector, address(stock), address(stock)));
        trade.kindOf(address(stock), address(stock));
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.BadPair.selector, address(usdg), address(usdg)));
        trade.kindOf(address(usdg), address(usdg));
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.BadPair.selector, address(stock), other));
        trade.kindOf(address(stock), other);
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.BadPair.selector, address(0), address(usdg)));
        trade.kindOf(address(0), address(usdg));
    }

    function test_nonCanonicalStockCannotBeBought() public {
        _note(address(usdg), 1000 * U);
        ShieldedTrade.PublicSwap memory s = _pub(address(usdg), 1000 * U, 0, address(new MockStockToken("x", "x")), 0);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.NotCanonical.selector, s.assetOut));
        trade.swap("", s, BPS, "", "");
    }

    function test_amountChecks() public {
        _note(address(stock), 1e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 1e18, address(usdg), 0);
        vm.expectRevert(ShieldedTrade.BadAmount.selector); // fee leaves nothing to trade
        trade.swap("", s, BPS, "", "");
        s.relayerFee = 0;
        s.amountIn = uint256(type(uint128).max) + 1;
        vm.expectRevert(ShieldedTrade.BadAmount.selector);
        trade.swap("", s, BPS, "", "");
        s.amountIn = 1e18;
        s.outPartial = bytes32(P);
        vm.expectRevert(ShieldedTrade.NotAFieldElement.selector);
        trade.swap("", s, BPS, "", "");
    }

    /// The module hands the verifier exactly the circuit's public-input order.
    function test_publicInputsInCircuitOrder() public {
        ExpectVerifier ev = new ExpectVerifier();
        ShieldedPool p2 = new ShieldedPool(tv, wv, owner, 48 hours);
        ShieldedTrade t2 = new ShieldedTrade(p2, ev, stv, router, owner, 48 hours);
        vm.prank(owner);
        p2.setTrade(address(t2));
        vm.prank(owner);
        p2.proposeCap(address(stock), 1e30);
        vm.prank(owner);
        p2.proposeCap(address(usdg), 1e30);
        vm.warp(block.timestamp + 48 hours);
        p2.applyCap(address(stock));
        p2.applyCap(address(usdg));
        _refreshFeed();
        vm.prank(alice);
        stock.approve(address(p2), type(uint256).max);
        vm.prank(alice);
        p2.deposit(address(stock), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.warp(block.timestamp + 2 hours); // MIN_PENDING_DELAY + SOLO_INSERT_DELAY: a lone deposit
        p2.insertPending(1);
        _refreshFeed();

        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 5, address(usdg), 7);
        s.root = p2.currentRoot();
        bytes32[] memory inputs = new bytes32[](11);
        inputs[0] = s.root;
        inputs[1] = s.nullifier;
        inputs[2] = s.changeCommitment;
        inputs[3] = bytes32(uint256(uint160(address(stock))));
        inputs[4] = bytes32(uint256(1e18));
        inputs[5] = bytes32(uint256(5));
        inputs[6] = bytes32(uint256(uint160(address(usdg))));
        inputs[7] = bytes32(uint256(7));
        inputs[8] = s.outPartial;
        inputs[9] = bytes32(uint256(s.deadline));
        // ext_hash; fee 5 != 0, so it binds the submitter (this test contract), audit L-9
        inputs[10] = bytes32(uint256(keccak256(abi.encode(bytes(""), bytes(""), address(this)))) % Poseidon2.P);
        ev.expect_(inputs);
        t2.swap("", s, BPS, "", "");
        assertTrue(p2.nullifierSpent(s.nullifier));

        // Any other vector is rejected.
        ShieldedTrade.PublicSwap memory s2 = _pub(address(stock), 1e18, 5, address(usdg), 7);
        s2.root = p2.currentRoot();
        vm.expectRevert(ShieldedTrade.InvalidProof.selector);
        t2.swap("", s2, BPS, "", "");
    }

    /// L-9 (external audit 2026-10): a swap's relayer fee goes to the address bound in the ext hash. A copier who
    /// lands the same calldata first fails verification; the note stays unspent for the real relayer.
    function test_L9_swapRelayerFeeBoundToSubmitter() public {
        ExpectVerifier ev = new ExpectVerifier();
        ShieldedPool p2 = new ShieldedPool(tv, wv, owner, 48 hours);
        ShieldedTrade t2 = new ShieldedTrade(p2, ev, stv, router, owner, 48 hours);
        vm.prank(owner);
        p2.setTrade(address(t2));
        vm.prank(owner);
        p2.proposeCap(address(stock), 1e30);
        vm.prank(owner);
        p2.proposeCap(address(usdg), 1e30);
        vm.warp(block.timestamp + 48 hours);
        p2.applyCap(address(stock));
        p2.applyCap(address(usdg));
        vm.prank(alice);
        stock.approve(address(p2), type(uint256).max);
        vm.prank(alice);
        p2.deposit(address(stock), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.warp(block.timestamp + 2 hours);
        p2.insertPending(1);
        _refreshFeed();

        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0.01e18, address(usdg), 0);
        s.root = p2.currentRoot();
        bytes memory encC = hex"aa";
        bytes memory encO = hex"bbbb";
        bytes32[] memory inputs = new bytes32[](11);
        inputs[0] = s.root;
        inputs[1] = s.nullifier;
        inputs[2] = s.changeCommitment;
        inputs[3] = bytes32(uint256(uint160(address(stock))));
        inputs[4] = bytes32(uint256(1e18));
        inputs[5] = bytes32(uint256(0.01e18));
        inputs[6] = bytes32(uint256(uint160(address(usdg))));
        inputs[7] = bytes32(0);
        inputs[8] = s.outPartial;
        inputs[9] = bytes32(uint256(s.deadline));
        inputs[10] = bytes32(uint256(keccak256(abi.encode(encC, encO, relayer))) % Poseidon2.P); // relayer bound
        ev.expect_(inputs);

        address copier = makeAddr("copier");
        vm.prank(copier);
        vm.expectRevert(ShieldedTrade.InvalidProof.selector);
        t2.swap("", s, BPS, encC, encO);
        assertFalse(p2.nullifierSpent(s.nullifier));
        vm.prank(relayer);
        t2.swap("", s, BPS, encC, encO);
        assertEq(stock.balanceOf(relayer), 0.01e18);
        assertEq(stock.balanceOf(copier), 0);
    }

    // ------------------------------------------------------------ caps, pause, hooks

    function test_outputCountsAgainstCap() public {
        _note(address(stock), 4e18);
        vm.prank(owner);
        pool.proposeCap(address(usdg), 500 * U); // lowering applies at once
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 0);
        vm.expectRevert(); // CapExceeded from the pool
        trade.swap("", s, BPS, "", "");
        assertFalse(pool.nullifierSpent(s.nullifier));
    }

    function test_pausedDepositsBlockBuyAndSell() public {
        _note(address(stock), 1e18);
        vm.prank(owner);
        pool.setDepositsPaused(true);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 1e18, 0, address(usdg), 0);
        vm.expectRevert(ShieldedTrade.Paused.selector);
        trade.swap("", s, BPS, "", "");
    }

    function test_settleInsertsV1NoteAndIsNeverGated() public {
        _note(address(stock), 1e18);
        (, bytes32 out) = _swap(_pub(address(stock), 1e18, 0, address(usdg), 0));
        out;
        vm.prank(owner);
        pool.setDepositsPaused(true);
        bytes32 root = pool.currentRoot();
        bytes32 n = bytes32(uint256(777));
        bytes32 v1 = bytes32(uint256(888));
        uint256 leaves = pool.nextLeaf();
        vm.prank(relayer);
        trade.settle("", root, n, v1, "");
        assertTrue(pool.nullifierSpent(n));
        assertEq(pool.nextLeaf(), leaves + 1);
        root = pool.currentRoot();
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, n));
        trade.settle("", root, n, bytes32(uint256(889)), "");
        stv.set(false, false);
        vm.expectRevert(ShieldedTrade.InvalidProof.selector);
        trade.settle("", root, bytes32(uint256(1)), v1, "");
        vm.expectRevert(ShieldedTrade.NotAFieldElement.selector);
        trade.settle("", root, bytes32(uint256(1)), bytes32(P), "");
    }

    function test_poolHooksOnlyForTrade() public {
        bytes32[] memory l = new bytes32[](1);
        bytes[] memory n = new bytes[](1);
        bytes32 root = pool.currentRoot();
        vm.startPrank(alice);
        vm.expectRevert(ShieldedPool.NotTrade.selector);
        pool.tradeSpend(root, bytes32(uint256(1)));
        vm.expectRevert(ShieldedPool.NotTrade.selector);
        pool.tradeTake(address(usdg), 1);
        vm.expectRevert(ShieldedPool.NotTrade.selector);
        pool.tradeCredit(address(usdg), 1, true);
        vm.expectRevert(ShieldedPool.NotTrade.selector);
        pool.tradeInsert(l, n);
        vm.stopPrank();
    }

    function test_setTradeOnceAndOnlyBeforeDeposits() public {
        vm.prank(owner);
        vm.expectRevert(ShieldedPool.AlreadySet.selector);
        pool.setTrade(address(1));

        ShieldedPool p2 = new ShieldedPool(tv, wv, owner, 48 hours);
        vm.prank(alice);
        vm.expectRevert(); // not owner
        p2.setTrade(address(trade));
        vm.prank(owner);
        p2.proposeCap(address(usdg), 1e12);
        vm.warp(block.timestamp + 48 hours);
        p2.applyCap(address(usdg));
        vm.prank(alice);
        usdg.approve(address(p2), 1);
        vm.prank(alice);
        p2.deposit(address(usdg), 1, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.prank(owner);
        vm.expectRevert(ShieldedPool.TooLate.selector);
        p2.setTrade(address(trade));
    }

    // ------------------------------------------------------------ Stock Token multiplier

    /// A uiMultiplier change between proving and execution changes oracle values, never raw note amounts.
    function test_multiplierChangeMidFlightKeepsRawAmounts() public {
        _note(address(stock), 10e18);
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), 4e18, 0, address(usdg), 980 * U);
        // Mid-flight: a 0.5% dividend adjustment. The oracle minimum moves 0.5% (still inside 1% slippage).
        stock.setUiMultiplier(1.005e18);
        (uint256 out,) = _swap(s);
        assertEq(pool.shielded(address(stock)), 6e18, "exactly the proven raw amount left the notes");
        assertEq(stock.balanceOf(address(pool)), 6e18);
        // A 2:1 split after the fill: raw balances and notes stay as they are.
        bytes32 root = pool.currentRoot();
        stock.setUiMultiplier(2e18);
        assertEq(pool.shielded(address(stock)), 6e18);
        assertEq(pool.shielded(address(usdg)), out);
        assertEq(pool.currentRoot(), root);
        (uint256 usd,) = valuer.value(address(stock), 6e18);
        assertEq(usd, 6 * 500e18, "value doubles, raw does not");

        // A 2x multiplier mid-flight on the next sell: the oracle now wants ~2x the USDG, the pool cannot pay,
        // so the swap reverts and the note stays unspent with its raw amount.
        ShieldedTrade.PublicSwap memory s2 = _pub(address(stock), 2e18, 0, address(usdg), 0);
        vm.expectRevert();
        trade.swap("", s2, BPS, "", "");
        assertFalse(pool.nullifierSpent(s2.nullifier));
        assertEq(pool.shielded(address(stock)), 6e18);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_sellKeepsPoolBacked(uint256 raw, uint256 feeBps) public {
        raw = bound(raw, 1e12, 10e18);
        feeBps = bound(feeBps, 0, 100);
        _note(address(stock), 20e18);
        uint256 fee = raw * feeBps / 10_000;
        if (fee >= raw) fee = 0;
        ShieldedTrade.PublicSwap memory s = _pub(address(stock), raw, fee, address(usdg), 0);
        (uint256 out, bytes32 c) = _swap(s);
        assertEq(pool.shielded(address(stock)), 20e18 - raw);
        assertEq(pool.shielded(address(usdg)), out);
        assertEq(c, bytes32(Poseidon2.hash2(uint256(s.outPartial), out)));
        assertEq(stock.balanceOf(relayer), fee);
        _assertBacked(_two(address(usdg), address(stock)));
    }
}
