// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeRouter, ITemplateFeeSource} from "../../src/token/FeeRouter.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockERC20, MockPoolManager} from "../mocks/MockV4.sol";
import {TokenFixture} from "./TokenFixture.sol";

/// Stands in for TreasuryFactory.closeAuthor: which account a PeriodClose belongs to, and its template author.
contract InvTemplateSource is ITemplateFeeSource {
    mapping(address => address) public acct;
    mapping(address => address) public auth;

    function set(address close, address account, address author) external {
        acct[close] = account;
        auth[close] = author;
    }

    function closeAuthor(address close) external view returns (address, address) {
        return (acct[close], auth[close]);
    }
}

/// Random fee inflows (plain and templated PeriodClose fees), keeper observations and pushes, pool price and
/// fill moves, insurance LPs entering and leaving (which flips where the insurance half goes and makes the pool
/// hand idle USDG back), author claims and owner buy-parameter changes. Every USDG that enters or leaves the
/// router is tallied independently of the router's own counters, and each push is checked against the split
/// rules using the router's state read just before it.
contract RouterHandler is Test {
    bytes32 constant PUSHED = keccak256("Pushed(uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
    bytes32 constant RETURNED = keccak256("SurplusReturned(address,uint256)");
    uint256 constant BPS = 10_000;

    FeeRouter immutable router;
    PlinthStaking immutable staking;
    ExceptionInsurancePool immutable insurance;
    MockPoolManager immutable pm;
    MockERC20 immutable usdg;
    IERC20 immutable plth;
    address immutable owner;
    PoolKey key;
    uint256 immutable basePlthPerUsdgX18;

    address[3] public closes;
    address[3] public accounts;
    address[2] public authors;
    address[2] public lps;

    // ghost tallies (USDG raw)
    uint256 public feesIn; // minted to the router as fees
    uint256 public returnedIn; // handed back by the insurance pool
    uint256 public toStakers;
    uint256 public toInsurance;
    uint256 public spent; // USDG paid into the pool for PLTH
    uint256 public plthBought;
    uint256 public authorAccrued;
    uint256 public authorClaimed;
    uint256 public lpIn;
    uint256 public lpOut;

    // violations
    bool public splitViolated;
    bool public buyOverspent;
    bool public unaccountedAfterPush;
    bool public authorOverCut;
    bool public minOutViolated;
    bool public rogueCloseAccepted;
    bool public pushTooSoonAccepted;
    bool public insuranceRuleViolated;

    uint256 public pushes;
    uint256 public buys;
    uint256 public skippedBuys;
    uint256 public insuranceDeposits;
    uint256 public authorCuts;

    constructor(
        FeeRouter router_,
        PlinthStaking staking_,
        ExceptionInsurancePool insurance_,
        MockPoolManager pm_,
        MockERC20 usdg_,
        IERC20 plth_,
        address owner_,
        PoolKey memory key_,
        uint256 basePrice,
        InvTemplateSource source
    ) {
        router = router_;
        staking = staking_;
        insurance = insurance_;
        pm = pm_;
        usdg = usdg_;
        plth = plth_;
        owner = owner_;
        key = key_;
        basePlthPerUsdgX18 = basePrice;
        closes = [makeAddr("closeA"), makeAddr("closeB"), makeAddr("closeC")];
        accounts = [makeAddr("acctA"), makeAddr("acctB"), makeAddr("acctC")];
        authors = [makeAddr("authorA"), makeAddr("authorC")];
        lps = [makeAddr("lp0"), makeAddr("lp1")];
        // closeB's treasury was not built from a template: no author share
        source.set(closes[0], accounts[0], authors[0]);
        source.set(closes[1], accounts[1], address(0));
        source.set(closes[2], accounts[2], authors[1]);
    }

    // ------------------------------------------------------------ inflows

    function fee(uint256 amount) external {
        amount = bound(amount, 1, 50_000e6);
        usdg.mint(address(router), amount);
        feesIn += amount;
    }

    /// A PeriodClose pays its fee here and reports it; the author cut may be at most authorBps of it.
    function closeFee(uint256 seed, uint256 amount) external {
        uint256 i = seed % 3;
        amount = bound(amount, 1, 50_000e6);
        usdg.mint(address(router), amount);
        feesIn += amount;
        uint256 reserved0 = router.authorReserved();
        vm.prank(closes[i]);
        router.onCloseFee(accounts[i], amount);
        uint256 cut = router.authorReserved() - reserved0;
        if (cut > amount * router.authorBps() / BPS) authorOverCut = true;
        if (i == 1 && cut != 0) authorOverCut = true;
        authorAccrued += cut;
        if (cut != 0) ++authorCuts;
    }

    /// Someone who is not a PeriodClose of that account must be refused.
    function rogueCloseFee(uint256 seed, uint256 amount) external {
        uint256 i = seed % 3;
        amount = bound(amount, 1, 50_000e6);
        vm.prank(makeAddr("rogue"));
        try router.onCloseFee(accounts[i], amount) {
            rogueCloseAccepted = true;
        } catch {}
        // a real close claiming for the wrong account must be refused too
        vm.prank(closes[i]);
        try router.onCloseFee(accounts[(i + 1) % 3], amount) {
            rogueCloseAccepted = true;
        } catch {}
    }

    function claimAuthor(uint256 seed) external {
        address a = authors[seed % 2];
        uint256 owed = router.authorOwed(a);
        if (owed == 0) return;
        uint256 b0 = usdg.balanceOf(a);
        vm.prank(a);
        router.claimAuthor();
        if (usdg.balanceOf(a) - b0 != owed) authorOverCut = true;
        authorClaimed += owed;
    }

    // ------------------------------------------------------------ keeper

    function observe() external {
        vm.prank(owner);
        router.observe();
    }

    /// Router and counterparty state read just before a push.
    struct Pre {
        uint256 keeperMinOut;
        uint256 rest;
        uint256 sincePush;
        uint256 slice;
        uint256 cap;
        uint256 wantSpend;
        uint256 floorOut;
        bool insuranceLive;
        uint256 pmUsdg;
        uint256 stakingUsdg;
        uint256 stakingPlth;
    }

    /// The keeper's normal cycle: observe, wait 10 to 90 minutes, push.
    function keeperCycle(uint256 waitSecs, uint256 minOutSeed) external {
        vm.prank(owner);
        router.observe();
        vm.warp(block.timestamp + bound(waitSecs, 10 minutes, 90 minutes));
        uint64 last = router.lastPush();
        if (last != 0 && block.timestamp < last + router.PUSH_INTERVAL()) vm.warp(last + router.PUSH_INTERVAL());
        this.push(minOutSeed);
    }

    function push(uint256 minOutSeed) public {
        uint64 last = router.lastPush();
        if (last != 0 && block.timestamp < last + router.PUSH_INTERVAL()) {
            vm.prank(owner);
            try router.push(0) {
                pushTooSoonAccepted = true;
            } catch {}
            return;
        }
        Pre memory pre;
        // keeper minOut: usually 0, sometimes an impossible floor that must make the buy skip, not revert
        pre.keeperMinOut = minOutSeed % 8 == 0 ? type(uint128).max : 0;
        uint256 carry0 = router.buyCarry();
        pre.sincePush = router.authorSincePush();
        pre.rest = usdg.balanceOf(address(router)) - carry0 - router.authorReserved();
        pre.slice = carry0 + pre.rest / 2;
        pre.cap = router.perPushCap();
        pre.wantSpend = pre.slice < pre.cap ? pre.slice : pre.cap;
        pre.floorOut = pre.wantSpend == 0 ? 0 : router.buyMinOut(pre.wantSpend, pre.keeperMinOut);
        pre.insuranceLive = insurance.activeShares() != 0 || insurance.queuedOwed() != 0;
        pre.pmUsdg = usdg.balanceOf(address(pm));
        pre.stakingUsdg = usdg.balanceOf(address(staking));
        pre.stakingPlth = plth.balanceOf(address(staking));

        vm.recordLogs();
        vm.prank(owner);
        router.push(pre.keeperMinOut);
        (uint256[7] memory p, uint256 back) = _readPushLogs(vm.getRecordedLogs());
        ++pushes;
        // p = [fees, toAuthor, toInsurance, usdgToStakers, usdgSpent, plthBought, buyCarry]
        returnedIn += back;
        toInsurance += p[2];
        toStakers += p[3];
        spent += p[4];
        plthBought += p[5];
        if (p[4] == 0) ++skippedBuys;
        else ++buys;
        if (p[2] != 0) ++insuranceDeposits;
        _checkSplit(pre, p);
        _checkBalancesAfterPush(pre, p, back);
    }

    function _readPushLogs(Vm.Log[] memory logs) internal view returns (uint256[7] memory p, uint256 back) {
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter == address(router) && logs[j].topics[0] == PUSHED) {
                p = abi.decode(logs[j].data, (uint256[7]));
            } else if (logs[j].emitter == address(insurance) && logs[j].topics[0] == RETURNED) {
                if (address(uint160(uint256(logs[j].topics[1]))) == address(router)) {
                    back += abi.decode(logs[j].data, (uint256));
                }
            }
        }
    }

    function _checkSplit(Pre memory pre, uint256[7] memory p) internal {
        // the insurance half (rest - rest/2) goes exactly one way; the buy half is rest/2
        if (p[0] != pre.rest + pre.sincePush || p[1] != pre.sincePush) splitViolated = true;
        if (p[2] + p[3] != pre.rest - pre.rest / 2) splitViolated = true;
        if (p[2] != 0 && p[3] != 0) splitViolated = true;
        if (!pre.insuranceLive && p[2] != 0) insuranceRuleViolated = true;
        // the buyback spends at most its slice and the per-push cap, and carries the rest exactly
        if (p[4] > pre.cap || p[4] > pre.slice) buyOverspent = true;
        if (p[4] != 0 && p[4] != pre.wantSpend) buyOverspent = true;
        if (p[6] != pre.slice - p[4] || router.buyCarry() != p[6]) buyOverspent = true;
        // a buy that happened met the bound computed before the push (keeper / spot / observation)
        if (p[5] != 0 && p[5] < pre.floorOut) minOutViolated = true;
        if (p[4] != 0 && pre.keeperMinOut == type(uint128).max) minOutViolated = true;
    }

    function _checkBalancesAfterPush(Pre memory pre, uint256[7] memory p, uint256 back) internal {
        // the counterparties received exactly what the event says
        if (usdg.balanceOf(address(pm)) - pre.pmUsdg != p[4]) unaccountedAfterPush = true;
        if (usdg.balanceOf(address(staking)) - pre.stakingUsdg != p[3]) unaccountedAfterPush = true;
        if (plth.balanceOf(address(staking)) - pre.stakingPlth != p[5]) unaccountedAfterPush = true;
        // after a push the router holds only the carry, the authors' set-aside and anything the pool handed
        // back during the push; it never keeps PLTH
        if (usdg.balanceOf(address(router)) != router.buyCarry() + router.authorReserved() + back) {
            unaccountedAfterPush = true;
        }
        if (router.authorSincePush() != 0) unaccountedAfterPush = true;
        if (plth.balanceOf(address(router)) != 0) unaccountedAfterPush = true;
    }

    // ------------------------------------------------------------ market

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 3 hours));
    }

    /// Moves the pool (fill rate and slot0 together) within +-3% of the start price.
    function movePrice(uint256 bps) external {
        uint256 r = basePlthPerUsdgX18 * bound(bps, 9_700, 10_300) / BPS;
        _setFillRate(r);
        _setSpot(r);
    }

    /// Moves only slot0 (a manipulated spot) or only the fill rate (the swap fills worse than spot).
    function skewPrice(uint256 bps, bool spotOnly) external {
        uint256 r = basePlthPerUsdgX18 * bound(bps, 8_000, 12_000) / BPS;
        if (spotOnly) _setSpot(r);
        else _setFillRate(r);
    }

    /// A swap that stops at its price limit (partial fill) must make the buy skip and carry.
    function setFill(uint256 bps) external {
        pm.setFillBps(bps % 4 == 0 ? bound(bps, 9_000, 9_999) : 10_000);
    }

    function setBuyParams(uint256 slip, uint256 cap) external {
        vm.prank(owner);
        router.setBuyParams(uint16(bound(slip, 0, 500)), bound(cap, 1, 30_000e6));
    }

    // ------------------------------------------------------------ insurance LPs

    function lpDeposit(uint256 seed, uint256 amount) external {
        address lp = lps[seed % 2];
        amount = bound(amount, 1e6, 100_000e6);
        usdg.mint(lp, amount);
        uint256 r0 = usdg.balanceOf(address(router));
        vm.startPrank(lp);
        usdg.approve(address(insurance), amount);
        try insurance.deposit(amount) {
            lpIn += amount;
        } catch {}
        vm.stopPrank();
        returnedIn += usdg.balanceOf(address(router)) - r0;
    }

    function lpRequestWithdraw(uint256 seed, uint256 pct) external {
        address lp = lps[seed % 2];
        uint256 shares = insurance.sharesOf(lp) * bound(pct, 1, 100) / 100;
        if (shares == 0) return;
        uint256 r0 = usdg.balanceOf(address(router));
        vm.prank(lp);
        insurance.requestWithdraw(shares);
        returnedIn += usdg.balanceOf(address(router)) - r0;
    }

    function lpWithdraw(uint256 seed) external {
        address lp = lps[seed % 2];
        (uint256 req,, uint64 readyAt) = insurance.pendingOf(lp);
        if (req == 0 || block.timestamp < readyAt) return;
        uint256 r0 = usdg.balanceOf(address(router));
        uint256 l0 = usdg.balanceOf(lp);
        vm.prank(lp);
        try insurance.withdraw() {
            lpOut += usdg.balanceOf(lp) - l0;
        } catch {}
        returnedIn += usdg.balanceOf(address(router)) - r0;
    }

    /// Lets withdrawals mature (the pool's delay is 14 days).
    function longWarp() external {
        vm.warp(block.timestamp + 14 days);
    }

    // ------------------------------------------------------------ internal

    function _setFillRate(uint256 plthPerUsdgX18) internal {
        bool u0 = key.currency0 == address(usdg);
        pm.setRate(key, u0 ? plthPerUsdgX18 : 1e36 / plthPerUsdgX18);
    }

    function _setSpot(uint256 plthPerUsdgX18) internal {
        bool u0 = key.currency0 == address(usdg);
        uint256 r = u0 ? plthPerUsdgX18 : 1e36 / plthPerUsdgX18;
        pm.setSqrtPrice(key, uint160(Math.sqrt(Math.mulDiv(r, 1 << 192, 1e18))));
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 500
/// forge-config: ci.invariant.fail-on-revert = true
contract FeeRouterInvariantTest is TokenFixture {
    RouterHandler handler;
    uint256 pmUsdg0;
    uint256 stakingPlth0;

    function setUp() public override {
        super.setUp();
        _stake(alice, 1000e18); // stakers exist, so notifyReward has someone to pay
        _nextHour();
        InvTemplateSource source = new InvTemplateSource();
        vm.startPrank(owner);
        router.setTemplateFees(source, 2000);
        router.observe();
        vm.stopPrank();
        vm.warp(block.timestamp + 10 minutes);

        handler = new RouterHandler(
            router, staking, insurance, pm, usdg, IERC20(address(plth)), owner, key, PLTH_PER_USDG_RAW * 1e18, source
        );
        pmUsdg0 = usdg.balanceOf(address(pm));
        stakingPlth0 = plth.balanceOf(address(staking));

        bytes4[] memory sels = new bytes4[](18);
        sels[0] = RouterHandler.fee.selector;
        sels[1] = RouterHandler.closeFee.selector;
        sels[2] = RouterHandler.rogueCloseFee.selector;
        sels[3] = RouterHandler.claimAuthor.selector;
        sels[4] = RouterHandler.observe.selector;
        sels[5] = RouterHandler.push.selector;
        sels[6] = RouterHandler.push.selector; // pushes twice as likely
        sels[7] = RouterHandler.warp.selector;
        sels[8] = RouterHandler.movePrice.selector;
        sels[9] = RouterHandler.skewPrice.selector;
        sels[10] = RouterHandler.setFill.selector;
        sels[11] = RouterHandler.setBuyParams.selector;
        sels[12] = RouterHandler.lpDeposit.selector;
        sels[13] = RouterHandler.lpRequestWithdraw.selector;
        sels[14] = RouterHandler.lpWithdraw.selector;
        sels[15] = RouterHandler.longWarp.selector;
        sels[16] = RouterHandler.keeperCycle.selector;
        sels[17] = RouterHandler.keeperCycle.selector;
        targetSelector(FuzzSelector(address(handler), sels));
        targetContract(address(handler));
    }

    /// Conservation: every USDG the router received (fees + pool hand-backs) was sent to stakers, the
    /// insurance pool, the PLTH buyback or a template author, or is still held.
    function invariant_usdgConserved() public view {
        assertEq(
            handler.feesIn() + handler.returnedIn(),
            handler.toStakers() + handler.toInsurance() + handler.spent() + handler.authorClaimed()
                + usdg.balanceOf(address(router)),
            "router usdg in != out + held"
        );
    }

    /// The other side of the ledger, read from the counterparties' balances (nobody claims staking rewards
    /// and no insurance claim is filed in this suite, so each balance moves only by the router's flows).
    function invariant_counterpartiesReceivedExactly() public view {
        assertEq(usdg.balanceOf(address(staking)), handler.toStakers(), "staking usdg");
        assertEq(plth.balanceOf(address(staking)), stakingPlth0 + handler.plthBought(), "staking plth");
        assertEq(usdg.balanceOf(address(pm)), pmUsdg0 + handler.spent(), "pool usdg");
        assertEq(
            usdg.balanceOf(address(insurance)),
            handler.lpIn() + handler.toInsurance() - handler.lpOut() - handler.returnedIn(),
            "insurance usdg"
        );
    }

    /// The router never holds USDG it cannot account for, and the author ledger is exact.
    function invariant_noUnaccountedUsdg() public view {
        uint256 bal = usdg.balanceOf(address(router));
        assertGe(bal, router.buyCarry() + router.authorReserved(), "carry + reserve not covered");
        assertEq(
            router.authorOwed(handler.authors(0)) + router.authorOwed(handler.authors(1)),
            router.authorReserved(),
            "author ledger"
        );
        assertEq(router.authorReserved(), handler.authorAccrued() - handler.authorClaimed(), "author accrual");
        assertEq(plth.balanceOf(address(router)), 0, "router holds PLTH");
        assertFalse(handler.unaccountedAfterPush(), "unaccounted after a push");
    }

    /// No split exceeds its configured share: the author cut <= authorBps of its fee (none without a template),
    /// the insurance half is exactly the other half and goes one way, insurance gets nothing while no LP is active
    /// and no claim is owed, and nobody outside a PeriodClose can claim a cut.
    function invariant_splitsWithinConfiguredBps() public view {
        assertFalse(handler.splitViolated(), "split");
        assertFalse(handler.authorOverCut(), "author cut");
        assertFalse(handler.insuranceRuleViolated(), "insurance with no active LP");
        assertFalse(handler.rogueCloseAccepted(), "rogue close fee");
    }

    /// The buyback spends at most min(per-push cap, carry + half of this push's fees), carries the rest exactly,
    /// never fills below the keeper / spot / observation floor, and pushes stay at most once per hour.
    function invariant_buybackWithinSlice() public view {
        assertFalse(handler.buyOverspent(), "buy over slice");
        assertFalse(handler.minOutViolated(), "buy under floor");
        assertFalse(handler.pushTooSoonAccepted(), "push inside the interval");
    }

    function afterInvariant() public view {
        console2.log("pushes", handler.pushes(), "buys", handler.buys());
        console2.log("skippedBuys", handler.skippedBuys(), "insuranceDeposits", handler.insuranceDeposits());
        console2.log("authorCuts", handler.authorCuts(), "returnedIn", handler.returnedIn());
    }

    /// The handler reaches a buy, a skipped buy, an insurance deposit, an author cut and claim, and a hand-back.
    function test_handlerReachesEveryPath() public {
        handler.closeFee(0, 10_000e6); // author A gets 20%
        handler.push(1); // no LP: insurance half to stakers; buy at the observed price
        assertEq(handler.buys(), 1);
        handler.claimAuthor(0);
        assertEq(handler.authorClaimed(), 2000e6);
        handler.lpDeposit(0, 50_000e6);
        handler.fee(1000e6);
        handler.warp(3 hours);
        handler.push(0); // observation too old now: buy skipped and carried; insurance half deposited
        assertEq(handler.skippedBuys(), 1);
        assertEq(handler.insuranceDeposits(), 1);
        handler.lpRequestWithdraw(0, 100); // last active LP leaves: the pool hands idle USDG back
        handler.longWarp();
        handler.lpWithdraw(0);
        assertGt(handler.returnedIn(), 0);
        assertGt(handler.lpOut(), 0);
        invariant_usdgConserved();
        invariant_counterpartiesReceivedExactly();
        invariant_noUnaccountedUsdg();
        invariant_splitsWithinConfiguredBps();
        invariant_buybackWithinSlice();
    }
}
