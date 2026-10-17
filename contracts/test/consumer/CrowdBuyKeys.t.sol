// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../../src/consumer/StealthClaims.sol";
import {IERC5564Announcer} from "../../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../../src/interfaces/IERC6538Registry.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";
import {StealthCode} from "./StealthCode.sol";

/// Audit M-6 (contract side): the contracts accepted a Quiet meta-address that is not on the curve and a low-order
/// Hidden viewing key; the keeper threw on that user and the whole delivery pass stopped for everyone.
contract CrowdBuyKeysTest is CrowdBuyBase {
    bytes32 constant OWNER_PK = bytes32(uint256(0x1234));
    // spending = G, viewing = 2G
    bytes constant GOOD_META =
        hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179802c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    // x = 5 is not on secp256k1 (5^3 + 7 = 132 is not a square mod p); viewing = 2G
    bytes constant OFF_CURVE_META =
        hex"02000000000000000000000000000000000000000000000000000000000000000502c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    IERC6538Registry internal reg = IERC6538Registry(StealthCode.REGISTRY);

    function setUp() public override {
        super.setUp();
        vm.etch(StealthCode.ANNOUNCER, StealthCode.ANNOUNCER_RUNTIME);
        vm.etch(StealthCode.REGISTRY, StealthCode.REGISTRY_RUNTIME);
        StealthClaims sc = new StealthClaims(address(crowd), IERC5564Announcer(StealthCode.ANNOUNCER), reg);
        vm.prank(owner);
        crowd.setStealthClaims(sc);
    }

    function _lowOrder() internal pure returns (bytes32[7] memory l) {
        l[0] = bytes32(0); // u = 0 (only reachable with a zero owner key, which is refused separately)
        l[1] = hex"0100000000000000000000000000000000000000000000000000000000000000";
        l[2] = hex"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800";
        l[3] = hex"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157";
        l[4] = hex"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
        l[5] = hex"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
        l[6] = hex"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
    }

    function test_M6_lowOrderViewingKeysAreRefused() public {
        bytes32[7] memory l = _lowOrder();
        for (uint256 i = 1; i < l.length; ++i) {
            vm.expectRevert(SavingsVault.InvalidSettings.selector);
            vault.setHiddenKeys(OWNER_PK, l[i]);
            // The same point with the ignored high bit set.
            vm.expectRevert(SavingsVault.InvalidSettings.selector);
            vault.setHiddenKeys(OWNER_PK, l[i] | bytes32(uint256(0x80)));
        }
        vault.setHiddenKeys(OWNER_PK, bytes32(uint256(0x5678)) << 8); // an ordinary key is fine
    }

    function _quietBook(address u, bytes memory meta) internal {
        _joinA(_user(0), 10 * U);
        _joinA(_user(1), 10 * U);
        _joinA(u, 10 * U);
        SavingsVault.Settings memory s = vault.settingsOf(u);
        s.mode = 1;
        vm.startPrank(u);
        vault.setSettings(s);
        reg.registerKeys(1, meta);
        vm.stopPrank();
        bytes32 secret = keccak256("k");
        _commit(address(tokA), 0, secret);
        vm.warp(GENESIS);
        vm.warp(_reveal(address(tokA), 0, secret));
        _freshFeeds();
        _executeAsKeeper(address(tokA));
    }

    function test_M6_offCurveMetaAddressIsRefusedOnChain() public {
        address u = _user(2);
        _quietBook(u, OFF_CURVE_META);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.BadMetaAddress.selector, u));
        crowd.deliver(address(tokA), 0, u, abi.encode(uint8(1)));
        assertFalse(crowd.metaAddressValid(u));
        // The saver's own exit is untouched.
        vm.prank(u);
        crowd.claimOpen(address(tokA), 0);
    }

    function test_M6_metaAddressShapeChecks() public {
        address u = _user(2);
        _quietBook(u, GOOD_META);
        assertTrue(crowd.metaAddressValid(u));
        bytes memory badPrefix = GOOD_META;
        badPrefix[0] = 0x04;
        vm.prank(u);
        reg.registerKeys(1, badPrefix);
        assertFalse(crowd.metaAddressValid(u));
        vm.prank(u);
        reg.registerKeys(1, hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
        assertFalse(crowd.metaAddressValid(u)); // 33 bytes: only one key
        vm.prank(u);
        reg.registerKeys(1, GOOD_META);
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, u, abi.encode(uint8(1)));
    }
}
