// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockEquitySleeve, MockCashSleeve, MockCashVault} from "../mocks/TreasuryMocks.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// Random desk operations. After every successful execute it checks, independently of the guard's code:
/// each band holds or its weight moved strictly closer from the same side, and the notional executed in any
/// trailing 24 hours never exceeds the day cap.
contract DeskHandler is Test {
    struct Rec {
        uint256 ts;
        uint256 notional;
    }

    TreasuryAccount immutable account;
    PolicyGuard immutable guard;
    MockEquitySleeve immutable eqSleeve;
    MockCashSleeve immutable cashSleeve;
    MockUSDG immutable usdg;
    MockCashVault immutable vault;
    MockStockToken[2] tokens;
    MockFeed[2] feeds;
    address immutable eqKey;
    address immutable cashKey;
    mapping(address => bytes32[]) proofs;

    uint256 constant DAY_CAP = 250_000e18;
    uint256 constant CASH_LO = 0.4e18;
    uint256 constant CASH_HI = 0.7e18;
    uint256 constant EQ_LO = 0.3e18;
    uint256 constant EQ_HI = 0.6e18;

    Rec[] public recs;
    uint256 public successes;
    uint256 public rejections;
    bool public bandViolated;
    bool public dayCapViolated;

    constructor(
        TreasuryAccount account_,
        MockEquitySleeve eqSleeve_,
        MockCashSleeve cashSleeve_,
        MockStockToken[2] memory tokens_,
        MockFeed[2] memory feeds_,
        address eqKey_,
        address cashKey_,
        bytes32[][4] memory proofs_
    ) {
        account = account_;
        guard = account_.guard();
        eqSleeve = eqSleeve_;
        cashSleeve = cashSleeve_;
        usdg = MockUSDG(address(cashSleeve_.usdg()));
        vault = cashSleeve_.vault();
        tokens = tokens_;
        feeds = feeds_;
        eqKey = eqKey_;
        cashKey = cashKey_;
        proofs[address(usdg)] = proofs_[0];
        proofs[address(vault)] = proofs_[1];
        proofs[address(tokens_[0])] = proofs_[2];
        proofs[address(tokens_[1])] = proofs_[3];
    }

    // ------------------------------------------------------------ actions

    function buy(uint256 seed, uint256 amount) external {
        MockStockToken t = tokens[seed % 2];
        amount = bound(amount, 1e6, 50_000e6);
        if (amount > usdg.balanceOf(address(account))) return;
        _exec(eqKey, "equity", address(eqSleeve), address(usdg), amount, abi.encode(uint8(0), address(t), amount), address(t));
    }

    function sell(uint256 seed, uint256 pct) external {
        MockStockToken t = tokens[seed % 2];
        uint256 bal = t.balanceOf(address(account));
        uint256 raw = bal * bound(pct, 1, 100) / 100;
        uint256 maxRaw = 49_000e18 * 1e18 / (seed % 2 == 0 ? 200e18 : 100e18); // keep notional under approval
        if (raw > maxRaw) raw = maxRaw;
        if (raw == 0) return;
        _exec(eqKey, "equity", address(eqSleeve), address(t), raw, abi.encode(uint8(1), address(t), raw), address(usdg));
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1e6, 50_000e6);
        if (amount > usdg.balanceOf(address(account))) return;
        _exec(cashKey, "cash", address(cashSleeve), address(usdg), amount, abi.encode(uint8(0), address(0), amount), address(vault));
    }

    function redeem(uint256 pct) external {
        uint256 shares = vault.balanceOf(address(account)) * bound(pct, 1, 100) / 100;
        if (shares > 50_000e6) shares = 50_000e6;
        if (shares == 0) return;
        _exec(cashKey, "cash", address(cashSleeve), address(vault), shares, abi.encode(uint8(1), address(0), shares), address(usdg));
    }

    function setFee(uint16 fee) external {
        eqSleeve.setFee(uint16(bound(fee, 0, 300)));
    }

    function warp(uint256 secs, bool freshFeeds) external {
        secs = bound(secs, 0, 30 hours);
        vm.warp(block.timestamp + secs);
        if (freshFeeds) {
            feeds[0].setUpdatedAt(block.timestamp);
            feeds[1].setUpdatedAt(block.timestamp);
        }
    }

    // ------------------------------------------------------------ core

    function _exec(
        address key,
        bytes32 deskId,
        address adapter,
        address pullToken,
        uint256 pullAmount,
        bytes memory runData,
        address increased
    ) internal {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(pullToken, pullAmount);
        bytes memory data = abi.encode(pulls, runData);
        PolicyGuard.Snapshot memory b = guard.snapshot(address(account));

        vm.prank(key);
        try account.execute(deskId, adapter, data, proofs[increased], 0) {
            ++successes;
            PolicyGuard.Snapshot memory a = guard.snapshot(address(account));
            _checkBands(b, a);
            _recordAndCheckDay(b, a);
        } catch {
            ++rejections;
        }
    }

    function _checkBands(PolicyGuard.Snapshot memory b, PolicyGuard.Snapshot memory a) internal {
        if (a.nav == 0) return;
        if (!_ok(CASH_LO, CASH_HI, b.cashUsd * 1e18 / b.nav, a.cashUsd * 1e18 / a.nav)) bandViolated = true;
        if (!_ok(EQ_LO, EQ_HI, b.equityUsd * 1e18 / b.nav, a.equityUsd * 1e18 / a.nav)) bandViolated = true;
    }

    function _ok(uint256 lo, uint256 hi, uint256 wb, uint256 wa) internal pure returns (bool) {
        if (wa >= lo && wa <= hi) return true;
        if (wa < lo) return wb < wa;
        return wb > wa;
    }

    function _recordAndCheckDay(PolicyGuard.Snapshot memory b, PolicyGuard.Snapshot memory a) internal {
        uint256 moved;
        for (uint256 i; i < a.usd.length; ++i) {
            moved += a.usd[i] > b.usd[i] ? a.usd[i] - b.usd[i] : b.usd[i] - a.usd[i];
        }
        recs.push(Rec(block.timestamp, moved / 2));
        uint256 sum;
        for (uint256 i; i < recs.length; ++i) {
            if (recs[i].ts + 24 hours > block.timestamp) sum += recs[i].notional;
        }
        if (sum > DAY_CAP) dayCapViolated = true;
    }
}

