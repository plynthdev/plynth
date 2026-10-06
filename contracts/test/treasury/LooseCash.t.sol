// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFactory} from "../../src/treasury/TreasuryFactory.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {TemplateRegistry} from "../../src/treasury/TemplateRegistry.sol";
import {ITierSource} from "../../src/interfaces/ITierSource.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";

/// B3 (fork run 2026-10-06): the PeriodClose's cash asset (USDG) is tracked before any desk is registered, so a
/// treasury funded first and staffed later shows its money in NAV, in the period close and in the fee.
contract LooseCashTest is TreasuryFixture {
    uint256 constant FUNDED = 50_000e6;
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)
    address feeTo = makeAddr("feeTo");
    TreasuryFactory factory;
    TreasuryAccount fAccount;
    PeriodClose fClose;
    TreasuryPolicy fPolicy;

    function setUp() public override {
        super.setUp();
        TreasuryPolicy.Policy memory none;
        factory = new TreasuryFactory(
            address(new TreasuryPolicy(address(0), none)),
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
            feeTo,
            ITierSource(address(0)),
            TemplateRegistry(address(0))
        );
        TreasuryPolicy.Policy memory p = _policy();
        p.cash = TreasuryPolicy.Band(0, 10_000); // all cash is inside the band before the first trade
        (address a, address pol, address c) = factory.deploy(abi.encode(p), board);
        fAccount = TreasuryAccount(payable(a));
        fPolicy = TreasuryPolicy(pol);
        fClose = PeriodClose(c);
        usdg.mint(address(fAccount), FUNDED);
    }

    function test_navCountsCashBeforeAnyDesk() public view {
        (uint256 nav, bool hold) = fAccount.navUsd();
        assertEq(nav, 50_000e18);
        assertFalse(hold);
        (address asset, uint256 usd) = fAccount.looseCash();
        assertEq(asset, address(usdg));
        assertEq(usd, 50_000e18);
        (address[] memory assets, uint8[] memory kinds, uint8[] memory bands) = fAccount.trackedAssets();
        assertEq(assets.length, 1);
        assertEq(assets[0], address(usdg));
        assertEq(kinds[0], 0);
        assertEq(bands[0], 0);
        PolicyGuard.Snapshot memory s = guard.snapshot(address(fAccount));
        assertEq(s.nav, 50_000e18);
        assertEq(s.cashUsd, 50_000e18);
    }

    function test_periodCloseAndFeeBeforeAnyDesk() public {
        _warp(T0 + 30 days);
        (PeriodClose.Position[] memory pos, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = fClose.preview();
        assertEq(nav, 50_000e18);
        assertEq(cBps, 10_000);
        assertEq(eBps, 0);
        assertEq(pos.length, 1);
        assertEq(pos[0].asset, address(usdg));
        assertEq(pos[0].raw, FUNDED);
        (, bytes32 h, uint32 v) = fPolicy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(T0 + 30 days), nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(controllerKey, fClose.digest(c));
        fClose.commit(c, abi.encodePacked(r, s, sv));
        uint256 fee = fClose.feeFor(nav, 30 days);
        assertGt(fee, 0);
        assertEq(usdg.balanceOf(feeTo), fee);
        assertEq(fClose.periodStartNav(), nav - fee * 1e12);
        (uint256 after_,) = fAccount.navUsd();
        assertEq(after_, nav - fee * 1e12);
    }

    function test_aSleeveListingCashReplacesTheLooseEntry() public {
        vm.prank(board);
        fAccount.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        (address asset, uint256 usd) = fAccount.looseCash();
        assertEq(asset, address(0));
        assertEq(usd, 0);
        (address[] memory assets,,) = fAccount.trackedAssets();
        assertEq(assets.length, 2); // the sleeve's USDG and vault: USDG is not listed twice
        assertEq(assets[0], address(usdg));
        assertEq(assets[1], address(vault));
        (uint256 nav,) = fAccount.navUsd();
        assertEq(nav, 50_000e18);
    }

    /// An equity desk registered first (its sleeve does not list USDG) trades from the loose cash: USDG going out
    /// is a tracked change, not value leaving the tracked set (before the fix: R6, rule 5-6 unknown change).
    function test_equityDeskTradesFromLooseCash() public {
        vm.prank(board);
        fAccount.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        (address[] memory assets,,) = fAccount.trackedAssets();
        assertEq(assets[assets.length - 1], address(usdg));
        TreasuryPolicy.Policy memory p = _policy();
        p.cash = TreasuryPolicy.Band(0, 10_000);
        p.equity = TreasuryPolicy.Band(0, 10_000);
        vm.prank(board);
        fPolicy.propose(p);
        _warp(block.timestamp + fPolicy.TIMELOCK());
        fPolicy.activate();
        vm.prank(eqKey);
        fAccount.execute(EQUITY_DESK, address(eqSleeve), _buyData(address(nvda), 1_000e6), _allow(address(nvda)), 0);
        assertGt(nvda.balanceOf(address(fAccount)), 0);
        (uint256 nav,) = fAccount.navUsd();
        assertApproxEqRel(nav, 50_000e18, 0.001e18);
    }

    /// Direct deployments: once the board sets a PeriodClose, its cash is tracked the same way; a PeriodClose
    /// without `cash()` (or none) leaves the account on sleeves only.
    function test_directAccountTracksItsPeriodCloseCash() public {
        TreasuryAccount d = new TreasuryAccount(board, policy, guard, address(approvals));
        usdg.mint(address(d), 1_000e6);
        (uint256 nav,) = d.navUsd();
        assertEq(nav, 0);
        vm.prank(board);
        d.setPeriodClose(address(periodClose)); // the fixture's mock: no cash()
        (nav,) = d.navUsd();
        assertEq(nav, 0);
        PeriodClose pc = new PeriodClose(d, IERC20Metadata(address(usdg)), feeTo, ITierSource(address(0)));
        vm.prank(board);
        d.setPeriodClose(address(pc));
        (nav,) = d.navUsd();
        assertEq(nav, 1_000e18);
    }

    function testFuzz_navEqualsSnapshotWithLooseCash(uint96 raw) public {
        usdg.mint(address(fAccount), raw);
        (uint256 nav,) = fAccount.navUsd();
        assertEq(nav, (uint256(FUNDED) + raw) * 1e12);
        assertEq(nav, guard.snapshot(address(fAccount)).nav);
        (,, uint256 pNav, uint16 cBps,,) = fClose.preview();
        assertEq(pNav, nav);
        assertEq(cBps, 10_000);
    }
}
