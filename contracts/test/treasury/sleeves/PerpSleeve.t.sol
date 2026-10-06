// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryFixture} from "../TreasuryFixture.sol";
import {TreasuryPolicy} from "../../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../../src/treasury/PolicyGuard.sol";
import {PositionMirror} from "../../../src/treasury/PositionMirror.sol";
import {PerpSleeve} from "../../../src/treasury/sleeves/PerpSleeve.sol";
import {InHousePerpVenue} from "../../../src/treasury/sleeves/InHousePerpVenue.sol";
import {MirroredPerpVenue} from "../../../src/treasury/sleeves/MirroredPerpVenue.sol";
import {IPerpVenue} from "../../../src/interfaces/IPerpVenue.sol";
import {PerpPool} from "../../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../../src/perps/PerpMarket.sol";

/// The treasury fixture ($1M NAV: 600k USDG cash, 2,000 AAPL at $200) plus a hedge desk on a PerpSleeve (cash
/// band) with two venues: the in-house AAPL perp (10M USDG of LP liquidity, 10 bps taker fee, no funding or
/// borrow) and an off-chain venue mirrored by the controller. The T2 policy is activated through the timelock:
/// net delta 10%..45% of NAV, leverage <= 3x, each venue <= 20% of NAV, both venues allowed.
contract PerpSleeveTest is TreasuryFixture {
    bytes32 constant HEDGE_DESK = "hedge";
    uint256 constant CTRL_PK = 0xC0417; // test-key
    uint256 constant ONE = 1e30; // market: cash units x ONE / price = token units (6dp cash, 18dp token)

    address ctrl;
    address hedgeKey = makeAddr("hedgeKey");
    address custody = makeAddr("orderlyVault");
    address lp = makeAddr("lp");

    PerpPool pool;
    PerpMarket market;
    PositionMirror mirror;
    PerpSleeve perp;
    InHousePerpVenue inHouse;
    MirroredPerpVenue offVenue;
    bytes32 leafIn;
    bytes32 leafOff;

    function setUp() public override {
        super.setUp();
        ctrl = vm.addr(CTRL_PK);

        pool = new PerpPool(usdg, address(this));
        market = new PerpMarket(pool, valuer, address(aapl), address(this));
        pool.addMarket(address(market));
        market.setParams(10, 0, 1000, 0, 0, 2_000, 10_000, 5e6);
        usdg.mint(lp, 10_000_000e6);
        vm.startPrank(lp);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e6, lp);
        vm.stopPrank();

        mirror = new PositionMirror(policy);
        perp = new PerpSleeve(address(account), usdg, 0);
        PerpMarket[] memory ms = new PerpMarket[](1);
        ms[0] = market;
        inHouse = new InHousePerpVenue(address(perp), pool, ms);
        offVenue = new MirroredPerpVenue(address(perp), usdg, mirror, custody);
        leafIn = keccak256(abi.encode(address(inHouse)));
        leafOff = keccak256(abi.encode(address(offVenue)));

        vm.startPrank(board);
        perp.addVenue(inHouse);
        perp.addVenue(offVenue);
        account.registerDesk(HEDGE_DESK, hedgeKey, _one(address(perp)));
        vm.stopPrank();
    }

    function _t2() internal view returns (TreasuryPolicy.Policy memory p) {
        p = _policy();
        p.cash = TreasuryPolicy.Band(4000, 8000);
        p.equity = TreasuryPolicy.Band(2000, 6000);
        p.netDeltaMinBps = 1000;
        p.netDeltaMaxBps = 4500;
        p.maxLeverageX10 = 30;
        p.perOrderCapUsd = 500_000;
        p.perDayCapUsd = 2_000_000;
        p.perVenueCapBps = 2000;
        p.approvalAboveUsd = 1_000_000;
        p.venueAllowRoot = Hashes.commutativeKeccak256(leafIn, leafOff);
        p.controller = ctrl;
    }

    function _activateT2() internal {
        vm.prank(board);
        policy.propose(_t2());
        _warp(block.timestamp + 48 hours);
        policy.activate();
    }

    // ------------------------------------------------------------ helpers

    function _op(uint8 op, uint256 idx, bytes memory args, uint256 pull) internal view returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls;
        if (pull != 0) {
            pulls = new TreasuryAccount.Pull[](1);
            pulls[0] = TreasuryAccount.Pull(address(usdg), pull);
        }
        return abi.encode(pulls, abi.encode(op, idx, args));
    }

    /// Packed venue proof (two-leaf tree: the sibling).
    function _vp(address venue) internal view returns (bytes32[] memory out) {
        out = new bytes32[](2);
        out[0] = bytes32(uint256(1));
        out[1] = venue == address(inHouse) ? leafOff : leafIn;
    }

    function _hedge(bytes memory data, bytes32[] memory proof) internal {
        vm.prank(hedgeKey);
        account.execute(HEDGE_DESK, address(perp), data, proof, 0);
    }

    function _depositTo(uint256 idx, uint256 amount) internal {
        address v = idx == 0 ? address(inHouse) : address(offVenue);
        _hedge(_op(0, idx, abi.encode(amount), amount), _vp(v));
    }

    function _short(uint256 sizeUsd, uint256 collateral) internal {
        _hedge(
            _op(2, 0, abi.encode(address(aapl), false, sizeUsd, collateral, uint256(100)), 0),
            _vp(address(inHouse))
        );
    }

    function _withdraw(uint256 idx, uint256 amount) internal {
        _hedge(_op(1, idx, abi.encode(amount), 0), _allow(address(usdg)));
    }

    function _post(IPerpVenue.Position[] memory pos, uint256 equityUsd, uint256 seen, uint64 ts, uint256 pk)
        internal
    {
        bytes32 d = mirror.digestOf(address(offVenue), pos, equityUsd, seen, ts);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        mirror.post(address(offVenue), pos, equityUsd, seen, ts, abi.encodePacked(r, s, v));
    }

    function _noPos() internal pure returns (IPerpVenue.Position[] memory) {
        return new IPerpVenue.Position[](0);
    }

    // ------------------------------------------------------------ policy / wiring

    function test_t1PolicyAllowsNoVenueRisk() public {
        _expectCode(guard.R6_VENUE_NOT_ALLOWED());
        _depositTo(0, 10_000e6);
    }

    function test_accountTracksPositionSleeve() public view {
        address[] memory ps = account.positionSleeves();
        assertEq(ps.length, 1);
        assertEq(ps[0], address(perp));
        assertEq(perp.venues().length, 2);
    }

    function test_positionSleeveOfAnotherAccountRejected() public {
        PerpSleeve other = new PerpSleeve(makeAddr("otherAccount"), usdg, 0);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.BadSleeve.selector, address(other)));
        account.registerDesk("x", hedgeKey, _one(address(other)));
    }

    function test_sleeveAccessControl() public {
        vm.expectRevert(PerpSleeve.NotAccount.selector);
        perp.run(abi.encode(uint8(0), uint256(0), abi.encode(uint256(1))));
        vm.expectRevert(PerpSleeve.NotBoard.selector);
        perp.addVenue(inHouse);
        PerpSleeve other = new PerpSleeve(address(account), usdg, 0);
        MirroredPerpVenue foreign = new MirroredPerpVenue(address(other), usdg, mirror, custody);
        vm.prank(board);
        vm.expectRevert(PerpSleeve.BadVenue.selector);
        perp.addVenue(foreign); // belongs to another sleeve
        vm.expectRevert(InHousePerpVenue.NotSleeve.selector);
        inHouse.depositMargin(1);
        vm.expectRevert(PerpSleeve.BadBand.selector);
        new PerpSleeve(address(account), usdg, 1);
    }

    // ------------------------------------------------------------ rule 5: net delta, leverage

    function test_rule5_hedgeInsideBandsPasses() public {
        _activateT2();
        _depositTo(0, 100_000e6);
        _short(250_000e6, 50_000e6);
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        assertEq(s.perpDeltaUsd, -250_000e18);
        assertEq(s.venues[0].gross, 250_000e18);
        assertEq(s.venues[0].equity, (100_000e6 - 250e6) * 1e12); // minus the 10 bps fee
        assertEq(s.stockUsd, 400_000e18);
    }

    function test_rule5_guardRejectsOverDelta() public {
        _activateT2();
        _depositTo(0, 150_000e6);
        // 400k spot - 350k short = 5% of NAV < 10%.
        _expectCode(guard.R5_NET_DELTA());
        _short(350_000e6, 70_000e6);
    }

    function test_rule5_spotBuyAboveDeltaBandRejectedUnlessHedged() public {
        _activateT2();
        _expectCode(guard.R5_NET_DELTA());
        _buy(address(aapl), 60_000e6); // delta 46% > 45%
        _depositTo(0, 50_000e6);
        _short(100_000e6, 20_000e6);
        _buy(address(aapl), 60_000e6); // delta 36%
    }

    function test_rule5_guardRejectsOverLeverage() public {
        _activateT2();
        _depositTo(0, 50_000e6);
        _expectCode(guard.R5_LEVERAGE());
        _short(160_000e6, 20_000e6); // 3.2x of venue equity
        _short(140_000e6, 20_000e6); // 2.8x
    }

    function test_rule5_withdrawThatRaisesLeverageOverCapRejected() public {
        _activateT2();
        _depositTo(0, 100_000e6);
        _short(200_000e6, 20_000e6);
        _expectCode(guard.R5_LEVERAGE());
        _withdraw(0, 50_000e6); // venue equity ~50k for 200k gross: 4x
        _withdraw(0, 20_000e6); // 2.5x
    }

    /// Rule 7 (todo 29 fix): off-hours a pure perp reduction passes although its spread lifts the equity weight;
    /// new perp size off-hours is still refused.
    /// Rule 7 lets a pure perp reduction through off-hours, but the in-house market charges the hold spread
    /// (the largest plausible gap) on a stale exit, a NAV loss the guard's op-loss bound refuses: the desk
    /// reduces at the next fresh price.
    function test_rule7_offHoursPerpReduceWaitsForReopen() public {
        _activateT2();
        _depositTo(0, 100_000e6);
        _short(100_000e6, 20_000e6);
        vm.warp(block.timestamp + 2 days); // feeds stale: off-hours
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        _hedge(_op(3, 0, abi.encode(address(aapl), uint256(50_000e6)), 0), new bytes32[](0));
        vm.expectRevert(); // the market itself refuses new size on a held feed
        _short(10_000e6, 0);
        _warp(block.timestamp);
        _hedge(_op(3, 0, abi.encode(address(aapl), uint256(50_000e6)), 0), new bytes32[](0));
        assertEq(guard.snapshot(address(account)).venues[0].gross > 0, true);
    }

    // ------------------------------------------------------------ rule 6: allow-list, cap, staleness

    function test_rule6_venueCap() public {
        _activateT2();
        _expectCode(guard.R6_VENUE_CAP());
        _depositTo(0, 250_000e6); // 25% of NAV at one venue
        _depositTo(0, 200_000e6); // 20%
    }

    function test_rule6_venueNotInAllowList() public {
        _activateT2();
        PerpMarket[] memory ms = new PerpMarket[](1);
        ms[0] = market;
        InHousePerpVenue extra = new InHousePerpVenue(address(perp), pool, ms);
        vm.prank(board);
        perp.addVenue(extra);
        _expectCode(guard.R6_VENUE_NOT_ALLOWED());
        _hedge(_op(0, 2, abi.encode(uint256(1_000e6)), 1_000e6), _vp(address(inHouse)));
    }

    function test_venueListChangeMidOpIsUnknownChange() public {
        _activateT2();
        // Snapshot before, then the board adds a venue: a stale before-snapshot no longer matches.
        PolicyGuard.Snapshot memory before = guard.snapshot(address(account));
        PerpMarket[] memory ms = new PerpMarket[](0);
        InHousePerpVenue extra = new InHousePerpVenue(address(perp), pool, ms);
        vm.prank(board);
        perp.addVenue(extra);
        vm.prank(address(account));
        assertEq(guard.check(address(account), bytes32(0), before, new bytes32[](0), 0), guard.R6_UNKNOWN_CHANGE());
    }

    function test_staleMirrorBlocksNewRiskButAllowsReduce() public {
        _activateT2();
        // No snapshot yet: stale.
        _expectCode(guard.R6_STALE_VENUE());
        _depositTo(1, 50_000e6);

        _post(_noPos(), 0, 0, uint64(block.timestamp), CTRL_PK);
        _depositTo(1, 50_000e6);
        assertEq(usdg.balanceOf(custody), 50_000e6);
        (uint256 eq, bool stale) = offVenue.equityOf();
        assertEq(eq, 50_000e18); // unseen deposit counts until the next snapshot
        assertFalse(stale);

        _warp(block.timestamp + 10 minutes + 1);
        assertTrue(mirror.isStale(address(offVenue)));
        _expectCode(guard.R6_STALE_VENUE());
        _depositTo(1, 10_000e6);

        // The venue sends 20k back (an off-chain withdrawal landed); sweeping it to the account is a reduction.
        vm.prank(custody);
        IERC20(address(usdg)).transfer(address(offVenue), 20_000e6);
        uint256 before = usdg.balanceOf(address(account));
        _withdraw(1, 20_000e6);
        assertEq(usdg.balanceOf(address(account)), before + 20_000e6);

        // A fresh snapshot (a 500-token AAPL short, seen deposits) re-enables new risk.
        IPerpVenue.Position[] memory pos = new IPerpVenue.Position[](1);
        pos[0] = IPerpVenue.Position(address(aapl), -500e18);
        _post(pos, 30_000e18, 50_000e6, uint64(block.timestamp), CTRL_PK);
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        assertEq(s.perpDeltaUsd, -100_000e18);
        assertEq(s.venues[1].equity, 30_000e18);
        assertFalse(s.venues[1].stale);
        _depositTo(1, 10_000e6);
    }

    function test_offChainVenueCannotTradeOnChain() public {
        _activateT2();
        _post(_noPos(), 0, 0, uint64(block.timestamp), CTRL_PK);
        vm.prank(hedgeKey);
        vm.expectRevert(MirroredPerpVenue.OffChainVenue.selector);
        account.execute(
            HEDGE_DESK,
            address(perp),
            _op(2, 1, abi.encode(address(aapl), false, uint256(1e6), uint256(1e6), uint256(100)), 0),
            _vp(address(offVenue)),
            0
        );
    }

    // ------------------------------------------------------------ rule 8 still applies to perps

    function test_rule8_pausedBlocksNewPerpExposure() public {
        _activateT2();
        _depositTo(0, 100_000e6);
        periodClose.set(_nav() * 105 / 100); // -4.76% <= -4%
        _expectCode(guard.R8_PAUSED());
        _short(100_000e6, 20_000e6);
    }

    // ------------------------------------------------------------ mirror

    function test_mirror_onlyControllerSignature() public {
        bytes32 d = mirror.digestOf(address(offVenue), _noPos(), 1, 0, uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, d); // test-key
        vm.expectRevert(PositionMirror.BadSignature.selector);
        mirror.post(address(offVenue), _noPos(), 1, 0, uint64(block.timestamp), abi.encodePacked(r, s, v));
        // The fixture's T1 controller is `controller`; after T2 activation the controller is ctrl.
        _activateT2();
        _post(_noPos(), 1, 0, uint64(block.timestamp), CTRL_PK);
        (,,, uint64 ts) = mirror.latest(address(offVenue));
        assertEq(ts, block.timestamp);
    }

    function test_mirror_timestampRules() public {
        _activateT2();
        uint64 t = uint64(block.timestamp);
        bytes32 d = mirror.digestOf(address(offVenue), _noPos(), 0, 0, t + 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CTRL_PK, d);
        vm.expectRevert(abi.encodeWithSelector(PositionMirror.BadTimestamp.selector, t + 1));
        mirror.post(address(offVenue), _noPos(), 0, 0, t + 1, abi.encodePacked(r, s, v)); // future

        _post(_noPos(), 0, 0, t, CTRL_PK);
        d = mirror.digestOf(address(offVenue), _noPos(), 0, 0, t);
        (v, r, s) = vm.sign(CTRL_PK, d);
        vm.expectRevert(abi.encodeWithSelector(PositionMirror.BadTimestamp.selector, t));
        mirror.post(address(offVenue), _noPos(), 0, 0, t, abi.encodePacked(r, s, v)); // replay

        vm.warp(t + 20 minutes);
        uint64 old = t + 5 minutes;
        d = mirror.digestOf(address(offVenue), _noPos(), 0, 0, old);
        (v, r, s) = vm.sign(CTRL_PK, d);
        vm.expectRevert(abi.encodeWithSelector(PositionMirror.BadTimestamp.selector, old));
        mirror.post(address(offVenue), _noPos(), 0, 0, old, abi.encodePacked(r, s, v)); // stale on arrival
    }

    function test_mirror_positionCap() public {
        _activateT2();
        IPerpVenue.Position[] memory pos = new IPerpVenue.Position[](33);
        bytes memory sig = new bytes(65);
        vm.expectRevert(PositionMirror.TooManyPositions.selector);
        mirror.post(address(offVenue), pos, 0, 0, uint64(block.timestamp), sig);
    }

    // ------------------------------------------------------------ NAV with in-house perps

    /// NAV (guard snapshot and account.navUsd) equals the PnL model of a short: idle margin + collateral - open
    /// fee + size - tokens x newPrice (tokens rounded up against the trader), plus the spot book at newPrice.
    function testFuzz_navWithInHousePerpsMatchesPnlModel(uint256 size, uint256 newPrice8) public {
        size = bound(size, 1_000e6, 200_000e6);
        newPrice8 = bound(newPrice8, 160e8, 220e8); // keeps net delta inside 10%..45%
        _activateT2();
        _depositTo(0, size / 2);
        _short(size, size / 4);
        uint256 tokens = (size * ONE + 200e18 - 1) / 200e18;
        assertEq(market.position(address(inHouse)).tokens, tokens);

        aaplFeed.set(int256(newPrice8));
        (uint256 expected, uint256 venueRaw, uint256 fee) = _model(size, tokens, newPrice8 * 1e10);

        assertEq(_nav(), expected);
        (uint256 accountNav,) = account.navUsd();
        assertEq(accountNav, expected);
        (uint256 perpValue,) = perp.valueOf(address(account));
        assertEq(perpValue, venueRaw * 1e12);
        (uint256 shortUsd,) = valuer.value(address(aapl), tokens);
        assertEq(guard.snapshot(address(account)).perpDeltaUsd, -int256(shortUsd));

        // Closing realizes exactly that equity minus the close fee.
        _hedge(_op(3, 0, abi.encode(address(aapl), size), 0), new bytes32[](0));
        assertEq(market.position(address(inHouse)).size, 0);
        assertEq(_nav(), expected - fee * 1e12);
        assertEq(usdg.balanceOf(address(inHouse)), venueRaw - fee);
    }

    /// deposit = size/2, collateral = size/4, 10 bps fee rounded up, no funding or borrow.
    function _model(uint256 size, uint256 tokens, uint256 p2)
        internal
        view
        returns (uint256 expected, uint256 venueRaw, uint256 fee)
    {
        uint256 deposit = size / 2;
        uint256 coll = size / 4;
        fee = (size * 10 + 9_999) / 10_000;
        uint256 buyBack = (tokens * p2 + ONE - 1) / ONE;
        venueRaw = (deposit - coll) + (coll - fee) + size - buyBack;
        (uint256 spot,) = valuer.value(address(aapl), SEED_AAPL);
        expected = (FUNDING - deposit) * 1e12 + spot + venueRaw * 1e12;
    }

    function test_netDeltaOk_matchesModel() public view {
        assertTrue(guard.netDeltaOk(1000, 4500, 0.4e18, 0.3e18));
        assertFalse(guard.netDeltaOk(1000, 4500, 0.4e18, 0.05e18)); // crossed below
        assertTrue(guard.netDeltaOk(1000, 4500, 0.02e18, 0.05e18)); // below, moving up
        assertFalse(guard.netDeltaOk(1000, 4500, 0.5e18, 0.5e18)); // above, not moving
        assertTrue(guard.netDeltaOk(-2000, 0, -0.1e18, -0.1e18));
        assertFalse(guard.netDeltaOk(-2000, 0, -0.1e18, -0.3e18));
    }

    function testFuzz_netDeltaOk(int16 lo, int16 hi, int64 wB, int64 wA) public view {
        vm.assume(lo <= hi);
        int256 l = int256(lo) * 1e14;
        int256 h = int256(hi) * 1e14;
        bool want = wA < l ? wB < wA : (wA > h ? wB > wA : true);
        assertEq(guard.netDeltaOk(lo, hi, wB, wA), want);
    }
}
