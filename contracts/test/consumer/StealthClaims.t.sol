// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StealthClaims} from "../../src/consumer/StealthClaims.sol";
import {IERC5564Announcer} from "../../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../../src/interfaces/IERC6538Registry.sol";
import {MockStockERC20} from "../mocks/MockV4.sol";
import {StealthCode} from "./StealthCode.sol";

/// Unit tests: this test contract plays CrowdBuy.
contract StealthClaimsTest is Test {
    StealthClaims internal sc;
    MockStockERC20 internal tok;
    uint256 internal stealthKey = 0xA11CE; // test-key
    address internal stealth;
    address internal relayer = makeAddr("relayer");
    address internal dest = makeAddr("dest");

    function setUp() public {
        vm.etch(StealthCode.ANNOUNCER, StealthCode.ANNOUNCER_RUNTIME);
        vm.etch(StealthCode.REGISTRY, StealthCode.REGISTRY_RUNTIME);
        sc = new StealthClaims(
            address(this), IERC5564Announcer(StealthCode.ANNOUNCER), IERC6538Registry(StealthCode.REGISTRY)
        );
        tok = new MockStockERC20("TSLA", 18);
        stealth = vm.addr(stealthKey);
    }

    function _fund(address s, uint256 raw) internal {
        tok.mint(address(sc), raw);
        sc.pool(address(tok), raw);
        sc.credit(address(tok), s, raw);
    }

    function _sign(uint256 key, address to, uint256 raw, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = sc.claimDigest(address(tok), vm.addr(key), to, raw, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------- crowd-only funding

    function test_onlyCrowdPoolsAndCredits() public {
        tok.mint(address(sc), 10);
        vm.startPrank(relayer);
        vm.expectRevert(StealthClaims.NotCrowd.selector);
        sc.pool(address(tok), 10);
        vm.expectRevert(StealthClaims.NotCrowd.selector);
        sc.credit(address(tok), stealth, 10);
        vm.stopPrank();
    }

    function test_poolRequiresTokensAlreadyHere() public {
        tok.mint(address(sc), 5);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.Underfunded.selector, 5, 6));
        sc.pool(address(tok), 6);
        sc.pool(address(tok), 5);
        assertEq(sc.pooled(address(tok)), 5);
    }

    function test_creditIsBoundedByPool() public {
        tok.mint(address(sc), 10);
        sc.pool(address(tok), 10);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.PoolTooSmall.selector, 10, 11));
        sc.credit(address(tok), stealth, 11);
        sc.credit(address(tok), stealth, 4);
        sc.credit(address(tok), makeAddr("s2"), 6);
        assertEq(sc.pooled(address(tok)), 0);
        assertEq(sc.balanceOf(address(tok), stealth), 4);
        assertEq(sc.totalCredited(address(tok)), 10);
    }

    function test_creditRejectsZeroes() public {
        tok.mint(address(sc), 10);
        sc.pool(address(tok), 10);
        vm.expectRevert(StealthClaims.ZeroAddress.selector);
        sc.credit(address(tok), address(0), 1);
        vm.expectRevert(StealthClaims.ZeroAmount.selector);
        sc.credit(address(tok), stealth, 0);
    }

    // ---------------------------------------------------------------- claims

    function test_claim_relayedByAnyonePaysDestination() public {
        _fund(stealth, 100);
        bytes memory sig = _sign(stealthKey, dest, 100, 0, block.timestamp + 1 hours);
        vm.expectEmit(address(sc));
        emit StealthClaims.Claimed(address(tok), stealth, dest, 100, 0);
        vm.prank(relayer);
        sc.claim(address(tok), stealth, dest, 100, block.timestamp + 1 hours, sig);
        assertEq(tok.balanceOf(dest), 100);
        assertEq(sc.balanceOf(address(tok), stealth), 0);
        assertEq(sc.nonces(stealth), 1);
        assertEq(stealth.balance, 0, "stealth never needed gas");
    }

    function test_claim_replayReverts() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(stealthKey, dest, 40, 0, dl);
        sc.claim(address(tok), stealth, dest, 40, dl, sig);
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 40, dl, sig);
        assertEq(tok.balanceOf(dest), 40);
    }

    function test_claim_wrongSignerReverts() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(0xB0B, dest, 100, 0, dl); // test-key
        // digest is over `stealth` but signed by another key
        bytes32 d = sc.claimDigest(address(tok), stealth, dest, 100, 0, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, d); // test-key
        sig = abi.encodePacked(r, s, v);
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 100, dl, sig);
        // garbage signature
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 100, dl, hex"1234");
    }

    function test_claim_tamperedFieldsRevert() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(stealthKey, dest, 50, 0, dl);
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, relayer, 50, dl, sig); // relayer redirects to itself
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 100, dl, sig); // more than signed
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 50, dl + 1, sig); // longer deadline
    }

    function test_claim_highSMalleableSignatureRejected() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 d = sc.claimDigest(address(tok), stealth, dest, 100, 0, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(stealthKey, d);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // not-a-key (secp256k1 order)
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 100, dl, flipped);
    }

    function test_claim_expiredReverts() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 10;
        bytes memory sig = _sign(stealthKey, dest, 100, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.Expired.selector, dl));
        sc.claim(address(tok), stealth, dest, 100, dl, sig);
        vm.warp(dl); // the deadline second itself is still valid
        sc.claim(address(tok), stealth, dest, 100, dl, sig);
    }

    function test_claim_partialClaims() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        sc.claim(address(tok), stealth, dest, 30, dl, _sign(stealthKey, dest, 30, 0, dl));
        address dest2 = makeAddr("dest2");
        sc.claim(address(tok), stealth, dest2, 70, dl, _sign(stealthKey, dest2, 70, 1, dl));
        assertEq(tok.balanceOf(dest), 30);
        assertEq(tok.balanceOf(dest2), 70);
        assertEq(sc.balanceOf(address(tok), stealth), 0);
        bytes memory sig = _sign(stealthKey, dest, 1, 2, dl);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.InsufficientBalance.selector, 0, 1));
        sc.claim(address(tok), stealth, dest, 1, dl, sig);
    }

    function test_claim_toAnyDestinationButZeroOrSelf() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        // a contract destination is fine
        address c = address(new MockStockERC20("X", 18));
        sc.claim(address(tok), stealth, c, 10, dl, _sign(stealthKey, c, 10, 0, dl));
        assertEq(tok.balanceOf(c), 10);
        bytes memory sig = _sign(stealthKey, address(0), 10, 1, dl);
        vm.expectRevert(StealthClaims.BadDestination.selector);
        sc.claim(address(tok), stealth, address(0), 10, dl, sig);
        sig = _sign(stealthKey, address(sc), 10, 1, dl);
        vm.expectRevert(StealthClaims.BadDestination.selector);
        sc.claim(address(tok), stealth, address(sc), 10, dl, sig);
    }

    function test_claim_zeroAmountReverts() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(stealthKey, dest, 0, 0, dl);
        vm.expectRevert(StealthClaims.ZeroAmount.selector);
        sc.claim(address(tok), stealth, dest, 0, dl, sig);
    }

    function test_claim_signatureIsBoundToThisContractAndChain() public {
        _fund(stealth, 100);
        StealthClaims other = new StealthClaims(
            address(this), IERC5564Announcer(StealthCode.ANNOUNCER), IERC6538Registry(StealthCode.REGISTRY)
        );
        assertTrue(other.domainSeparator() != sc.domainSeparator());
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(stealthKey, dest, 100, 0, dl);
        vm.chainId(999);
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 100, dl, sig);
    }

    function test_claimDirectByStealthAndCancelsOutstandingSignatures() public {
        _fund(stealth, 100);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory pendingSig = _sign(stealthKey, dest, 50, 0, dl);
        vm.prank(stealth);
        sc.claimDirect(address(tok), dest, 60);
        assertEq(tok.balanceOf(dest), 60);
        vm.expectRevert(StealthClaims.BadSignature.selector);
        sc.claim(address(tok), stealth, dest, 50, dl, pendingSig);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.InsufficientBalance.selector, 0, 1));
        sc.claimDirect(address(tok), dest, 1);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(StealthClaims.ZeroAddress.selector);
        new StealthClaims(address(0), IERC5564Announcer(StealthCode.ANNOUNCER), IERC6538Registry(StealthCode.REGISTRY));
    }

    /// Any sequence of partial claims pays out exactly what was credited and keeps the books funded.
    function testFuzz_partialClaimsConserve(uint256 total, uint256[6] memory cuts) public {
        total = bound(total, 1, 1e30);
        _fund(stealth, total);
        uint256 paid;
        for (uint256 i; i < cuts.length; ++i) {
            uint256 left = total - paid;
            if (left == 0) break;
            uint256 raw = i == cuts.length - 1 ? left : bound(cuts[i], 1, left);
            _claimOne(raw, i);
            paid += raw;
            assertEq(sc.balanceOf(address(tok), stealth), total - paid);
            assertGe(tok.balanceOf(address(sc)), sc.pooled(address(tok)) + sc.totalCredited(address(tok)));
        }
        assertEq(tok.balanceOf(dest), total);
        assertEq(tok.balanceOf(address(sc)), 0);
    }

    function _claimOne(uint256 raw, uint256 nonce) internal {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sign(stealthKey, dest, raw, nonce, dl);
        sc.claim(address(tok), stealth, dest, raw, dl, sig);
    }
}
