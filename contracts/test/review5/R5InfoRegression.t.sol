// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MainnetBetaTest} from "../script/MainnetBeta.t.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {PerpFixture} from "../perps/PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {SafeCode} from "../mocks/SafeCode.sol";

/// The R5-ORC-1 PoC's forwarder: one key, but it answers like a 2-of-2 Safe.
contract SafeShapedForwarder {
    address internal immutable key;

    constructor(address k) {
        key = k;
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function getOwners() external view returns (address[] memory o) {
        o = new address[](2);
        (o[0], o[1]) = (key, address(uint160(key) + 1));
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory m, address next) {
        (m, next) = (new address[](0), address(1));
    }
}

/// Review v5 R5-ORC-1 (wt-review5 R5InfoPocs.t.sol::R5OwnerPinTest), as a regression test: the OWNER pin checks it is
/// really a Safe (official SafeProxy code, official singleton, no module, no guard), not what the contract claims.
contract R5OwnerPinRegressionTest is MainnetBetaTest {
    function test_R5ORC1_safeShapedForwarderFails() public {
        SafeShapedForwarder f = new SafeShapedForwarder(makeAddr("one-key"));
        assertFalse(script.isMultisigOwner(address(f)), "claims 2-of-2, is not a Safe proxy");
        MainnetBeta.Config memory c = _cfg();
        c.owner = address(f);
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.OwnerNotMultisig.selector, address(f)));
        script.checkConfig(c, makeAddr("deployer"));
    }

    function _signers(uint256 n) internal returns (address[] memory s) {
        s = new address[](n);
        for (uint256 i; i < n; i++) s[i] = makeAddr(string(abi.encode("r5signer", i)));
    }

    function test_R5ORC1_realSafeShapesAndTheirFailures() public {
        address safe = makeAddr("r5-safe");
        _makeSafe(safe, _signers(3), 2);
        assertTrue(script.isMultisigOwner(safe), "official proxy, official singleton, 2-of-3, no module, no guard");
        // A singleton that is not an official one.
        address fakeSingleton = makeAddr("fake-singleton");
        vm.etch(fakeSingleton, address(SafeCode.SINGLETON_130).code);
        vm.store(safe, bytes32(0), bytes32(uint256(uint160(fakeSingleton))));
        assertFalse(script.isMultisigOwner(safe), "unofficial singleton");
        _makeSafe(safe, _signers(3), 2);
        // An enabled module lets one key act alone.
        address module = makeAddr("module");
        vm.store(safe, keccak256(abi.encode(address(1), uint256(1))), bytes32(uint256(uint160(module))));
        vm.store(safe, keccak256(abi.encode(module, uint256(1))), bytes32(uint256(1)));
        assertFalse(script.isMultisigOwner(safe), "a module is enabled");
        _makeSafe(safe, _signers(3), 2);
        vm.store(safe, keccak256(abi.encode(module, uint256(1))), bytes32(0));
        // A guard set.
        vm.store(safe, keccak256("guard_manager.guard.address"), bytes32(uint256(uint160(module))));
        assertFalse(script.isMultisigOwner(safe), "a guard is set");
        // 1-of-3 on a real Safe.
        address one = makeAddr("r5-one");
        _makeSafe(one, _signers(3), 1);
        assertFalse(script.isMultisigOwner(one), "threshold 1");
    }
}

