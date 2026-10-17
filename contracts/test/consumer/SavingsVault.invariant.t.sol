// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {IAllowanceTransfer} from "../../src/interfaces/IPermit2.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {SavingsVaultBase} from "./SavingsVaultBase.sol";

/// Drives every state-changing path with random actors, amounts and time jumps.
contract VaultHandler is Test {
    SavingsVault public vault;
    MockUSDG public usdg;
    address public keeper;
    address public crowd;
    address public permit2;
    address[] public actors;
    uint32 public nextLog;
    uint256 public calls;

    constructor(SavingsVault v, MockUSDG u, address k, address c, address p2, address tsla) {
        vault = v;
        usdg = u;
        keeper = k;
        crowd = c;
        permit2 = p2;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.startPrank(a);
            usdg.approve(address(vault), type(uint256).max);
            usdg.approve(permit2, type(uint256).max);
            IAllowanceTransfer(permit2).approve(address(usdg), address(vault), type(uint160).max, type(uint48).max);
            vault.setSettings(SavingsVault.Settings(uint8([1, 5, 10, 10][i]), uint8(i % 3 + 1), uint64(100e6 + i * 100e6), uint64([uint64(0), 25e6, 50e6, 100e6][i]), 0));
            SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](1);
            m[0] = SavingsVault.MixEntry(tsla, 10_000);
            vault.setMix(m);
            vm.stopPrank();
        }
        vm.prank(crowd);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function deposit(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1, 1_000e6);
        usdg.mint(a, amount);
        vm.prank(a);
        vault.deposit(amount);
        ++calls;
    }

    function withdraw(uint256 seed, uint256 amount, bool toSelf) external {
        address a = _actor(seed);
        (uint256 av, uint256 pe) = vault.balancesOf(a);
        if (av + pe == 0) return;
        amount = bound(amount, 1, av + pe);
        vm.prank(a);
        vault.withdraw(amount, toSelf ? a : address(0xBEEF));
        ++calls;
    }

    function accrue(uint256 seed, uint256 spend) external {
        spend = bound(spend, 0, 10_000e6);
        vm.prank(keeper);
        vault.accrue(_actor(seed), bytes32(uint256(nextLog) + 1), nextLog, spend);
        ++nextLog;
        ++calls;
    }

    function topUp(uint256 seed) external {
        address a = _actor(seed);
        SavingsVault.Account memory acc = vault.accountOf(a);
        uint256 amt = vault.settingsOf(a).fixedTopUp;
        if (amt == 0 || (acc.lastTopUpAt != 0 && block.timestamp < acc.lastTopUpAt + 7 days)) return;
        usdg.mint(a, amt);
        vm.prank(keeper);
        vault.pullFixedTopUp(a);
        ++calls;
    }

    function sweep(uint256 seed) external {
        vm.prank(crowd);
        vault.sweep(_actor(seed));
        ++calls;
    }

    function refund(uint256 seed, uint256 amount) external {
        uint256 bal = usdg.balanceOf(crowd);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(crowd);
        vault.refundFromCrowd(_actor(seed), amount);
        ++calls;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }
}

/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.fail-on-revert = true
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 500
contract SavingsVaultInvariantTest is SavingsVaultBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, usdg, keeper, crowd, permit2, tsla);
        usdg.transferOwnership(address(handler)); // handler mints
        targetContract(address(handler));
    }

    /// R8: the vault always holds at least what it owes.
    function invariant_R8_balanceCoversAllAccounts() public view {
        uint256 owed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (uint256 a, uint256 p) = vault.balancesOf(handler.actors(i));
            owed += a + p;
        }
        assertGe(usdg.balanceOf(address(vault)), owed);
    }

    /// R2 under random sequences: a week's round-ups never exceed the user's cap.
    function invariant_R2_weeklyCapHolds() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            assertLe(vault.accountOf(a).accruedThisWeek, vault.settingsOf(a).weeklyCap);
        }
    }

    /// Every handler path is expected to succeed (fail-on-revert), and runs must actually move state.
    function afterInvariant() external view {
        assertGt(handler.calls(), 0);
    }
}
