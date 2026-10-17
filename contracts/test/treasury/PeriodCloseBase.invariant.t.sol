// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {ITierSource} from "../../src/interfaces/ITierSource.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockCashVault} from "../mocks/TreasuryMocks.sol";

/// A sleeve the board writes: reports whatever value it likes (no assets of its own).
contract LyingSleeve {
    uint256 public v;

    function set(uint256 v_) external {
        v = v_;
    }

    function band() external pure returns (uint8) {
        return 0;
    }

    function assets() external pure returns (address[] memory a, uint8[] memory k) {
        return (a, k);
    }

    function valueOf(address) external view returns (uint256, bool) {
        return (v, false);
    }

    function run(bytes calldata) external pure returns (bytes memory) {
        return "";
    }
}

/// Board moves around real PeriodClose snapshots and commits at constant prices: withdrawals of cash and stock
/// (kept or returned, before or after the snapshot), outside deposits, a board sleeve reporting any value. Every
/// value below is computed here, independently of PeriodClose.
contract CloseBaseHandler is Test {
    struct Deps {
        TreasuryAccount account;
        PeriodClose pc;
        MockUSDG usdg;
        MockStockToken aapl;
        MockStockToken nvda;
        MockCashVault vault;
        MockFeed aaplFeed;
        MockFeed nvdaFeed;
        LyingSleeve lying;
        address board;
        address controller;
        uint256 controllerKey;
    }

    TreasuryAccount account;
    PeriodClose pc;
    MockUSDG usdg;
    MockStockToken aapl;
    MockStockToken nvda;
    MockCashVault vault;
    MockFeed aaplFeed;
    MockFeed nvdaFeed;
    LyingSleeve lying;
    address board;
    address controller;
    uint256 controllerKey;

    uint256 public withdrawnSinceSnapUsd; // board withdrawals since the last snapshot (USD at the fixed prices)
    uint256 public baseViolations; // a commit stored a drawdown base below (value at snapshot + withdrawals)
    uint256 public closes;

    constructor(Deps memory d) {
        account = d.account;
        pc = d.pc;
        usdg = d.usdg;
        aapl = d.aapl;
        nvda = d.nvda;
        vault = d.vault;
        aaplFeed = d.aaplFeed;
        nvdaFeed = d.nvdaFeed;
        lying = d.lying;
        board = d.board;
        controller = d.controller;
        controllerKey = d.controllerKey;
    }

    /// Guard-style value of the account's tokens (cash 1:1, vault shares at convertToAssets, stocks at the fixed
    /// prices), never any sleeve's own `valueOf`.
    function tokensUsd() public view returns (uint256) {
        return trustedUsd() + vault.convertToAssets(vault.balanceOf(address(account))) * 1e12;
    }

    /// Cash 1:1 and canonical stocks at the fixed prices only.
    function trustedUsd() public view returns (uint256) {
        return usdg.balanceOf(address(account)) * 1e12 + aapl.balanceOf(address(account)) * 200
            + nvda.balanceOf(address(account)) * 100;
    }

    function _usd(uint8 which, uint256 raw) internal pure returns (uint256) {
        return which % 3 == 0 ? raw * 1e12 : which % 3 == 1 ? raw * 200 : raw * 100;
    }

    function _token(uint8 which) internal view returns (address) {
        return which % 3 == 0 ? address(usdg) : which % 3 == 1 ? address(aapl) : address(nvda);
    }

    function withdraw(uint8 which, uint256 raw) external {
        address t = _token(which);
        uint256 bal = MockUSDG(t).balanceOf(address(account));
        if (bal == 0) return;
        raw = bound(raw, 1, bal);
        vm.prank(board);
        account.withdrawToBoard(t, raw);
        withdrawnSinceSnapUsd += _usd(which, raw);
    }

    function giveBack(uint8 which, uint256 raw) external {
        address t = _token(which);
        uint256 bal = MockUSDG(t).balanceOf(board);
        if (bal == 0) return;
        raw = bound(raw, 1, bal);
        vm.prank(board);
        MockUSDG(t).transfer(address(account), raw);
    }

    function outsideDeposit(uint256 raw) external {
        usdg.mint(address(account), bound(raw, 1, 1e12));
    }

    function lie(uint256 v) external {
        lying.set(bound(v, 0, 1e30));
    }

    /// A full close: snapshot at (or after) the period end, optional board moves between snapshot and commit.
    function close(uint8 between, uint256 raw) external {
        uint256 t = pc.nextPeriodEnd();
        t = (block.timestamp < t ? t : block.timestamp) + 1;
        vm.warp(t);
        aaplFeed.setUpdatedAt(t);
        nvdaFeed.setUpdatedAt(t);
        uint256 floor = tokensUsd() + withdrawnSinceSnapUsd;
        vm.prank(controller);
        (bytes32 posHash, uint256 nav, uint16 cashBps, uint16 eqBps) = pc.snapshot();
        withdrawnSinceSnapUsd = 0;
        if (between % 3 == 1) this.withdraw(between, raw); // counted from this snapshot on
        if (between % 3 == 2) this.giveBack(between, raw);
        _commit(PeriodClose.Close(uint64(block.timestamp), nav, cashBps, eqBps, posHash, keccak256("b"), 0, 0));
        ++closes;
        if (pc.periodStartNav() < floor) ++baseViolations;
    }

    function _commit(PeriodClose.Close memory c) internal {
        (, c.policyHash, c.policyVersion) = account.policy().current();
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(controllerKey, pc.digest(c));
        pc.commitSnapshot(c, abi.encodePacked(r, s, vv));
    }
}

/// R4-TREAS-2 / R4-TREAS-3 invariants (no fee recipient, constant prices):
///   - the insurance claim basis never exceeds the treasury's real cash + canonical stock held now, whatever the
///     board's sleeves report and whatever it moved in for a snapshot and out again;
///   - no board withdrawal ever lowers the drawdown base: each close stores at least the token value at its
///     snapshot plus everything withdrawn to the board since the previous snapshot.
contract PeriodCloseBaseInvariantTest is TreasuryFixture {
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)
    PeriodClose pc;
    CloseBaseHandler handler;

    function _wireMockPeriodClose() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        pc = new PeriodClose(account, IERC20Metadata(address(usdg)), address(0), ITierSource(address(0)));
        LyingSleeve lying = new LyingSleeve();
        vm.startPrank(board);
        account.setPeriodClose(address(pc));
        account.registerDesk("lying", board, _one(address(lying)));
        vm.stopPrank();
        handler = new CloseBaseHandler(
            CloseBaseHandler.Deps(
                account, pc, usdg, aapl, nvda, vault, aaplFeed, nvdaFeed, lying, board, controller, controllerKey
            )
        );
        aaplFeed.transferOwnership(address(handler)); // the handler keeps the feeds fresh across its warps
        nvdaFeed.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 40
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 200
    function invariant_claimBasisNeverAboveRealHoldings() public view {
        assertLe(pc.claimBasisNow(), handler.trustedUsd(), "claim basis above the real cash + stock held");
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 40
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 200
    function invariant_withdrawalsNeverLowerTheDrawdownBase() public view {
        assertEq(handler.baseViolations(), 0, "a close stored a base below snapshot value + withdrawals");
    }
}

