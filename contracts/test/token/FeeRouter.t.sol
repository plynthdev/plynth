// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenFixture} from "./TokenFixture.sol";
import {FeeRouter, IStakingRewards, IInsuranceFees, ITemplateFeeSource} from "../../src/token/FeeRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";

/// Stands in for TreasuryFactory.closeAuthor: which account a PeriodClose belongs to, and its template author.
contract MockTemplateSource is ITemplateFeeSource {
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

contract FeeRouterTest is TokenFixture {
    address lp = makeAddr("lp");
    address sink = makeAddr("sink");

    function setUp() public override {
        super.setUp();
        _stake(alice, 1000e18);
        _nextHour();
    }

    function _fees(uint256 amount) internal {
        usdg.mint(address(router), amount);
    }

    function _lpDeposit(uint256 amount) internal {
        usdg.mint(lp, amount);
        vm.startPrank(lp);
        usdg.approve(address(insurance), amount);
        insurance.deposit(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ split

    function test_pushSplitsHalfBuybackHalfInsurance() public {
        _lpDeposit(1000e6);
        _fees(1000e6);
        router.push();
        assertEq(usdg.balanceOf(address(insurance)), 1000e6 + 500e6);
        assertEq(usdg.balanceOf(address(router)), 0);
        // 500 USDG buys PLTH at 20 PLTH/USDG less the 0.3% pool fee, all queued for stakers
        uint256 bought = 500e6 * 9970 / 10_000 * PLTH_PER_USDG_RAW;
        assertEq(staking.queued(1), bought);
        assertEq(plth.balanceOf(address(router)), 0);
        _nextHour();
        assertApproxEqAbs(staking.earned(alice)[1], bought, 1);
    }

    function test_noDepositorsSendsInsuranceHalfToStakers() public {
        _fees(1000e6);
        router.push();
        assertEq(usdg.balanceOf(address(insurance)), 0);
        assertEq(staking.queued(0), 500e6);
        _nextHour();
        assertEq(staking.earned(alice)[0], 500e6);
    }

    MockTemplateSource src;
    address closeT = makeAddr("closeT"); // PeriodClose of a templated treasury
    address acctT = makeAddr("acctT");
    address closeP = makeAddr("closeP"); // PeriodClose of a plain treasury
    address acctP = makeAddr("acctP");

    function _templates(uint16 bps) internal {
        src = new MockTemplateSource();
        src.set(closeT, acctT, sink);
        src.set(closeP, acctP, address(0));
        vm.prank(owner);
        router.setTemplateFees(ITemplateFeeSource(address(src)), bps);
    }

    /// A PeriodClose pays `amount` then tells the router (as PeriodClose._fee does).
    function _closeFee(address close, address account, uint256 amount) internal {
        _fees(amount);
        vm.prank(close);
        router.onCloseFee(account, amount);
    }

    function test_authorShareCarvedOutBeforeSplit() public {
        _templates(2000); // 20%
        _lpDeposit(1e6);
        _closeFee(closeT, acctT, 1000e6);
        assertEq(router.authorOwed(sink), 200e6);
        router.push();
        // 800 left: 400 to insurance, 400 buys PLTH; the author's 200 stays set aside
        assertEq(usdg.balanceOf(address(insurance)), 1e6 + 400e6);
        assertEq(usdg.balanceOf(address(router)), 200e6);
        vm.prank(sink);
        assertEq(router.claimAuthor(), 200e6);
        assertEq(usdg.balanceOf(sink), 200e6);
        assertEq(usdg.balanceOf(address(router)), 0);
        vm.prank(sink);
        vm.expectRevert(FeeRouter.NothingOwed.selector);
        router.claimAuthor();
    }

    function test_onlyTemplatedTreasuriesPayAuthors() public {
        _templates(2000);
        _closeFee(closeP, acctP, 1000e6); // no template: nothing set aside
        _fees(500e6); // plain transfer, no hook: nothing set aside
        assertEq(router.authorReserved(), 0);
        router.push();
        assertEq(usdg.balanceOf(sink), 0);
    }

    function test_onCloseFeeRejectsCallersThatAreNotFactoryCloses() public {
        _templates(2000);
        _fees(1000e6);
        vm.prank(alice); // not a PeriodClose the factory made
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotTreasuryClose.selector, alice));
        router.onCloseFee(acctT, 1000e6);
        vm.prank(closeT); // a real close cannot claim for another account
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotTreasuryClose.selector, closeT));
        router.onCloseFee(acctP, 1000e6);
    }

    function test_onCloseFeeNeverSetsAsideMoreThanArrived() public {
        _templates(2000);
        vm.prank(closeT); // claims a fee that never arrived
        router.onCloseFee(acctT, 1000e6);
        assertEq(router.authorReserved(), 0);
        _fees(10e6);
        vm.prank(closeT);
        router.onCloseFee(acctT, 1000e6); // overstated: capped at what is free
        assertEq(router.authorReserved(), 10e6);
    }

    function test_authorShareOffWithoutSource() public {
        _closeFee(closeT, acctT, 1000e6); // no source set: no-op, no revert
        assertEq(router.authorReserved(), 0);
    }

    function test_templateFeeBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeRouter.BadParams.selector);
        router.setTemplateFees(ITemplateFeeSource(address(1)), 2001);
        vm.expectRevert(FeeRouter.BadParams.selector);
        router.setTemplateFees(ITemplateFeeSource(address(0)), 1);
        router.setTemplateFees(ITemplateFeeSource(address(0)), 0);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        router.setTemplateFees(ITemplateFeeSource(address(1)), 100);
    }

    // ------------------------------------------------------------ rate limit

    function test_pushAtMostHourly() public {
        _fees(10e6);
        router.push();
        uint64 next = uint64(block.timestamp + 1 hours);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.TooSoon.selector, next));
        vm.prank(bob);
        router.push();
        vm.warp(next);
        vm.prank(bob); // anyone
        router.push();
        assertEq(router.lastPush(), next);
    }

    // ------------------------------------------------------------ buy bounds

    function test_perPushCapCarriesTheRest() public {
        vm.prank(owner);
        router.setBuyParams(100, 100e6);
        _lpDeposit(1e6);
        _fees(1000e6);
        router.push();
        assertEq(router.buyCarry(), 400e6);
        assertEq(usdg.balanceOf(address(router)), 400e6);
        // Next push: carry is not re-split; no new fees -> spends another 100 from the carry only.
        uint256 insBefore = usdg.balanceOf(address(insurance));
        vm.warp(block.timestamp + 1 hours);
        router.push();
        assertEq(router.buyCarry(), 300e6);
        assertEq(usdg.balanceOf(address(insurance)), insBefore);
    }

    function test_buyBreachingSlippageIsSkippedNotReverted() public {
        _lpDeposit(1e6);
        _setFillRate(PLTH_PER_USDG_RAW * 1e18 * 95 / 100); // fills 5% worse than spot
        _fees(1000e6);
        vm.expectEmit(false, false, false, false, address(router));
        emit FeeRouter.BuySkipped(0, 0);
        router.push();
        assertEq(router.buyCarry(), 500e6, "carried");
        assertEq(usdg.balanceOf(address(insurance)), 1e6 + 500e6, "insurance leg still paid");
        assertEq(staking.queued(1), 0);
        // Pool back in line: the carry is spent next hour.
        _setFillRate(PLTH_PER_USDG_RAW * 1e18);
        vm.warp(block.timestamp + 1 hours);
        router.push();
        assertEq(router.buyCarry(), 0);
        assertGt(staking.queued(1), 0);
    }

    function test_quoteMinOutFromSpot() public view {
        // 1 USDG at spot = 20 PLTH; 1% slippage bound
        assertApproxEqRel(router.quoteMinOut(1e6), 20e18 * 99 / 100, 1e9);
    }

    function test_uninitialisedPoolNeverBuys() public {
        pm.setSqrtPrice(key, 0);
        assertEq(router.quoteMinOut(1e6), type(uint256).max);
        _fees(10e6);
        router.push();
        assertEq(router.buyCarry(), 5e6);
    }

    function test_buyParamsBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeRouter.BadParams.selector);
        router.setBuyParams(501, 1);
        vm.expectRevert(FeeRouter.BadParams.selector);
        router.setBuyParams(100, 0);
        vm.stopPrank();
    }

    function test_callbacksGated() public {
        vm.expectRevert(FeeRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(uint256(1), uint256(0)));
        vm.expectRevert(FeeRouter.NotSelf.selector);
        router.buyExternal(1, 0);
    }

    function test_constructorRejectsWrongPool() public {
        PoolKey memory bad = PoolKey(address(usdg), address(0xBEEF), 3000, 60, IHooks(address(0)));
        vm.expectRevert(FeeRouter.BadPoolKey.selector);
        new FeeRouter(
            IERC20(address(usdg)),
            IERC20(address(plth)),
            IStakingRewards(address(staking)),
            IInsuranceFees(address(insurance)),
            IPoolManager(address(pm)),
            bad,
            100,
            1,
            owner
        );
    }

    /// Fees of any size: everything is accounted for (author + insurance or stakers + spent + carry).
    function testFuzz_pushConservesUsdg(uint64 fees, uint16 authorBps, bool depositors, uint64 cap) public {
        fees = uint64(bound(fees, 0, 1e15));
        authorBps = uint16(bound(authorBps, 0, 2000));
        cap = uint64(bound(cap, 1, 1e15));
        _templates(authorBps);
        vm.prank(owner);
        router.setBuyParams(100, cap);
        if (depositors) _lpDeposit(1e6);
        uint256 insBefore = usdg.balanceOf(address(insurance));
        _closeFee(closeT, acctT, fees);
        router.push();
        uint256 toIns = usdg.balanceOf(address(insurance)) - insBefore;
        uint256 toStakers = staking.queued(0);
        uint256 spent = usdg.balanceOf(address(pm)) - 1_000_000e6;
        assertEq(router.authorOwed(sink), uint256(fees) * authorBps / 10_000);
        assertEq(router.authorOwed(sink) + toIns + toStakers + spent + router.buyCarry(), fees);
        assertEq(usdg.balanceOf(address(router)), router.buyCarry() + router.authorReserved());
        assertTrue(depositors ? toStakers == 0 : toIns == 0);
    }
}
