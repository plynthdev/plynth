// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {TreasuryFixture} from "../treasury/TreasuryFixture.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PerpSleeve} from "../../src/treasury/sleeves/PerpSleeve.sol";
import {InHousePerpVenue} from "../../src/treasury/sleeves/InHousePerpVenue.sol";
import {MirroredPerpVenue} from "../../src/treasury/sleeves/MirroredPerpVenue.sol";
import {PositionMirror} from "../../src/treasury/PositionMirror.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {PerpMarketHarness} from "../perps/PerpMarketHarness.sol";

/// v2 mainnet values: the treasury guard allows 50 bps of NAV loss per operation (GUARD_MAX_OP_LOSS_BPS) and the
/// perp markets charge a 40 bps open spread, 10 bps taker and 6 bps maker. The venue's equity is its exit value, so an
/// open loses fee in + spread + fee out of size: 60 bps as a taker, 52 bps as a registered maker (MainnetBeta makes
/// OWNER the maker registrar; OWNER registers the treasury's InHousePerpVenue). Both are above the 50 bps bound, and
/// the market's own round-trip floor (spread + 2 x cheaper fee > the feeds' 50 bps deviation) means no fee setting can
/// bring it under: these tests pin that conflict until it is decided (raise the bound for venue operations, or value
/// a venue without its exit fee).
contract HedgeMakerFeeTest is TreasuryFixture {
    bytes32 constant HEDGE_DESK = "hedge";
    address hedgeKey = makeAddr("hedgeKey");
    address lp = makeAddr("lp");
    PerpPool pool;
    PerpMarket market;
    PerpSleeve perp;
    InHousePerpVenue inHouse;
    MirroredPerpVenue offVenue;
    bytes32 leafIn;
    bytes32 leafOff;

    function setUp() public override {
        guardLossBps = 50; // MainnetBeta.GUARD_MAX_OP_LOSS_BPS
        super.setUp();
        pool = new PerpPool(usdg, address(this), 24 hours, 48 hours);
        market = new PerpMarketHarness(pool, valuer, address(aapl), address(this));
        pool.addMarket(address(market));
        pool.setMakerRegistrar(address(this)); // as MainnetBeta: before any LP share, so instant
        pool.openDeposits();
        // MainnetBeta's perps values: taker 10, maker 6, spread 40 (minimum hold and collateral as deployed).
        PerpMarketHarness(address(market)).paramsUnchecked(PerpMarket.Params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6));
        PerpMarket fresh = new PerpMarket(pool, valuer, address(aapl), address(this));
        PerpMarketHarness(address(market)).setGuardsUnchecked(40, fresh.minHoldSeconds(), fresh.minCollateral());
        usdg.mint(lp, 10_000_000e6);
        vm.startPrank(lp);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e6, lp);
        vm.stopPrank();

        perp = new PerpSleeve(address(account), usdg, 0);
        PerpMarket[] memory ms = new PerpMarket[](1);
        ms[0] = market;
        inHouse = new InHousePerpVenue(address(perp), pool, ms);
        offVenue = new MirroredPerpVenue(address(perp), usdg, new PositionMirror(policy), makeAddr("custody"));
        leafIn = keccak256(abi.encode(address(inHouse)));
        leafOff = keccak256(abi.encode(address(offVenue)));
        vm.startPrank(board);
        perp.addVenue(inHouse);
        account.registerDesk(HEDGE_DESK, hedgeKey, _one(address(perp)));
        TreasuryPolicy.Policy memory p = _policy();
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
        p.controller = makeAddr("ctrl");
        policy.propose(p);
        vm.stopPrank();
        _warp(block.timestamp + 48 hours);
        policy.activate();
    }

    function _op(uint8 op, bytes memory args, uint256 pull) internal view returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls;
        if (pull != 0) {
            pulls = new TreasuryAccount.Pull[](1);
            pulls[0] = TreasuryAccount.Pull(address(usdg), pull);
        }
        return abi.encode(pulls, abi.encode(op, uint256(0), args));
    }

    function _vp() internal view returns (bytes32[] memory out) {
        out = new bytes32[](2);
        out[0] = bytes32(uint256(1));
        out[1] = leafOff;
    }

    function _hedge(bytes memory data) internal {
        vm.prank(hedgeKey);
        account.execute(HEDGE_DESK, address(perp), data, _vp(), 0);
    }

    function _depositAndShort(uint256 margin, uint256 size) internal {
        _hedge(_op(0, abi.encode(margin), margin));
        _hedge(_op(2, abi.encode(address(aapl), false, size, margin, uint256(100)), 0));
    }

    function test_takerHedgeAt3xIsRefusedByThe50BpsGuard() public {
        assertEq(market.feeBpsFor(address(inHouse)), 10);
        _hedge(_op(0, abi.encode(uint256(80_000e6)), 80_000e6));
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        _hedge(_op(2, abi.encode(address(aapl), false, uint256(240_000e6), uint256(80_000e6), uint256(100)), 0));
    }

    function test_makerHedgeCosts52BpsOfSizeStillAboveThe50BpsGuard() public {
        pool.setMaker(address(inHouse), true); // OWNER, the registrar
        assertEq(market.feeBpsFor(address(inHouse)), 6);
        assertEq(market.openSpreadBps() + 2 * market.makerFeeBps(), 52, "open loss in bps of size (exit-value equity)");
        assertGt(market.openSpreadBps() + 2 * market.makerFeeBps(), guard.maxOpLossBps());
        _hedge(_op(0, abi.encode(uint256(80_000e6)), 80_000e6));
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        _hedge(_op(2, abi.encode(address(aapl), false, uint256(240_000e6), uint256(80_000e6), uint256(100)), 0));
    }

    /// The floor and the bound cannot both hold: any maker fee the market accepts (spread + 2 x fee above the 50 bps
    /// deviation) makes a hedge open lose more than 50 bps of size.
    function test_roundTripFloorAndGuardBoundConflict() public view {
        uint256 dev = market.FEED_DEVIATION_BPS();
        uint256 spread = market.openSpreadBps();
        uint256 minFee = (dev - spread) / 2 + 1; // least fee the floor allows at this spread
        assertGt(spread + 2 * minFee, guard.maxOpLossBps());
    }
}
