// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {TestnetPoolMath} from "../../src/testnet/TestnetPoolMath.sol";
import {TestnetKit} from "../../script/TestnetKit.s.sol";
import {TestnetTokenKit} from "../../script/TestnetTokenKit.s.sol";

/// The token part of the testnet kit on a testnet fork, through the chain's real v4 PoolManager: the PLTH
/// pool's spot (read with extsload) is the seeded price, and a push buys PLTH for stakers.
/// Skips without RHC_TESTNET_RPC_URL. Nothing is broadcast.
contract TokenKitTest is Test {
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address lp = makeAddr("lp");
    MockUSDG usdg;
    TestnetTokenKit.Deployment d;

    function test_tokenKit_onTestnetFork() public {
        string memory rpc = vm.envOr("RHC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        TestnetKit.Deployment memory k = new TestnetKit().deployAs(deployer);
        usdg = k.usdg;
        d = new TestnetTokenKit().deployAs(
            deployer, usdg, TestnetTokenKit.Params(deployer, deployer, deployer, deployer)
        );

        // Supply fixed, 5% burned; the pool took its PLTH from the worker allocation.
        assertEq(d.plth.totalSupply(), 950_000_000e18);
        assertEq(d.staking.tierCount(), 4);

        // Spot from the real PoolManager's storage matches the seeded 0.05 USD per PLTH.
        bool usdgIs0 = d.key.currency0 == address(usdg);
        uint256 p = TestnetPoolMath.priceUsdPerTokenAt(d.router.spotSqrtPriceX96(), 6, 18, usdgIs0);
        assertApproxEqRel(p, 0.05e18, 1e12);
        _pushes();
    }

    function _pushes() internal {
        vm.prank(deployer);
        d.plth.transfer(alice, 10_000e18);
        vm.startPrank(alice);
        d.plth.approve(address(d.staking), 10_000e18);
        d.staking.stake(10_000e18);
        vm.stopPrank();
        assertTrue(d.staking.tierOf(alice).weeklyClose);
        vm.warp((block.timestamp / 1 hours + 1) * 1 hours);

        // 3000 mUSDG of fees, no LPs: 1500 to stakers in USDG, 200 (cap) buys PLTH, 1300 carried.
        vm.prank(deployer);
        usdg.mint(address(d.router), 3000e6);
        d.router.push();
        assertEq(d.router.buyCarry(), 1300e6);
        uint256 bought = d.staking.queued(1);
        // 200 USDG / 0.05 = 4000 PLTH, less 0.3% fee and ~0.4% price impact on ~50k a side
        assertGt(bought, 3950e18);
        assertLt(bought, 4000e18);
        vm.warp(block.timestamp + 1 hours);
        uint256[2] memory e = d.staking.earned(alice);
        assertEq(e[0], 1500e6);
        assertApproxEqAbs(e[1], bought, 1);

        // With an LP in the insurance pool, the insurance half goes there.
        vm.prank(deployer);
        usdg.mint(lp, 100e6);
        vm.startPrank(lp);
        usdg.approve(address(d.insurance), 100e6);
        d.insurance.deposit(100e6);
        vm.stopPrank();
        vm.prank(deployer);
        usdg.mint(address(d.router), 1000e6);
        d.router.push();
        assertEq(usdg.balanceOf(address(d.insurance)), 100e6 + 500e6);
    }
}
