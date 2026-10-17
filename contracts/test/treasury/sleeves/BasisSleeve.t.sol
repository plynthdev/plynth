// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryFixture} from "../TreasuryFixture.sol";
import {TreasuryPolicy} from "../../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../../src/treasury/PolicyGuard.sol";
import {PositionMirror} from "../../../src/treasury/PositionMirror.sol";
import {BasisSleeve} from "../../../src/treasury/sleeves/BasisSleeve.sol";
import {InHousePerpVenue} from "../../../src/treasury/sleeves/InHousePerpVenue.sol";
import {MirroredPerpVenue} from "../../../src/treasury/sleeves/MirroredPerpVenue.sol";
import {IPerpVenue} from "../../../src/interfaces/IPerpVenue.sol";
import {PerpPool} from "../../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../../src/perps/PerpMarket.sol";
import {PerpMarketHarness} from "../../perps/PerpMarketHarness.sol";
import {MockStockToken} from "../../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../../src/testnet/MockFeed.sol";

/// The treasury fixture ($1M NAV: 600k USDG, 2,000 AAPL at $200) plus a basis desk on a BasisSleeve (basis band)
/// with the in-house perp engine as its venue: AAPL and a thin THIN market (supply 10,000 tokens), 10M USDG of
/// LP liquidity, 10 bps taker fee, skew funding on, no borrow. A crowd trader moves funding by taking sides.
/// T2 policy: basis band 0..20%, net delta 10..45%, leverage <= 3x, each venue <= 20% of NAV, float cap 1%.
contract BasisSleeveTest is TreasuryFixture {
    bytes32 constant BASIS_DESK = "basis";

    address basisKey = makeAddr("basisKey");
    address crowd = makeAddr("crowd");
    address crowd2 = makeAddr("crowd2");
    address lp = makeAddr("lp");

    MockStockToken thin;
    MockFeed thinFeed;
    PerpPool pool;
    PerpMarket market;
    PerpMarket thinMarket;
    BasisSleeve basis;
    InHousePerpVenue venue;

    function setUp() public override {
        super.setUp();
        thin = new MockStockToken("THIN", "THIN");
        thinFeed = new MockFeed(8, 100e8, "THIN / USD");
        registry.list(address(thin), address(thinFeed), true);
        thin.mint(address(this), 10_000e18);

        pool = new PerpPool(usdg, address(this), 24 hours, 48 hours);
        // Guards off (open spread, minimum hold): these tests check treasury math against exact fee numbers;
        // the guards are tested in test/perps (and with the treasury in test_productionGuards_*).
        market = new PerpMarketHarness(pool, valuer, address(aapl), address(this));
        PerpMarketHarness(address(market)).guardsOff();
        thinMarket = new PerpMarketHarness(pool, valuer, address(thin), address(this));
        PerpMarketHarness(address(thinMarket)).guardsOff();
        pool.addMarket(address(market));
        pool.addMarket(address(thinMarket));
        market.setParams(10, 0, 1000, 0, 1e13, 2_000, 10_000, 5e6);
        thinMarket.setParams(10, 0, 1000, 0, 1e12, 2_000, 10_000, 5e6);
        usdg.mint(lp, 10_000_000e6);
        vm.startPrank(lp);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e6, lp);
        vm.stopPrank();
        usdg.mint(crowd, 5_000_000e6);
        vm.prank(crowd);
        usdg.approve(address(pool), type(uint256).max);
        usdg.mint(crowd2, 1_000_000e6);
        vm.prank(crowd2);
        usdg.approve(address(pool), type(uint256).max);

        basis = new BasisSleeve(address(account), usdg, valuer);
        PerpMarket[] memory ms = new PerpMarket[](2);
        ms[0] = market;
        ms[1] = thinMarket;
        venue = new InHousePerpVenue(address(basis), pool, ms);

        vm.startPrank(board);
        basis.addVenue(venue);
        account.registerDesk(BASIS_DESK, basisKey, _one(address(basis)));
        vm.stopPrank();
        _activateT2();
    }

    function _t2() internal view returns (TreasuryPolicy.Policy memory p) {
        p = _policy();
        p.cash = TreasuryPolicy.Band(4000, 8000);
        p.equity = TreasuryPolicy.Band(2000, 6000);
        p.basis = TreasuryPolicy.Band(0, 2000);
        p.netDeltaMinBps = 1000;
        p.netDeltaMaxBps = 4500;
        p.maxLeverageX10 = 30;
        p.perOrderCapUsd = 500_000;
        p.perDayCapUsd = 5_000_000;
        p.perVenueCapBps = 2000;
        p.approvalAboveUsd = 1_000_000;
        p.venueAllowRoot = keccak256(abi.encode(address(venue)));
    }

    function _activateT2() internal {
        vm.prank(board);
        policy.propose(_t2());
        _warp(block.timestamp + 48 hours);
        thinFeed.setUpdatedAt(block.timestamp);
        policy.activate();
    }

    function _warpAll(uint256 t) internal {
        _warp(t);
        thinFeed.setUpdatedAt(t);
    }

    // ------------------------------------------------------------ helpers

    function _data(uint8 op, uint256 idx, bytes memory args, uint256 pull) internal view returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls;
        if (pull != 0) {
            pulls = new TreasuryAccount.Pull[](1);
            pulls[0] = TreasuryAccount.Pull(address(usdg), pull);
        }
        return abi.encode(pulls, abi.encode(op, idx, args));
    }

    /// Single-leaf venue tree: an empty proof, packed as [len 0].
    function _vp() internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
    }

    function _exec(bytes memory data, bytes32[] memory proof) internal {
        vm.prank(basisKey);
        account.execute(BASIS_DESK, address(basis), data, proof, 0);
    }

    function _openPair(address u, uint256 sizeUsd, uint256 collateral) internal {
        _exec(_data(0, 0, abi.encode(u, sizeUsd, collateral, uint256(100)), collateral), _vp());
    }

    function _closePair(uint256 id) internal {
        _exec(_data(1, id, "", 0), _allow(address(usdg)));
    }

    /// The crowd takes one side of AAPL: a big long makes longs pay shorts (our short receives).
    function _crowd(bool isLong, uint256 sizeUsd) internal {
        vm.startPrank(crowd);
        PerpMarket.Position memory p = market.position(crowd);
        if (p.size != 0) market.close();
        market.open(isLong, sizeUsd, sizeUsd / 5, 100);
        vm.stopPrank();
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    // ------------------------------------------------------------ lifecycle

    /// Funding positive for hours -> open; carry accrues while it stays positive; the crowd flips -> close.
    function test_lifecycle_openAccrueFlipClose() public {
        vm.prank(crowd2);
        market.open(true, 100_000e6, 20_000e6, 100); // a small long that stays: both sides stay open
        _crowd(true, 1_000_000e6);

        uint256 navBefore = _nav();
        _openPair(address(aapl), 100_000e6, 50_000e6);
        (uint256 rate, bool longsPay) = market.fundingRate();
        assertTrue(longsPay && rate > 0, "longs pay");
        assertEq(basis.pairCount(), 1);
        BasisSleeve.Pair memory p = basis.pair(0);
        assertEq(p.underlying, address(aapl));
        assertEq(p.spotRaw, 500e18); // $100k at $200
        assertEq(p.perpTokens, p.spotRaw);
        assertEq(p.entryMultiplier, 1e18);
        assertEq(p.entryPriceUsd, 200e18);
        assertEq(p.collateral, 50_000e6);
        assertEq(basis.pairedRaw(address(aapl)), 500e18);
        assertEq(basis.pairDelta(0), 0, "delta neutral at open");
        // NAV drops only by the 10 bps open fee and the 10 bps exit fee the venue valuation nets out.
        assertApproxEqAbs(_nav(), navBefore - 200e18, 1e12);
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        assertApproxEqAbs(s.basisUsd, 50_000e18 - 200e18, 1e12);

        // 8 hours of positive funding, price moves 10% up: the pair stays neutral, carry is positive.
        _warpAll(block.timestamp + 8 hours);
        aaplFeed.set(220e8);
        assertEq(basis.pairDelta(0), 0, "still neutral after the move");
        int256 carry8h = basis.pairCarry(0);
        assertGt(carry8h, 0, "receiving funding");

        // The crowd flips short: shorts pay now. Close the pair.
        _crowd(false, 600_000e6);
        (, longsPay) = market.fundingRate();
        assertFalse(longsPay, "flipped");
        _warpAll(block.timestamp + 1 hours);
        uint256 usdgBefore = usdg.balanceOf(address(account));
        _closePair(0);
        p = basis.pair(0);
        assertEq(p.closedAt, block.timestamp);
        assertEq(basis.pairedRaw(address(aapl)), 0);
        assertEq(basis.pairDelta(0), 0);
        // All margin plus carry is back on the account; carry net of fees and the hour of adverse funding.
        assertGt(usdg.balanceOf(address(account)), usdgBefore);
        assertEq(basis.pairCarry(0), p.cumulativeFundingUsd);
        assertLt(p.cumulativeFundingUsd, carry8h + 1, "an hour paying, plus the close fee, came off");
        assertEq(venue.positionOf().length, 0);
        assertEq(usdg.balanceOf(address(venue)), 0, "nothing idle left at the venue");
        // Spot stays with the account (the equity desk owns it).
        assertEq(aapl.balanceOf(address(account)), SEED_AAPL);
    }

    function test_lifecycle_reopenAfterClose() public {
        _crowd(true, 1_000_000e6);
        _openPair(address(aapl), 100_000e6, 50_000e6);
        _closePair(0);
        _openPair(address(aapl), 100_000e6, 50_000e6);
        assertEq(basis.pairCount(), 2);
        assertEq(basis.openPairOf(0, address(aapl)), 2);
    }

    function test_addMarginRaisesCollateral() public {
        _openPair(address(aapl), 100_000e6, 40_000e6);
        _exec(_data(2, 0, abi.encode(uint256(10_000e6)), 10_000e6), _vp());
        assertEq(basis.pair(0).collateral, 50_000e6);
        assertEq(market.position(address(venue)).collateral, 50_000e6 - 100e6);
    }

    /// Off-hours the market's exit costs the hold spread (the largest plausible gap), a NAV loss the guard
    /// refuses; the pair closes at the next fresh price instead.
    function test_closeOffHoursWaitsForReopen() public {
        _openPair(address(aapl), 100_000e6, 50_000e6);
        vm.warp(block.timestamp + 2 days); // feeds stale: off-hours
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        _closePair(0);
        _warp(block.timestamp); // feeds fresh again
        _closePair(0);
        assertGt(basis.pair(0).closedAt, 0);
    }

    function test_openOffHoursRejected() public {
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(); // the market refuses new size on a held feed
        _openPair(address(aapl), 100_000e6, 50_000e6);
    }

    // ------------------------------------------------------------ caps

    function test_floatCap_pairedSpotAboveCapRejected() public {
        // THIN: supply 10,000, cap 1% = 100 tokens. The account holds 300.
        thin.transfer(address(account), 300e18);
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.FloatCapExceeded.selector, address(thin), 150e18, 100e18));
        _openPair(address(thin), 15_000e6, 10_000e6);
        _openPair(address(thin), 9_000e6, 6_000e6); // 90 tokens: inside the cap
        assertEq(basis.pairedRaw(address(thin)), 90e18);
    }

    function test_perVenueCap_notionalAboveCapRejected() public {
        aapl.mint(address(account), 1_000e18);
        usdg.mint(address(account), 300_000e6);
        // NAV $1.5M (cash 60%, equity 40%) -> cap 20% = $300k of pair notional at the venue.
        uint256 nav = _nav();
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.VenueCapExceeded.selector, 0, 320_000e18, nav * 2000 / 10_000 - 640e18 * 2000 / 10_000));
        _openPair(address(aapl), 320_000e6, 120_000e6);
        _openPair(address(aapl), 250_000e6, 100_000e6);
        (uint256 notional, uint256 navNow) = basis.venueNotional(0);
        assertLe(notional, navNow * 2000 / 10_000);
        assertApproxEqRel(navNow, nav, 1e15);
    }

    // ------------------------------------------------------------ red team: no short-spot path

    function test_redTeam_noNakedShort_spotMustBeHeld() public {
        // The account holds 2,000 AAPL; a 2,500-token short would be 500 tokens naked.
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.SpotNotHeld.selector, address(aapl), 2_000e18, 2_500e18));
        _openPair(address(aapl), 500_000e6, 250_000e6);
    }

    function test_redTeam_spotClaimedOnceAcrossPairs() public {
        // The account's 2,000 AAPL back one pair of 500; THIN has none: no pair can be opened on it.
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.SpotNotHeld.selector, address(thin), 0, 50e18));
        _openPair(address(thin), 5_000e6, 5_000e6);
        _openPair(address(aapl), 100_000e6, 50_000e6);
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.PairExists.selector, 0));
        _openPair(address(aapl), 100_000e6, 50_000e6);
    }

    function test_redTeam_noLongPerpAndNoStockTransferOps() public {
        // Only ops 0..2 exist and none takes a side or a token to send.
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.UnknownOp.selector, uint8(3)));
        _exec(_data(3, 0, abi.encode(address(aapl), true, uint256(1e6), uint256(1e6), uint256(100)), 0), _vp());
        (address[] memory a,) = basis.assets();
        assertEq(a.length, 0, "declares no ERC-20 assets: it can never move spot");
    }

    function test_redTeam_sellingClaimedSpotShowsAsNegativeDelta() public {
        _openPair(address(aapl), 100_000e6, 50_000e6);
        // 1,800 of the 2,000 leave the account: only 200 of the pair's 500 remain.
        vm.prank(board);
        account.withdrawToBoard(address(aapl), 1_800e18);
        int256 d = basis.pairDelta(0);
        assertEq(d, -60_000e18); // 300 tokens short uncovered at $200
    }

    function test_accessControl() public {
        vm.expectRevert(BasisSleeve.NotAccount.selector);
        basis.run(abi.encode(uint8(0), uint256(0), ""));
        vm.expectRevert(BasisSleeve.NotBoard.selector);
        basis.addVenue(venue);
        assertEq(basis.band(), 2);
        assertTrue(basis.isPositionSleeve());
        address[] memory ps = account.positionSleeves();
        assertEq(ps[ps.length - 1], address(basis));
    }

    function test_closeTwiceRejected() public {
        _openPair(address(aapl), 100_000e6, 50_000e6);
        _closePair(0);
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.PairClosedAlready.selector, 0));
        _closePair(0);
        vm.expectRevert(abi.encodeWithSelector(BasisSleeve.UnknownPair.selector, 9));
        _closePair(9);
    }

    // ------------------------------------------------------------ fuzz

    /// For any size and price move, an open pair's delta is exactly 0 while the spot is held, and closing
    /// returns margin + carry + price PnL to the account (carry recorded = cash back - margin - price PnL).
    function testFuzz_pairDeltaZeroAndCarryIdentity(uint256 size, uint256 newPrice8, uint256 hrs) public {
        size = bound(size, 20_000e6, 150_000e6); // the light side receives heavy/light x the rate: keep it under the cap
        newPrice8 = bound(newPrice8, 150e8, 215e8); // above ~$220 the unhedged rest of the book pushes delta over 45% on close
        hrs = bound(hrs, 0, 12);
        _crowd(true, 200_000e6); // funding stays far below the 100% profit cap (a capped receipt is forfeited)
        _openPair(address(aapl), size, size / 2);
        _warpAll(block.timestamp + hrs * 1 hours);
        aaplFeed.set(int256(newPrice8));
        assertEq(basis.pairDelta(0), 0);
        int256 carryOpen = basis.pairCarry(0);
        uint256 bal0 = usdg.balanceOf(address(account));
        _closePair(0);
        BasisSleeve.Pair memory p = basis.pair(0);
        uint256 cashBack = usdg.balanceOf(address(account)) - bal0;
        (uint256 exitUsd,) = valuer.value(address(aapl), p.perpTokens);
        PerpMarket.Position memory none = market.position(address(venue));
        assertEq(none.size, 0);
        int256 pricePnl = int256(size * 1e12) - int256(exitUsd);
        assertEq(p.cumulativeFundingUsd, int256(cashBack * 1e12) - int256(p.collateral * 1e12) - pricePnl);
        // Closing costs the 10 bps fee (rounding aside) relative to the open mark.
        // (the fee is on the exit notional, so it moves with the price: +-35% of the entry fee)
        assertApproxEqAbs(p.cumulativeFundingUsd, carryOpen - int256(size * 1e12 / 1000), size * 1e12 * 35 / 100_000 + 2e12);
    }
}