contract TreasuryInvariantTest is TreasuryFixture {
    DeskHandler handler;

    function setUp() public override {
        super.setUp();
        bytes32[][4] memory ps = [_allow(address(usdg)), _allow(address(vault)), _allow(address(aapl)), _allow(address(nvda))];
        handler = new DeskHandler(
            account, eqSleeve, cashSleeve, [aapl, nvda], [aaplFeed, nvdaFeed], eqKey, cashKey, ps
        );
        aaplFeed.transferOwnership(address(handler));
        nvdaFeed.transferOwnership(address(handler));
        // Start out of band (cash 75%, equity 25%) so the "move toward the band" path is exercised too.
        vm.prank(board);
        account.withdrawToBoard(address(aapl), SEED_AAPL / 2);

        bytes4[] memory sels = new bytes4[](6);
        sels[0] = DeskHandler.buy.selector;
        sels[1] = DeskHandler.sell.selector;
        sels[2] = DeskHandler.deposit.selector;
        sels[3] = DeskHandler.redeem.selector;
        sels[4] = DeskHandler.setFee.selector;
        sels[5] = DeskHandler.warp.selector;
        targetSelector(FuzzSelector(address(handler), sels));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 60
    function invariant_bandsHoldOrImproveAfterEverySuccess() public view {
        assertFalse(handler.bandViolated());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 60
    function invariant_dayCapNeverExceeded() public view {
        assertFalse(handler.dayCapViolated());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 60
    function invariant_boardCanAlwaysWithdraw() public {
        uint256 bal = usdg.balanceOf(address(account));
        uint256 s = vm.snapshotState();
        vm.prank(board);
        account.withdrawToBoard(address(usdg), bal);
        assertEq(usdg.balanceOf(address(account)), 0);
        vm.revertToState(s);
    }

    function afterInvariant() public view {
        console2.log("successes", handler.successes(), "rejections", handler.rejections());
    }
}