/// Review v5 R5-ORC-2 (wt-review5 R5InfoPocs.t.sol::R5AttesterDisableTest), as a regression test: disabling the
/// attester ends the records it issued at once; a later rotation's records count; a plain rotation keeps records.
contract R5AttesterRegressionTest is Test {
    function _sign(EligibilityRegistry reg, uint256 key, address user, uint64 t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, reg.attestationDigest(user, t, t + 31 days, 7));
        return abi.encodePacked(r, s, v);
    }

    function test_R5ORC2_disableEndsTheStolenKeysRecordsAtOnce() public {
        address owner = makeAddr("owner");
        (address att, uint256 attKey) = makeAddrAndKey("attester");
        vm.warp(1_800_000_000);
        EligibilityRegistry reg = new EligibilityRegistry(owner, att);
        address bad = makeAddr("sanctioned");
        uint64 t = uint64(block.timestamp);
        reg.attest(bad, t, t + 31 days, 7, _sign(reg, attKey, bad, t));
        assertTrue(reg.isEligible(bad));
        vm.prank(owner);
        reg.disableAttester();
        assertFalse(reg.isEligible(bad), "the stolen key's record stops counting at once");
        (address newAtt, uint256 newKey) = makeAddrAndKey("newAttester");
        vm.prank(owner);
        reg.setAttester(newAtt);
        skip(48 hours);
        vm.prank(owner);
        reg.setAttester(newAtt);
        address honest = makeAddr("honest");
        uint64 t2 = uint64(block.timestamp);
        reg.attest(honest, t2, t2 + 31 days, 7, _sign(reg, newKey, honest, t2));
        assertTrue(reg.isEligible(honest), "a record from the new attester counts");
        assertFalse(reg.isEligible(bad));
    }

    function test_R5ORC2_plainRotationKeepsRecords() public {
        address owner = makeAddr("owner");
        (address att, uint256 attKey) = makeAddrAndKey("attester");
        vm.warp(1_800_000_000);
        EligibilityRegistry reg = new EligibilityRegistry(owner, att);
        address user = makeAddr("user");
        uint64 t = uint64(block.timestamp);
        reg.attest(user, t, t + 31 days, 7, _sign(reg, attKey, user, t));
        vm.prank(owner);
        reg.setAttester(makeAddr("next"));
        skip(48 hours);
        vm.prank(owner);
        reg.setAttester(makeAddr("next"));
        assertTrue(reg.isEligible(user), "no disable: existing records stay");
    }
}

/// Review v5 R5-PERP-3 (wt-review5 R5InfoPocs.t.sol::R5HeldSettleBandTest), as regression tests: beyond the +-30%
/// band a single round is rejected (settle at the last price, HeldSettleRoundRejected); two consecutive rounds that
/// agree confirm a real move. A faulty round inside the band is still used (documented in SECURITY.md).
contract R5HeldSettleRegressionTest is PerpFixture {
    address internal r5bob = makeAddr("bob-r5");

    function setUp() public override {
        super.setUp();
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        vm.prank(r5bob);
        usdg.approve(address(pool), type(uint256).max);
    }

    function test_R5P3_singleRoundBeyondTheBandIsRejectedAndRecorded() public {
        _open(r5bob, true, 10_000e6, 2_000e6); // long 100 tokens at 100
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        _setPrice(60e8); // one round, -40%
        uint256 b = usdg.balanceOf(r5bob);
        vm.expectEmit(false, false, false, true, address(market));
        emit PerpMarket.HeldSettleRoundRejected(60e18, 100e18, 2);
        market.settleHeld(r5bob);
        assertGt(usdg.balanceOf(r5bob) - b, 1_900e6, "unconfirmed: settled at the last price");
    }

    function test_R5P3_consecutiveRoundsConfirmARealMove() public {
        _open(r5bob, true, 10_000e6, 2_000e6);
        registry.delist(address(token));
        skip(1 days);
        _setPrice(60e8); // the real price fell 40%
        market.poke(); // anyone (the keeper) records the out-of-band round it sees
        skip(market.HELD_GRACE());
        _setPrice(59e8); // the next round agrees (within 5%)
        uint256 b = usdg.balanceOf(r5bob);
        market.settleHeld(r5bob);
        assertLt(usdg.balanceOf(r5bob) - b, 1e6, "confirmed: the long's 4,100 loss is booked (collateral gone)");
    }

    function test_R5P3_disagreeingRoundsDoNotConfirm() public {
        _open(r5bob, true, 10_000e6, 2_000e6);
        registry.delist(address(token));
        skip(1 days);
        _setPrice(60e8);
        market.poke();
        skip(market.HELD_GRACE());
        _setPrice(40e8); // 33% away from the previous one: no confirmation
        uint256 b = usdg.balanceOf(r5bob);
        market.settleHeld(r5bob);
        assertGt(usdg.balanceOf(r5bob) - b, 1_900e6, "settled at the last price");
    }

    function test_R5P3_faultyRoundInsideTheBandIsStillUsed() public {
        _open(r5bob, false, 10_000e6, 2_000e6); // short 100 at 100
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        _setPrice(71e8); // -29%: inside the band (accepted risk, SECURITY.md)
        uint256 b = usdg.balanceOf(r5bob);
        market.settleHeld(r5bob);
        assertGt(usdg.balanceOf(r5bob) - b, 4_800e6);
    }
}
