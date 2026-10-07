// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TreasuryFixture} from "../treasury/TreasuryFixture.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// Random LP deposits (incl. dust), withdrawal requests, withdrawals, router fees (incl. 1 wei), claims (incl.
/// ones that take the whole pool or leave dust), direct donations and time. The handler is the FeeRouter.
///
/// Checked after every action:
///   - no deposit (or any other non-claim action) lowers anyone else's value, active or withdrawing, and no
///     LP's deposit, request or withdrawal raises anyone else's beyond rounding;
///   - router fees never change a withdrawing LP's value;
///   - a withdrawal pays min(value at request, value at withdraw): at most the request value, and the
///     request value less exactly the claim losses since (fees after the request never reach it);
///   - the pool can always pay what it owes (pending + active values <= free assets);
/// and at the end of every run, when everyone has left, nothing is left in the pool beyond owed claims.
contract InsuranceHandler is Test {
    ExceptionInsurancePool immutable pool;
    MockUSDG immutable usdg;
    address immutable minter; // MockUSDG's owner
    TreasuryAccount immutable account;
    address immutable board;
    address immutable controller;
    address immutable committee;
    address[4] public actors;

    uint256 public valueTaken; // a non-claim action lowered someone else's value
    uint256 public valueGifted; // an LP action raised someone else's value beyond rounding
    uint256 public feesToWithdrawers; // router fees changed a withdrawing LP's value
    uint256 public overpaid; // a withdrawal paid more than its value at request
    uint256 public offGhost; // a withdrawal differed from request value x claim losses
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public claims;
    uint256 public refusedDeposits;

    mapping(address => uint256) public ghostRequested; // value at request (sum)
    mapping(address => uint256) public ghostScaled; // value at request x every claim loss since
    mapping(address => uint256) public ghostSteps; // requests + losses since the last withdrawal (rounding budget)
    mapping(address => uint64) public ghostEpoch;

    constructor(ExceptionInsurancePool pool_, MockUSDG usdg_, address minter_, TreasuryAccount account_, address board_, address controller_, address committee_) {
        (pool, usdg, account, board, controller, committee) = (pool_, usdg_, account_, board_, controller_, committee_);
        minter = minter_;
        for (uint256 i; i < 4; i++) {
            actors[i] = makeAddr(string.concat("lp", vm.toString(i)));
            vm.prank(actors[i]);
            usdg.approve(address(pool), type(uint256).max);
        }
        usdg.approve(address(pool), type(uint256).max);
    }

    function _values() internal view returns (uint256[4] memory v) {
        for (uint256 i; i < 4; i++) v[i] = pool.previewRedeem(pool.sharesOf(actors[i])) + pool.pendingValueOf(actors[i]);
    }

    function _noneLowered(uint256[4] memory before, uint256 except) internal {
        uint256[4] memory afterV = _values();
        for (uint256 i; i < 4; i++) if (i != except && afterV[i] < before[i]) valueTaken++;
    }

    /// Another LP's deposit, request or withdrawal moves nobody else's value beyond rounding: a withdrawer's
    /// exit is no step in the share price a newcomer could buy in front of.
    /// The slack allows the actor's own rounding (at most one share, whose price is `sharePrice`) to land
    /// with the others.
    function _noneMoved(uint256[4] memory before, uint256 except, uint256 sharePrice) internal {
        _noneLowered(before, except);
        uint256[4] memory afterV = _values();
        for (uint256 i; i < 4; i++) {
            if (i != except && afterV[i] > before[i] + 16 + sharePrice + before[i] / 1e12) valueGifted++;
        }
    }

    function _sharePrice() internal view returns (uint256) {
        return (pool.activeAssets() + 1) / (pool.activeShares() + 1e6) + 1;
    }

    function _pendingValues() internal view returns (uint256[4] memory v) {
        for (uint256 i; i < 4; i++) v[i] = pool.pendingValueOf(actors[i]);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        usdg.mint(to, amount);
    }

    // ------------------------------------------------------------ actions

    function deposit(uint256 a, uint256 amount, bool dust) external {
        uint256 i = a % 4;
        amount = dust ? bound(amount, 1, 1000) : bound(amount, 1e6, 1e12);
        _mint(actors[i], amount);
        uint256[4] memory before = _values();
        uint256 price = _sharePrice();
        vm.prank(actors[i]);
        try pool.deposit(amount) returns (uint256) {
            deposits++;
        } catch {
            refusedDeposits++;
        }
        _noneMoved(before, i, price);
    }

    function requestWithdraw(uint256 a, uint256 frac) external {
        uint256 i = a % 4;
        address who = actors[i];
        uint256 s = pool.sharesOf(who);
        if (s == 0) return;
        s = s * bound(frac, 1, 100) / 100;
        if (s == 0) return;
        uint256 value = pool.previewRedeem(s); // 0: worthless shares just leave
        if (ghostEpoch[who] != pool.pendingEpoch()) (ghostRequested[who], ghostScaled[who], ghostSteps[who]) = (0, 0, 0); // wiped
        uint256[4] memory before = _values();
        uint256 price = _sharePrice();
        vm.prank(who);
        pool.requestWithdraw(s);
        ghostRequested[who] += value;
        ghostScaled[who] += value;
        ghostSteps[who] += 2;
        ghostEpoch[who] = pool.pendingEpoch();
        _noneMoved(before, i, price);
    }

    function withdraw(uint256 a) external {
        uint256 i = a % 4;
        address who = actors[i];
        (,, uint64 readyAt) = pool.pendingOf(who);
        if (readyAt == 0) return;
        if (block.timestamp < readyAt) vm.warp(readyAt);
        uint256[4] memory before = _values();
        uint256 price = _sharePrice();
        vm.prank(who);
        try pool.withdraw() returns (uint256 out) {
            withdrawals++;
            if (out > ghostRequested[who]) overpaid++;
            uint256 g = ghostScaled[who];
            uint256 tol = ghostSteps[who] + 2;
            if (out + tol < g || out > g + tol) offGhost++;
            (ghostRequested[who], ghostScaled[who], ghostSteps[who]) = (0, 0, 0);
        } catch {}
        _noneMoved(before, i, price);
    }

    /// Router fees, from 1 wei up.
    function fees(uint256 amount) external {
        amount = bound(amount, 1, 1e11);
        _mint(address(this), amount);
        uint256[4] memory before = _values();
        uint256[4] memory pendingBefore = _pendingValues();
        pool.depositFees(amount);
        _noneLowered(before, type(uint256).max);
        uint256[4] memory pendingAfter = _pendingValues();
        for (uint256 i; i < 4; i++) if (pendingAfter[i] != pendingBefore[i]) feesToWithdrawers++;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e9);
        uint256[4] memory before = _values();
        _mint(address(pool), amount);
        _noneLowered(before, type(uint256).max);
    }

    function returnIdle() external {
        uint256[4] memory before = _values();
        pool.returnIdle();
        _noneLowered(before, type(uint256).max);
    }

    /// A claim of `bps` of the free assets (up to 2x: takes everything and stays owed), or a dust-leaving one.
    function claim(uint256 bps, bool leaveDust) external {
        uint256 free = pool.freeAssets();
        uint256 amount = leaveDust && free > 3 ? free - 3 : Math.mulDiv(free + 1e6, bound(bps, 1, 20_000), 10_000);
        if (amount == 0) return;
        vm.prank(board);
        uint256 id = pool.fileClaim(account, amount * 1e12, keccak256("drill"));
        vm.prank(committee);
        pool.approveClaim(id);
        uint256 fBefore = pool.freeAssets();
        vm.prank(controller);
        pool.attest(id, true);
        uint256 fAfter = pool.freeAssets();
        claims++;
        for (uint256 i; i < 4; i++) {
            address who = actors[i];
            if (ghostScaled[who] == 0) continue;
            ghostScaled[who] = fBefore == 0 ? 0 : Math.mulDiv(ghostScaled[who], fAfter, fBefore);
            ghostSteps[who] += 1;
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 20 days));
    }

    /// Everyone leaves (used at the end of a run).
    function exitAll() external {
        for (uint256 i; i < 4; i++) {
            uint256 s = pool.sharesOf(actors[i]);
            if (s != 0) {
                vm.prank(actors[i]);
                pool.requestWithdraw(s);
            }
        }
        vm.warp(block.timestamp + pool.WITHDRAW_DELAY());
        for (uint256 i; i < 4; i++) {
            (,, uint64 readyAt) = pool.pendingOf(actors[i]);
            if (readyAt == 0) continue;
            vm.prank(actors[i]);
            pool.withdraw();
        }
        pool.returnIdle();
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
contract ExceptionInsurancePoolInvariantTest is TreasuryFixture {
    ExceptionInsurancePool pool;
    InsuranceHandler handler;
    address committee = makeAddr("committee");

    function setUp() public override {
        super.setUp();
        pool = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, 14 days);
        handler = new InsuranceHandler(pool, usdg, address(this), account, board, controller, committee);
        pool.bindFeeRouter(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = InsuranceHandler.deposit.selector;
        sel[1] = InsuranceHandler.requestWithdraw.selector;
        sel[2] = InsuranceHandler.withdraw.selector;
        sel[3] = InsuranceHandler.fees.selector;
        sel[4] = InsuranceHandler.donate.selector;
        sel[5] = InsuranceHandler.returnIdle.selector;
        sel[6] = InsuranceHandler.claim.selector;
        sel[7] = InsuranceHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function invariant_noActionButAClaimLowersAnyonesValue() public view {
        assertEq(handler.valueTaken(), 0);
    }

    function invariant_noLpActionShiftsValueBetweenOthers() public view {
        assertEq(handler.valueGifted(), 0);
    }

    function invariant_feesNeverReachWithdrawers() public view {
        assertEq(handler.feesToWithdrawers(), 0);
    }

    function invariant_withdrawalPaysMinOfRequestAndNow() public view {
        assertEq(handler.overpaid(), 0, "more than the value at request");
        assertEq(handler.offGhost(), 0, "not the request value less the claim losses since");
    }

    function invariant_poolCanPayEveryone() public view {
        assertLe(pool.pendingAssets(), pool.freeAssets());
        uint256 pending;
        uint256 active;
        for (uint256 i; i < 4; i++) {
            address who = handler.actorAt(i);
            pending += pool.pendingValueOf(who);
            active += pool.previewRedeem(pool.sharesOf(who));
        }
        assertLe(pending, pool.pendingAssets());
        assertLe(active, pool.activeAssets());
    }

    /// Nothing is ever stuck: once every LP has left, the pool holds nothing beyond what claims are owed.
    function afterInvariant() public {
        handler.exitAll();
        assertEq(pool.pendingAssets(), 0);
        assertEq(pool.pendingUnits(), 0);
        assertEq(pool.activeShares(), 0);
        assertEq(pool.freeAssets(), 0, "ownerless USDG left in the pool");
    }
}
