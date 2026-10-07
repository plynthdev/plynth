// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFactory} from "../../src/treasury/TreasuryFactory.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {TemplateRegistry} from "../../src/treasury/TemplateRegistry.sol";
import {PLTH} from "../../src/token/PLTH.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {ITierSource, Tier} from "../../src/interfaces/ITierSource.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";

/// B1 (fork run 2026-10-06): a factory-made TreasuryAccount enforces the board's staking tier `maxDesks` in
/// `registerDesk`. Revoked desks do not count; unstaking below the tier keeps the desks already registered.
contract DeskTiersTest is TreasuryFixture {
    address worker = makeAddr("worker");
    PLTH plth;
    PlinthStaking staking;
    TreasuryFactory factory;
    TreasuryAccount fAccount;

    function setUp() public override {
        super.setUp();
        plth = new PLTH(worker, makeAddr("plthTreasury"), makeAddr("reserve"));
        PlinthStaking.TierSpec[] memory t = new PlinthStaking.TierSpec[](2);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        t[1] = PlinthStaking.TierSpec(10_000e18, Tier(4, true, false, 1));
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), t, 7 days);
        TreasuryPolicy.Policy memory none;
        factory = new TreasuryFactory(
            address(new TreasuryPolicy(address(0), none, 48 hours)),
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0))),
            address(
                new PeriodClose(
                    TreasuryAccount(payable(address(0))),
                    IERC20Metadata(address(0)),
                    address(0),
                    ITierSource(address(0))
                )
            ),
            address(new BoardApprovals(address(0), address(0))),
            guard,
            IERC20Metadata(address(usdg)),
            makeAddr("feeTo"),
            staking,
            TemplateRegistry(address(0))
        );
        (address a,,) = factory.deploy(abi.encode(_policy()), board);
        fAccount = TreasuryAccount(payable(a));
    }

    function _register(bytes32 id) internal {
        address[] memory both = new address[](2);
        both[0] = address(cashSleeve);
        both[1] = address(eqSleeve);
        vm.prank(board);
        fAccount.registerDesk(id, cashKey, both);
    }

    function _expectTierTooLow(uint256 maxDesks) internal {
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.TierTooLow.selector, board, maxDesks));
    }

    function _stake(uint256 amount) internal {
        vm.prank(worker);
        plth.transfer(board, amount);
        vm.startPrank(board);
        plth.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function test_factoryHandsTheTierSourceToTheAccount() public view {
        assertEq(address(fAccount.tiers()), address(staking));
        assertEq(fAccount.activeDeskCount(), 0);
    }

    function test_tier0BoardCannotRegisterAThirdDesk() public {
        _register("one");
        _register("two");
        _expectTierTooLow(2);
        _register("three");
        assertEq(fAccount.activeDeskCount(), 2);
    }

    function test_stakingToTheNextTierAllowsMoreDesks() public {
        _register("one");
        _register("two");
        _stake(10_000e18);
        _register("three");
        _register("four");
        assertEq(fAccount.activeDeskCount(), 4);
        _expectTierTooLow(4);
        _register("five");
    }

    function test_revokedDesksDoNotCount() public {
        _register("one");
        _register("two");
        vm.prank(board);
        fAccount.revokeDesk("one");
        assertEq(fAccount.activeDeskCount(), 1);
        _register("three");
        // Re-registering a revoked id is a new active desk: it counts again.
        _expectTierTooLow(2);
        _register("one");
        vm.prank(board);
        fAccount.revokeDesk("two");
        _register("one");
        assertTrue(fAccount.desk("one").active);
        assertEq(fAccount.activeDeskCount(), 2);
    }

    /// Documented rule: the tier is read when a desk is registered. Unstaking keeps existing desks (they keep
    /// trading); the board cannot add one until it is back under its limit (revoke) or stakes again.
    function test_unstakingBelowTheTierKeepsExistingDesks() public {
        _stake(10_000e18);
        for (uint256 i = 1; i <= 4; ++i) {
            _register(bytes32(i));
        }
        vm.prank(board);
        staking.unstake(10_000e18);
        assertEq(staking.tierOf(board).maxDesks, 2);
        for (uint256 i = 1; i <= 4; ++i) {
            assertTrue(fAccount.desk(bytes32(i)).active);
        }
        assertEq(fAccount.activeDeskCount(), 4);

        // An existing desk still trades.
        usdg.mint(address(fAccount), FUNDING);
        aapl.mint(address(fAccount), SEED_AAPL); // cash 60%, equity 40%: inside both bands
        vm.prank(cashKey);
        fAccount.execute(
            bytes32(uint256(4)),
            address(cashSleeve),
            _data(address(usdg), 1_000e6, 0, address(0), 1_000e6),
            _allow(address(vault)),
            0
        );

        _expectTierTooLow(2);
        _register("five");
        vm.startPrank(board);
        fAccount.revokeDesk(bytes32(uint256(1)));
        fAccount.revokeDesk(bytes32(uint256(2)));
        fAccount.revokeDesk(bytes32(uint256(3)));
        vm.stopPrank();
        _register("five");
        assertEq(fAccount.activeDeskCount(), 2);
    }

    /// Accounts without a tier source (deployed directly, or by a factory without staking) have no desk limit.
    function test_noTierSourceMeansNoDeskLimit() public {
        assertEq(address(account.tiers()), address(0));
        vm.startPrank(board);
        for (uint256 i = 1; i <= 6; ++i) {
            account.registerDesk(bytes32(i), cashKey, _one(address(cashSleeve)));
        }
        vm.stopPrank();
        assertEq(account.activeDeskCount(), 8); // the fixture's two plus six
    }

    function testFuzz_activeDesksNeverExceedTheTier(uint8 stakeK, uint8 ops, uint256 seed) public {
        if (stakeK % 2 == 1) _stake(10_000e18);
        uint256 maxDesks = staking.tierOf(board).maxDesks;
        for (uint256 i; i < ops % 24; ++i) {
            bytes32 id = bytes32(uint256(keccak256(abi.encode(seed, i))) % 6 + 1);
            bool active = fAccount.desk(id).active;
            bool room = fAccount.activeDeskCount() < maxDesks;
            if (!active && !room) {
                vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.TierTooLow.selector, board, maxDesks));
            }
            vm.prank(board);
            if (active) fAccount.revokeDesk(id);
            else fAccount.registerDesk(id, cashKey, _one(address(cashSleeve)));
            assertLe(fAccount.activeDeskCount(), maxDesks);
        }
    }
}
