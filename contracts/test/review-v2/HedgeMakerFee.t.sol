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
/// perp markets charge a 40 bps open spread, 10 bps taker and 6 bps maker. The venue is valued at exit, so an open
/// loses fee in + spread + fee out: 60 bps of size as a taker, 52 as a registered maker. The market's round-trip floor
/// (spread + 2 x fee above the feeds' 50 bps deviation) means no fee fits under 50, so an in-house venue's opens and
/// closes have their own bound, read live from its markets: spread + 2 x fee + 10 bps headroom, capped at 100 bps.
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

    function _short(uint256 margin, uint256 size, uint256 maxSlippageBps) internal {
        _hedge(_op(2, abi.encode(address(aapl), false, size, margin, maxSlippageBps), 0));
    }

    function test_venueBoundIsReadFromTheMarket() public {
        assertEq(guard.venueLossBps(address(inHouse)), 40 + 2 * 10 + 10, "taker: 70 bps");
        pool.setMaker(address(inHouse), true); // OWNER, the registrar
        assertEq(guard.venueLossBps(address(inHouse)), 40 + 2 * 6 + 10, "maker: 62 bps");
        assertEq(guard.venueLossBps(address(perp)), 0, "not an in-house venue");
    }

    function test_takerHedgeAt3xPasses() public {
        assertEq(market.feeBpsFor(address(inHouse)), 10);
        _depositAndShort(80_000e6, 230_000e6); // ~2.9x of its own margin, inside the policy's 3x
        assertEq(market.position(address(inHouse)).size, 230_000e6);
        assertEq(guard.snapshot(address(account)).perpDeltaUsd, -int256(uint256(230_000e18)));
    }

    function test_makerHedgeAt3xPassesAndCloses() public {
        pool.setMaker(address(inHouse), true);
        assertEq(market.feeBpsFor(address(inHouse)), 6);
        _depositAndShort(80_000e6, 230_000e6);
        assertEq(market.position(address(inHouse)).size, 230_000e6);
        _warp(block.timestamp + 1 hours); // past the minimum hold
        _hedge(_op(3, abi.encode(address(aapl), uint256(230_000e6)), 0)); // close
        assertEq(market.position(address(inHouse)).size, 0);
    }

    /// A venue op that costs more than its computed bound is refused: an owner-raised spread (300 bps, the market's
    /// maximum) makes the bound 300 + 2 x 10 + 10 = 330 bps, capped at 100; the open would lose about 320.
    function test_spreadAboveTheCapIsRefused() public {
        PerpMarketHarness(address(market)).setGuardsUnchecked(300, market.minHoldSeconds(), market.minCollateral());
        assertEq(guard.venueLossBps(address(inHouse)), 100);
        _hedge(_op(0, abi.encode(uint256(80_000e6)), 80_000e6));
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        _short(80_000e6, 230_000e6, 1_000);
    }

    /// The rest of an operation keeps 50 bps: the venue bound covers only the gross the venue moved.
    function test_otherOperationsKeepThe50BpsBound() public view {
        assertEq(guard.maxOpLossBps(), 50);
        assertEq(guard.venueLossBps(address(offVenue)), 0);
    }
}
