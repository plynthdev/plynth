// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PLTH} from "../../src/token/PLTH.sol";

contract PLTHTest is Test {
    address worker = makeAddr("worker");
    address treasury = makeAddr("treasury");
    address reserve = makeAddr("reserve");
    bytes32 constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    function test_supplyFixedAndAllocated() public {
        PLTH t = new PLTH(worker, treasury, reserve);
        uint256 s = t.INITIAL_SUPPLY();
        assertEq(s, 1_000_000_000e18);
        assertEq(t.balanceOf(worker), s * 80 / 100);
        assertEq(t.balanceOf(treasury), s * 10 / 100);
        assertEq(t.balanceOf(reserve), s * 5 / 100);
        assertEq(t.totalSupply(), s * 95 / 100);
        assertEq(t.balanceOf(address(t)), 0);
        assertEq(t.name(), "Plinth");
        assertEq(t.symbol(), "PLTH");
        assertEq(t.decimals(), 18);
    }

    function test_burnExecutedAtDeploy() public {
        vm.recordLogs();
        PLTH t = new PLTH(worker, treasury, reserve);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 burn = t.INITIAL_SUPPLY() * 5 / 100;
        bool minted;
        bool burned;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TRANSFER) continue;
            address from = address(uint160(uint256(logs[i].topics[1])));
            address to = address(uint160(uint256(logs[i].topics[2])));
            uint256 v = abi.decode(logs[i].data, (uint256));
            if (from == address(0) && to == address(t) && v == burn) minted = true;
            if (from == address(t) && to == address(0) && v == burn) burned = minted;
        }
        assertTrue(burned, "mint-then-burn of 5% visible on-chain");
    }

    function test_noMintAfterConstruction() public {
        PLTH t = new PLTH(worker, treasury, reserve);
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", worker, 1));
        assertFalse(ok);
        (ok,) = address(t).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "no owner");
        assertEq(t.totalSupply(), t.INITIAL_SUPPLY() * 95 / 100);
    }

    function test_zeroRecipientReverts() public {
        vm.expectRevert(PLTH.ZeroAddress.selector);
        new PLTH(address(0), treasury, reserve);
        vm.expectRevert(PLTH.ZeroAddress.selector);
        new PLTH(worker, address(0), reserve);
        vm.expectRevert(PLTH.ZeroAddress.selector);
        new PLTH(worker, treasury, address(0));
    }

    function test_votesAndPermit() public {
        PLTH t = new PLTH(worker, treasury, reserve);
        vm.prank(worker);
        t.delegate(worker);
        assertEq(t.getVotes(worker), t.balanceOf(worker));

        uint256 ownerKey = 0xA11CE; // test-key
        address o = vm.addr(ownerKey);
        vm.prank(worker);
        t.transfer(o, 1e18);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                o,
                address(this),
                1e18,
                0,
                block.timestamp
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
        t.permit(o, address(this), 1e18, block.timestamp, v, r, s);
        assertEq(t.allowance(o, address(this)), 1e18);
    }
}
