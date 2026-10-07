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
import {ITierSource, Tier} from "../../src/interfaces/ITierSource.sol";
import {FeeRouter, IStakingRewards, IInsuranceFees, ITemplateFeeSource} from "../../src/token/FeeRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";

contract MockTiers is ITierSource {
    mapping(address => uint8) public prio;
    bool public broken;

    function set(address who, uint8 p) external {
        prio[who] = p;
    }

    function breakIt() external {
        broken = true;
    }

    function tierOf(address who) external view returns (Tier memory t) {
        require(!broken, "down");
        t.templatePriority = prio[who];
    }
}

/// A fee recipient whose hook always reverts: a close must still commit.
contract RevertingFeeHook {
    function onCloseFee(address, uint256) external pure {
        revert("no");
    }
}

/// Todo 30: TemplateRegistry, TreasuryFactory.deployFromTemplate and the template author's 20% of the platform
/// fee, paid through a real PeriodClose clone into a real FeeRouter.
contract MarketplaceTest is TreasuryFixture {
    uint256 constant CONTROLLER_KEY = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)

    address committee = makeAddr("committee");
    address author = makeAddr("author");
    address author2 = makeAddr("author2");
    MockTiers tiers;
    TemplateRegistry reg;
    TreasuryFactory factory;
    FeeRouter router;
    address routerOwner = makeAddr("routerOwner");

    function setUp() public override {
        super.setUp();
        tiers = new MockTiers();
        reg = new TemplateRegistry(committee, tiers);
        // A real FeeRouter: only the author path is exercised, so the PLTH side can be inert addresses.
        address plthAddr = address(0xBEEF);
        bool u0 = address(usdg) < plthAddr;
        PoolKey memory key = u0
            ? PoolKey(address(usdg), plthAddr, 3000, 60, IHooks(address(0)))
            : PoolKey(plthAddr, address(usdg), 3000, 60, IHooks(address(0)));
        router = new FeeRouter(
            IERC20(address(usdg)),
            IERC20(plthAddr),
            IStakingRewards(address(0x5157)),
            IInsuranceFees(address(0x1A5)),
            IPoolManager(address(0xB001)),
            key,
            100,
            1e6,
            routerOwner
        );
        factory = _factory(address(router), reg);
        vm.prank(routerOwner);
        router.setTemplateFees(ITemplateFeeSource(address(factory)), 2000);
    }

    function _factory(address feeTo, TemplateRegistry r) internal returns (TreasuryFactory) {
        TreasuryPolicy.Policy memory none;
        return new TreasuryFactory(
            address(new TreasuryPolicy(address(0), none, 48 hours)),
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0))),
            address(
                new PeriodClose(
                    TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
                )
            ),
            address(new BoardApprovals(address(0), address(0))),
            guard,
            IERC20Metadata(address(usdg)),
            feeTo,
            ITierSource(address(0)),
            r
        );
    }

    function _submitListed(address who) internal returns (uint256 id) {
        bytes32 h = factory.templateHash(_policy());
        vm.prank(who);
        id = reg.submit(h, "ipfs://balanced");
        vm.prank(committee);
        reg.list(id);
    }

    function _close(TreasuryAccount a) internal returns (uint256 fee) {
        vm.startPrank(board); // desks register the sleeves' assets, which is what NAV counts
        a.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        a.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        vm.stopPrank();
        usdg.mint(address(a), FUNDING);
        PeriodClose pc = PeriodClose(a.periodClose());
        TreasuryPolicy pol = a.policy();
        _warp(T0 + 30 days);
        (, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = pc.preview();
        (, bytes32 h, uint32 v) = pol.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(T0 + 30 days), nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(CONTROLLER_KEY, pc.digest(c));
        pc.commit(c, abi.encodePacked(r, s, sv));
        fee = pc.feeFor(nav, 30 days);
    }

    // ------------------------------------------------------------ registry

    function test_submitValidatesAndNumbersFromOne() public {
        vm.startPrank(author);
        vm.expectRevert(TemplateRegistry.BadHash.selector);
        reg.submit(bytes32(0), "ipfs://x");
        vm.expectRevert(TemplateRegistry.BadUri.selector);
        reg.submit(keccak256("t"), "");
        vm.expectRevert(TemplateRegistry.BadUri.selector);
        reg.submit(keccak256("t"), string(new bytes(257)));
        uint256 id = reg.submit(keccak256("t"), "ipfs://x");
        vm.stopPrank();
        assertEq(id, 1);
        TemplateRegistry.Template memory t = reg.get(1);
        assertEq(t.author, author);
        assertEq(t.policyHash, keccak256("t"));
        assertFalse(t.listed);
        assertEq(reg.authorOf(0), address(0));
        assertEq(reg.authorOf(9), address(0));
        vm.expectRevert(abi.encodeWithSelector(TemplateRegistry.UnknownTemplate.selector, 0));
        reg.get(0);
    }

    function test_onlyCommitteeListsAndDelists() public {
        vm.prank(author);
        uint256 id = reg.submit(keccak256("t"), "ipfs://x");
        vm.prank(author);
        vm.expectRevert(TemplateRegistry.NotCommittee.selector);
        reg.list(id);
        vm.startPrank(committee);
        reg.list(id);
        vm.expectRevert(abi.encodeWithSelector(TemplateRegistry.AlreadyListed.selector, id));
        reg.list(id);
        assertTrue(reg.isListed(id));
        reg.delist(id);
        vm.expectRevert(abi.encodeWithSelector(TemplateRegistry.NotListed.selector, id));
        reg.delist(id);
        vm.expectRevert(abi.encodeWithSelector(TemplateRegistry.UnknownTemplate.selector, 7));
        reg.list(7);
        vm.stopPrank();
        assertFalse(reg.isListed(id));
        assertFalse(reg.isListed(0));
    }

    function test_committeeRotationAndAuthorTransfer() public {
        address next = makeAddr("next");
        vm.prank(author);
        vm.expectRevert(TemplateRegistry.NotCommittee.selector);
        reg.setCommittee(next);
        vm.prank(committee);
        reg.setCommittee(next);
        vm.prank(committee);
        vm.expectRevert(TemplateRegistry.NotCommittee.selector);
        reg.list(1);

        vm.prank(author);
        uint256 id = reg.submit(keccak256("t"), "ipfs://x");
        vm.prank(author2);
        vm.expectRevert(TemplateRegistry.NotAuthor.selector);
        reg.transferAuthor(id, author2);
        vm.prank(author);
        reg.transferAuthor(id, author2);
        assertEq(reg.authorOf(id), author2);
    }

    function test_priorityFromStakingTierAndListedIds() public {
        vm.prank(author);
        uint256 a = reg.submit(keccak256("a"), "ipfs://a");
        vm.prank(author2);
        uint256 b = reg.submit(keccak256("b"), "ipfs://b");
        vm.prank(author);
        reg.submit(keccak256("c"), "ipfs://c"); // never listed
        tiers.set(author2, 3);
        assertEq(reg.priorityOf(a), 0);
        assertEq(reg.priorityOf(b), 3);
        vm.startPrank(committee);
        reg.list(b);
        reg.list(a);
        vm.stopPrank();
        uint256[] memory ids = reg.listedIds();
        assertEq(ids.length, 2);
        assertEq(ids[0], a);
        assertEq(ids[1], b);
        tiers.breakIt(); // a failing tier source never blocks the marketplace
        assertEq(reg.priorityOf(b), 0);
        TemplateRegistry noTiers = new TemplateRegistry(committee, ITierSource(address(0)));
        vm.prank(author2);
        uint256 z = noTiers.submit(keccak256("z"), "ipfs://z");
        assertEq(noTiers.priorityOf(z), 0);
    }

    // ------------------------------------------------------------ factory

    function test_deployFromListedTemplateRecordsTemplateId() public {
        uint256 id = _submitListed(author);
        TreasuryPolicy.Policy memory p = _policy();
        (address a,, address c) = factory.deployFromTemplate(abi.encode(p), board, id);
        assertEq(factory.templateOf(a), id);
        assertEq(factory.accountOfClose(c), a);
        (address acct, address auth) = factory.closeAuthor(c);
        assertEq(acct, a);
        assertEq(auth, author);
        // A plain deploy records no template.
        (address a2,, address c2) = factory.deploy(abi.encode(p), board);
        assertEq(factory.templateOf(a2), 0);
        (acct, auth) = factory.closeAuthor(c2);
        assertEq(acct, a2);
        assertEq(auth, address(0));
        (acct, auth) = factory.closeAuthor(stranger);
        assertEq(acct, address(0));
    }

    function test_templateHashIgnoresOnlyTheController() public {
        uint256 id = _submitListed(author);
        TreasuryPolicy.Policy memory p = _policy();
        p.controller = makeAddr("otherController"); // same template, another controller key: accepted
        (address a,,) = factory.deployFromTemplate(abi.encode(p), board, id);
        assertEq(factory.templateOf(a), id);
        p.perOrderCapUsd += 1; // any other change: rejected
        bytes32 want = reg.policyHashOf(id);
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.TemplateMismatch.selector, want, factory.templateHash(p)));
        factory.deployFromTemplate(abi.encode(p), board, id);
    }

    function test_unlistedOrDelistedTemplateCannotBeUsed() public {
        bytes32 h = factory.templateHash(_policy());
        vm.prank(author);
        uint256 id = reg.submit(h, "ipfs://x");
        bytes memory enc = abi.encode(_policy());
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.TemplateNotListed.selector, id));
        factory.deployFromTemplate(enc, board, id);
        vm.prank(committee);
        reg.list(id);
        factory.deployFromTemplate(enc, board, id);
        vm.prank(committee);
        reg.delist(id);
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.TemplateNotListed.selector, id));
        factory.deployFromTemplate(enc, board, id);
        TreasuryFactory bare = _factory(address(0), TemplateRegistry(address(0)));
        vm.expectRevert(TreasuryFactory.NoTemplates.selector);
        bare.deployFromTemplate(enc, board, id);
    }

    // ------------------------------------------------------------ author's fee share

    function test_templatedTreasuryPaysAuthorTwentyPercentOfItsFee() public {
        uint256 id = _submitListed(author);
        (address a,,) = factory.deployFromTemplate(abi.encode(_policy()), board, id);
        uint256 fee = _close(TreasuryAccount(payable(a)));
        assertGt(fee, 0);
        assertEq(usdg.balanceOf(address(router)), fee);
        assertEq(router.authorOwed(author), fee * 2000 / 10_000);
        assertEq(router.authorReserved(), fee * 2000 / 10_000);
        vm.prank(author);
        router.claimAuthor();
        assertEq(usdg.balanceOf(author), fee * 2000 / 10_000);
    }

    function test_plainTreasuryPaysNoAuthor() public {
        _submitListed(author);
        (address a,,) = factory.deploy(abi.encode(_policy()), board);
        uint256 fee = _close(TreasuryAccount(payable(a)));
        assertEq(usdg.balanceOf(address(router)), fee);
        assertEq(router.authorReserved(), 0);
    }

    function test_delistingKeepsPayingExistingTreasuries() public {
        uint256 id = _submitListed(author);
        (address a,,) = factory.deployFromTemplate(abi.encode(_policy()), board, id);
        vm.prank(committee);
        reg.delist(id);
        uint256 fee = _close(TreasuryAccount(payable(a)));
        assertEq(router.authorOwed(author), fee * 2000 / 10_000);
    }

    function test_revertingFeeHookNeverBlocksAClose() public {
        RevertingFeeHook hook = new RevertingFeeHook();
        TreasuryFactory f = _factory(address(hook), reg);
        (address a,,) = f.deploy(abi.encode(_policy()), board);
        uint256 fee = _close(TreasuryAccount(payable(a)));
        assertEq(PeriodClose(TreasuryAccount(payable(a)).periodClose()).closeCount(), 1);
        assertEq(usdg.balanceOf(address(hook)), fee);
    }
}
