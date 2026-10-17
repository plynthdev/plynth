// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MainnetBetaTest} from "../script/MainnetBeta.t.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Review v3 (2026-10-17) R3-ORC-2 PoC (wt-review3 R3DeployAdmin.t.sol), turned into a regression test that asserts
/// the safe behaviour: an EIP-7702-delegated EOA (code 0xef0100 || delegate) is one private key, not a Safe, so it
/// fails the mainnet "OWNER is a contract" pin unless ALLOW_EOA_OWNER is set explicitly.
contract R3DeployAdminRegressionTest is MainnetBetaTest {
    function _delegatedEoa() internal returns (address eoa) {
        (eoa,) = makeAddrAndKey("single-key-owner");
        address delegate = makeAddr("smart-account-impl");
        vm.etch(delegate, hex"00");
        vm.etch(eoa, abi.encodePacked(hex"ef0100", delegate)); // what a type-4 authorization leaves at the EOA
        assertEq(eoa.code.length, 23);
    }

    function test_R3ORC2_7702DelegatedEoaFailsTheOwnerIsAContractPin() public {
        address eoa = _delegatedEoa();
        assertFalse(script.isContractOwner(eoa));
        MainnetBeta.Config memory c = _cfg();
        c.owner = eoa;
        c.allowEoaOwner = false;
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.OwnerNotContract.selector, eoa));
        script.checkConfig(c, makeAddr("deployer"));
        c.out = _out();
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.OwnerNotContract.selector, eoa));
        script.deploy(c);
    }

    /// An explicit ALLOW_EOA_OWNER still lets a (delegated) EOA deploy, as for a plain EOA; a real contract passes.
    function test_R3ORC2_explicitAllowAndRealContracts() public {
        address eoa = _delegatedEoa();
        MainnetBeta.Config memory c = _cfg();
        c.owner = eoa;
        c.allowEoaOwner = true;
        script.checkConfig(c, makeAddr("deployer"));
        assertTrue(script.isContractOwner(owner), "the test owner has ordinary code");
        assertFalse(script.isContractOwner(makeAddr("plain-eoa")));
        address shortCode = makeAddr("ef-only");
        vm.etch(shortCode, hex"6001");
        assertTrue(script.isContractOwner(shortCode), "any other code counts as a contract");
    }
}
