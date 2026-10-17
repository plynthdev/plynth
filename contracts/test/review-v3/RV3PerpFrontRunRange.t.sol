// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RV3PerpMainnet} from "./RV3PerpMainnet.sol";

/// Review v3, M-3 (strengthens review-v2/PerpDustRegression::test_V2L2_makerFrontRunLoses, which used only
/// exactly-50-bps updates). Real PerpMarket + PerpPool + Valuer at the MainnetBeta values: open spread 40, taker 10,
/// maker 6, minimum hold 30 min, borrow 1 bps/h, OI cap 20%.
///
/// The front-run: open 150,000 USDG of size (15,000 collateral) at the round the trader knows is about to be replaced,
/// the new round lands, sit out the 30 min minimum hold (a profit is only paid after it), close. With a single
/// position open funding is 0, so the cost of the round trip is exact:
///   taker: spread 40 + fee 10 in + fee 10 out + borrow 0.5 (30 min x 1 bps/h) = 60.5 bps of size
///   maker: spread 40 + fee  6 in + fee  6 out + borrow 0.5                    = 52.5 bps of size
/// and the gain is the update itself, so net = (update - cost) x size, to the unit.
///
/// Every update up to and including the feeds' 50 bps deviation threshold loses, for maker and taker, up and down.
/// An update ABOVE the round trip (taker > 60.5 bps, maker > 52.5 bps) is profitable: that is the documented design
/// limit of synchronous oracle fills (R3-PERP-2, Info). Chainlink publishes at the 50 bps deviation threshold, so in
/// normal operation a single update never jumps more than ~50 bps; only a gap (an open auction, a resumption after a
/// halt, a fast move between two rounds) does. The boundary is asserted below, not hidden.
contract RV3PerpFrontRunRangeTest is RV3PerpMainnet {
    uint256 internal constant SIZE = 150_000e6;
    uint256 internal constant COLL = 15_000e6;

    address internal taker;
    address internal maker;

    function setUp() public override {
        super.setUp();
        taker = _trader("taker");
        maker = _trader("desk"); // a treasury desk: pays the maker fee
        vm.prank(owner); // the maker registrar MainnetBeta sets (OWNER)
        pool.setMaker(maker, true);
        assertEq(market.feeBpsFor(maker), 6);
        assertEq(market.feeBpsFor(taker), 10);
    }

    /// Front-run one update of `bps` (up for a long, down for a short), closing `waitHold` ? after the minimum hold :
    /// right after the update. Returns the trader's net and the LP equity change; each case runs on a clean state.
    function _frontRun(address who, bool up, uint256 bps, bool waitHold) internal returns (int256 net, int256 lpDelta) {
        uint256 snap = vm.snapshotState();
        uint256 lp0 = pool.totalAssets();
        _open(who, up, SIZE, COLL); // long before an up-update, short before a down-update
        feed.set(up ? P0 * int256(10_000 + bps) / 10_000 : P0 * int256(10_000 - bps) / 10_000);
        if (waitHold) skip(market.minHoldSeconds());
        uint256 b = usdg.balanceOf(who);
        vm.prank(who);
        market.close();
        net = int256(usdg.balanceOf(who) - b) - int256(COLL);
        lpDelta = int256(pool.totalAssets()) - int256(lp0);
        vm.revertToState(snap);
    }

    /// The exact round-trip cost in USDG units on SIZE (fees round up; borrow over 30 min is exact here).
    function _cost(address who) internal view returns (uint256) {
        uint256 fee = market.feeBpsFor(who);
        uint256 openCost = SIZE * (market.openSpreadBps() + fee) / 10_000;
        uint256 closeFee = SIZE * fee / 10_000;
        uint256 borrow = SIZE * market.borrowBpsPerHour() * market.minHoldSeconds() / (3600 * 10_000);
        return openCost + closeFee + borrow;
    }

    function _check(address who, bool up, uint256 bps) internal returns (int256 net) {
        int256 lpDelta;
        (net, lpDelta) = _frontRun(who, up, bps, true);
        int256 expected = int256(SIZE * bps / 10_000) - int256(_cost(who));
        assertEq(net, expected, "net = (update - round trip) x size, to the unit");
        assertEq(lpDelta, -net, "the LPs are the counterparty: they gain exactly what the front-runner loses");
    }

    function test_M3_roundTripCostsAreTheDocumentedOnes() public view {
        assertEq(_cost(taker), SIZE * 605 / 100_000, "taker: 60.5 bps");
        assertEq(_cost(maker), SIZE * 525 / 100_000, "maker: 52.5 bps");
        // Both above the deviation threshold: the floor setParams / setGuards enforce (V2-L2).
        assertGt(market.openSpreadBps() + 2 * market.makerFeeBps(), market.FEED_DEVIATION_BPS());
    }

    /// Every update up to just above the 50 bps deviation threshold loses, for maker and taker, in both directions,
    /// and the LPs collect exactly the loss.
    function test_M3_frontRunAnyUpdateUpToTheDeviationLoses() public {
        uint16[6] memory steps = [uint16(10), 25, 49, 50, 51, 52];
        address[2] memory who = [taker, maker];
        for (uint256 w; w < 2; w++) {
            for (uint256 i; i < steps.length; i++) {
                for (uint256 d; d < 2; d++) {
                    int256 net = _check(who[w], d == 0, steps[i]);
                    assertLt(net, 0, "front-running an update <= 52 bps loses");
                }
            }
        }
        // The worst of these for the LPs: a maker front-running a 52 bps update still loses 0.5 bps of size.
        (int256 worst,) = _frontRun(maker, true, 52, true);
        assertEq(worst, -int256(SIZE * 5 / 100_000));
    }

    /// Closing inside the minimum hold pays no profit at all: the front-runner gets back its collateral minus the
    /// open cost and the close fee, whatever the update (here up to 100 bps).
    function test_M3_closingInsideTheHoldPaysNoProfit() public {
        uint16[4] memory steps = [uint16(25), 50, 75, 100];
        for (uint256 i; i < steps.length; i++) {
            for (uint256 d; d < 2; d++) {
                (int256 net,) = _frontRun(taker, d == 0, steps[i], false);
                assertEq(net, -int256(SIZE * 60 / 10_000), "taker: -(40 + 10 + 10) bps, the update pays nothing");
                (net,) = _frontRun(maker, d == 0, steps[i], false);
                assertEq(net, -int256(SIZE * 52 / 10_000), "maker: -(40 + 6 + 6) bps");
            }
        }
    }

    /// The design limit (R3-PERP-2, Info), pinned: the guard bounds an update only up to the round trip. The exact
    /// breakeven: a taker loses at 60 bps and gains at 61; a maker loses at 52 and gains at 53. Above it the front-run
    /// pays (update - cost) x size: +592.5 USDG for a taker on a 100 bps update, the review's number.
    /// Not reachable from a single Chainlink round in normal operation (deviation threshold 50 bps); a test that fails
    /// here means the guard got weaker (or stronger) than documented.
    function test_M3_designLimit_updatesAboveTheRoundTripPay() public {
        for (uint256 d; d < 2; d++) {
            bool up = d == 0;
            assertLt(_check(taker, up, 60), 0, "taker, 60 bps: loses 0.5 bps");
            assertGt(_check(taker, up, 61), 0, "taker, 61 bps: first profitable update");
            assertLt(_check(maker, up, 52), 0, "maker, 52 bps: loses 0.5 bps");
            assertGt(_check(maker, up, 53), 0, "maker, 53 bps: first profitable update");

            int256 t75 = _check(taker, up, 75);
            int256 t100 = _check(taker, up, 100);
            int256 m75 = _check(maker, up, 75);
            int256 m100 = _check(maker, up, 100);
            assertEq(t75, 217.5e6, "taker, 75 bps: +14.5 bps of 150k");
            assertEq(t100, 592.5e6, "taker, 100 bps: +39.5 bps of 150k (R3-PERP-2)");
            assertEq(m75, 337.5e6, "maker, 75 bps: +22.5 bps of 150k");
            assertEq(m100, 712.5e6, "maker, 100 bps: +47.5 bps of 150k");
        }
        emit log_named_uint("taker breakeven update (bps x 10)", _cost(taker) * 100_000 / SIZE);
        emit log_named_uint("maker breakeven update (bps x 10)", _cost(maker) * 100_000 / SIZE);
    }
}
