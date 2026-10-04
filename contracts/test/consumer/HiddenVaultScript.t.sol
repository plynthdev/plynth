// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HiddenVault} from "../../script/HiddenVault.s.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";

/// Deploy-script rule: mainnet caps stay 0; elsewhere caps are only proposed (48h timelock).
contract HiddenVaultScriptTest is Test {
    HiddenVault script;
    address asset = makeAddr("usdg");
    address crowd = makeAddr("crowd");

    function setUp() public {
        script = new HiddenVault();
    }

    function _one(uint256 c) internal view returns (address[] memory a, uint256[] memory caps) {
        a = new address[](1);
        caps = new uint256[](1);
        a[0] = asset;
        caps[0] = c;
    }

    function test_mainnetDeployLeavesCapsZero() public {
        vm.chainId(4663);
        (address[] memory a, uint256[] memory c) = _one(0);
        ShieldedPool pool = script.deploy(address(script), crowd, a, c);
        assertEq(pool.cap(asset), 0);
        (, uint64 eta) = pool.capProposal(asset);
        assertEq(eta, 0);
        assertEq(pool.crowd(), crowd);
        assertEq(pool.owner(), address(script));
    }

    function test_mainnetDeployRefusesNonZeroCap() public {
        vm.chainId(4663);
        (address[] memory a, uint256[] memory c) = _one(1);
        vm.expectRevert(abi.encodeWithSelector(HiddenVault.MainnetCapMustBeZero.selector, asset, 1));
        script.deploy(address(script), crowd, a, c);
    }

    function test_testnetDeployOnlyProposesCaps() public {
        vm.chainId(46630);
        (address[] memory a, uint256[] memory c) = _one(1e12);
        ShieldedPool pool = script.deploy(address(script), address(0), a, c);
        assertEq(pool.cap(asset), 0); // not live until the timelock passes
        (uint256 cap, uint64 eta) = pool.capProposal(asset);
        assertEq(cap, 1e12);
        assertEq(eta, block.timestamp + 48 hours);
        vm.warp(eta);
        pool.applyCap(asset);
        assertEq(pool.cap(asset), 1e12);
    }

    function test_lengthMismatchRejected() public {
        vm.expectRevert(HiddenVault.LengthMismatch.selector);
        script.deploy(address(script), crowd, new address[](1), new uint256[](0));
    }
}
