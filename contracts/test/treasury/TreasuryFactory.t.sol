// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFactory} from "../../src/treasury/TreasuryFactory.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {ITierSource} from "../../src/token/ITierSource.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";

/// Todo 14: TreasuryFactory clones and wires a treasury; the clones behave exactly like directly deployed ones.
contract TreasuryFactoryTest is TreasuryFixture {
    TreasuryFactory factory;
    TreasuryPolicy policyImpl;
    TreasuryAccount accountImpl;
    PeriodClose closeImpl;
    BoardApprovals approvalsImpl;
    address feeTo = makeAddr("feeTo");
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)

    TreasuryAccount fAccount;
    TreasuryPolicy fPolicy;
    PeriodClose fClose;
    BoardApprovals fApprovals;

    function setUp() public override {
        super.setUp();
        TreasuryPolicy.Policy memory none;
        policyImpl = new TreasuryPolicy(address(0), none);
        accountImpl = new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0));
        closeImpl = new PeriodClose(
            TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
        );
        approvalsImpl = new BoardApprovals(address(0), address(0));
        factory = new TreasuryFactory(
            address(policyImpl),
            address(accountImpl),
            address(closeImpl),
            address(approvalsImpl),
            guard,
            IERC20Metadata(address(usdg)),
            feeTo,
            ITierSource(address(0))
        );
    }

    function _deploy(address b) internal returns (address a, address p, address c) {
        (a, p, c) = factory.deploy(abi.encode(_policy()), b);
        fAccount = TreasuryAccount(payable(a));
        fPolicy = TreasuryPolicy(p);
        fClose = PeriodClose(c);
        fApprovals = BoardApprovals(fAccount.approvals());
    }

    // ------------------------------------------------------------ wiring

    function test_deployWiresEverything() public {
        (address pa, address pp, address pc, address papp) = factory.predict(board);
        bytes memory enc = abi.encode(_policy());

        vm.expectEmit(true, true, true, true, address(factory));
        emit TreasuryFactory.TreasuryCreated(board, pa, address(this), pp, pc, papp, keccak256(enc));
        (address a, address p, address c) = factory.deploy(enc, board);
        assertEq(a, pa);
        assertEq(p, pp);
        assertEq(c, pc);

        TreasuryAccount acct = TreasuryAccount(payable(a));
        assertEq(acct.board(), board);
        assertEq(address(acct.policy()), p);
        assertEq(address(acct.guard()), address(guard));
        assertEq(acct.approvals(), papp);
        assertEq(acct.periodClose(), c);

        (TreasuryPolicy.Policy memory cur, bytes32 h, uint32 v) = TreasuryPolicy(p).current();
        assertEq(TreasuryPolicy(p).board(), board);
        assertEq(h, keccak256(enc));
        assertEq(v, 1);
        assertEq(keccak256(abi.encode(cur)), keccak256(enc));

        BoardApprovals ap = BoardApprovals(papp);
        assertEq(ap.board(), board);
        assertEq(ap.guard(), address(guard));
        assertEq(ap.account(), a);

        PeriodClose pcl = PeriodClose(c);
        assertEq(address(pcl.account()), a);
        assertEq(address(pcl.policy()), p);
        assertEq(address(pcl.valuer()), address(valuer));
        assertEq(address(pcl.cash()), address(usdg));
        assertEq(pcl.cashDecimals(), 6);
        assertEq(pcl.feeRecipient(), feeTo);
        assertEq(address(pcl.tiers()), address(0));
        assertEq(pcl.startTime(), block.timestamp);

        assertTrue(factory.isTreasury(a));
        assertEq(factory.treasuryCount(), 1);
        assertEq(factory.treasuryAt(0), a);
        assertEq(factory.nonceOf(board), 1);
    }

    function test_clonesAreEip1167() public {
        (address a, address p, address c) = _deploy(board);
        _assertClone(a, address(accountImpl));
        _assertClone(p, address(policyImpl));
        _assertClone(c, address(closeImpl));
        _assertClone(address(fApprovals), address(approvalsImpl));
    }

    function _assertClone(address clone, address impl) internal view {
        bytes memory expected = abi.encodePacked(
            hex"363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
        assertEq(clone.code, expected);
    }

    // ------------------------------------------------------------ initialization safety

    function test_implementationsAreLocked() public {
        TreasuryPolicy.Policy memory p = _policy();
        vm.expectRevert(TreasuryPolicy.AlreadyInitialized.selector);
        policyImpl.initialize(stranger, p);
        vm.expectRevert(TreasuryAccount.AlreadyInitialized.selector);
        accountImpl.initialize(stranger, policy, guard, address(approvals), address(0));
        vm.expectRevert(PeriodClose.AlreadyInitialized.selector);
        closeImpl.initialize(account, IERC20Metadata(address(usdg)), stranger, ITierSource(address(0)));
        vm.expectRevert(BoardApprovals.AlreadyInitialized.selector);
        approvalsImpl.initialize(stranger, address(guard), stranger);
        assertEq(policyImpl.board(), address(0));
        assertEq(accountImpl.board(), address(0));
    }

    function test_clonesCannotBeReinitialized() public {
        _deploy(board);
        TreasuryPolicy.Policy memory p = _policy();
        vm.startPrank(stranger);
        vm.expectRevert(TreasuryPolicy.AlreadyInitialized.selector);
        fPolicy.initialize(stranger, p);
        vm.expectRevert(TreasuryAccount.AlreadyInitialized.selector);
        fAccount.initialize(stranger, fPolicy, guard, stranger, stranger);
        vm.expectRevert(PeriodClose.AlreadyInitialized.selector);
        fClose.initialize(fAccount, IERC20Metadata(address(usdg)), stranger, ITierSource(address(0)));
        vm.expectRevert(BoardApprovals.AlreadyInitialized.selector);
        fApprovals.initialize(stranger, stranger, stranger);
        vm.stopPrank();
        assertEq(fAccount.board(), board);
    }

    function test_directlyDeployedContractsCannotBeInitialized() public {
        TreasuryPolicy.Policy memory p = _policy();
        vm.expectRevert(TreasuryPolicy.AlreadyInitialized.selector);
        policy.initialize(stranger, p);
        vm.expectRevert(TreasuryAccount.AlreadyInitialized.selector);
        account.initialize(stranger, policy, guard, address(approvals), address(0));
        vm.expectRevert(BoardApprovals.AlreadyInitialized.selector);
        approvals.initialize(stranger, address(guard), stranger);
    }

    function test_factoryKeepsNoRights() public {
        _deploy(board);
        TreasuryPolicy.Policy memory p = _policy();
        vm.startPrank(address(factory));
        vm.expectRevert(TreasuryPolicy.NotBoard.selector);
        fPolicy.propose(p);
        vm.expectRevert(TreasuryAccount.NotBoard.selector);
        fAccount.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        vm.expectRevert(TreasuryAccount.NotBoard.selector);
        fAccount.withdrawToBoard(address(usdg), 1);
        vm.expectRevert(BoardApprovals.NotBoard.selector);
        fApprovals.approve(bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ input checks

    function test_revertInvalidPolicyLeavesNothing() public {
        TreasuryPolicy.Policy memory p = _policy();
        p.cash = TreasuryPolicy.Band(7000, 4000);
        vm.expectRevert(TreasuryPolicy.BadBand.selector);
        factory.deploy(abi.encode(p), board);

        p = _policy();
        p.controller = address(0);
        vm.expectRevert(TreasuryPolicy.ZeroAddress.selector);
        factory.deploy(abi.encode(p), board);

        assertEq(factory.treasuryCount(), 0);
        assertEq(factory.nonceOf(board), 0);
    }

    function test_revertBadEncoding() public {
        bytes memory enc = abi.encode(_policy());
        bytes memory short = new bytes(enc.length - 32);
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.BadPolicyEncoding.selector, short.length));
        factory.deploy(short, board);
        bytes memory long = abi.encodePacked(enc, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.BadPolicyEncoding.selector, long.length));
        factory.deploy(long, board);
        // A bool word that is not 0/1 is rejected by abi.decode.
        bytes memory dirty = enc;
        assembly {
            mstore(add(dirty, add(32, mul(13, 32))), 2) // word 13 = noNewRiskOffHours
        }
        vm.expectRevert();
        factory.deploy(dirty, board);
    }

    function test_revertZeroBoard() public {
        bytes memory enc = abi.encode(_policy());
        vm.expectRevert(TreasuryFactory.ZeroAddress.selector);
        factory.deploy(enc, address(0));
    }

    function test_constructorChecks() public {
        vm.expectRevert(abi.encodeWithSelector(TreasuryFactory.NoCode.selector, stranger));
        new TreasuryFactory(
            stranger, address(accountImpl), address(closeImpl), address(approvalsImpl), guard,
            IERC20Metadata(address(usdg)), feeTo, ITierSource(address(0))
        );
        vm.expectRevert(TreasuryFactory.ZeroAddress.selector);
        new TreasuryFactory(
            address(policyImpl), address(accountImpl), address(closeImpl), address(approvalsImpl),
            PolicyGuard(address(0)), IERC20Metadata(address(usdg)), feeTo, ITierSource(address(0))
        );
    }

    function test_sameBoardTwiceGivesIndependentTreasuries() public {
        (address a1, address p1,) = _deploy(board);
        TreasuryPolicy.Policy memory q = _policy();
        q.periodSeconds = 7 days;
        (address a2, address p2,) = factory.deploy(abi.encode(q), board);
        assertTrue(a1 != a2 && p1 != p2);
        (TreasuryPolicy.Policy memory c1,,) = TreasuryPolicy(p1).current();
        (TreasuryPolicy.Policy memory c2,,) = TreasuryPolicy(p2).current();
        assertEq(c1.periodSeconds, 30 days);
        assertEq(c2.periodSeconds, 7 days);
        assertEq(factory.treasuryCount(), 2);
    }

    function test_frontRunDeployDoesNotBlockBoard() public {
        (address predicted,,,) = factory.predict(board);
        bytes memory enc = abi.encode(_policy());
        vm.prank(stranger);
        (address first,,) = factory.deploy(enc, board); // someone else, same board
        assertEq(first, predicted);
        assertEq(TreasuryAccount(payable(first)).board(), board); // still the board's
        vm.prank(board);
        (address second,,) = factory.deploy(enc, board);
        assertTrue(second != first);
        assertEq(TreasuryAccount(payable(second)).board(), board);
    }

    // ------------------------------------------------------------ the clones work end to end

    function test_cloneTreasuryRunsDesksGuardAndClose() public {
        _deploy(board);
        account = fAccount; // fixture helpers (_buy, _deposit) now act on the clone
        policy = fPolicy;
        approvals = fApprovals;
        vm.startPrank(board);
        fAccount.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        fAccount.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        vm.stopPrank();
        usdg.mint(address(fAccount), FUNDING);
        aapl.mint(address(fAccount), SEED_AAPL);

        _buy(address(nvda), 10_000e6); // inside caps and bands
        _expectCode(4); // R3 per-order cap ($100k)
        vm.prank(eqKey);
        fAccount.execute(EQUITY_DESK, address(eqSleeve), _buyData(address(aapl), 150_000e6), _allow(address(aapl)), 0);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.GuardRejected.selector, 1));
        vm.prank(stranger);
        fAccount.execute(EQUITY_DESK, address(eqSleeve), _buyData(address(aapl), 1e6), _allow(address(aapl)), 0);

        // Period close on the clone: EIP-712 domain is the clone's own address, fee paid from the clone account.
        _warp(T0 + 30 days);
        (, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = fClose.preview();
        (, bytes32 h, uint32 v) = fPolicy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(T0 + 30 days), nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(controllerKey, fClose.digest(c));
        fClose.commit(c, abi.encodePacked(r, s, sv));
        assertEq(fClose.closeCount(), 1);
        uint256 fee = fClose.feeFor(nav, 30 days);
        assertGt(fee, 0);
        assertEq(usdg.balanceOf(feeTo), fee);
        assertEq(fClose.periodStartNav(), nav - fee * 1e12);

        // The clone's domain separator differs from the implementation's (replay across treasuries impossible).
        assertTrue(fClose.digest(c) != closeImpl.digest(c));
    }

    // ------------------------------------------------------------ fuzz

    /// Any band pair the policy contract accepts deploys; any it rejects reverts with the same error.
    function testFuzz_deployMatchesPolicyValidation(uint16 cMin, uint16 cMax, uint16 eMin, uint16 eMax, uint32 period)
        public
    {
        TreasuryPolicy.Policy memory p = _policy();
        p.cash = TreasuryPolicy.Band(cMin % 10_001, cMax % 10_001);
        p.equity = TreasuryPolicy.Band(eMin % 10_001, eMax % 10_001);
        p.periodSeconds = period;
        bytes memory enc = abi.encode(p);
        try policyImpl.validate(p) {
            (address a, address pol,) = factory.deploy(enc, board);
            (, bytes32 h,) = TreasuryPolicy(pol).current();
            assertEq(h, keccak256(enc));
            assertEq(TreasuryAccount(payable(a)).board(), board);
        } catch (bytes memory err) {
            vm.expectRevert(err);
            factory.deploy(enc, board);
        }
    }
}

import {TreasuryFactoryScript} from "../../script/TreasuryFactory.s.sol";

contract TreasuryFactoryScriptTest is TreasuryFixture {
    /// The deploy script's factory creates a working, board-owned treasury with locked implementations.
    function test_scriptDeploysWorkingFactory() public {
        TreasuryFactoryScript s = new TreasuryFactoryScript();
        TreasuryFactoryScript.Deployment memory d =
            s.deploy(registry, valuer, IERC20Metadata(address(usdg)), address(0), 200);
        assertEq(d.guard.maxOpLossBps(), 200);
        assertEq(address(d.factory.guard()), address(d.guard));
        (address a,,) = d.factory.deploy(abi.encode(_policy()), board);
        assertEq(TreasuryAccount(payable(a)).board(), board);
        assertEq(TreasuryPolicy(d.factory.policyImpl()).board(), address(0));
        TreasuryPolicy.Policy memory p = _policy();
        TreasuryPolicy impl = TreasuryPolicy(d.factory.policyImpl());
        vm.expectRevert(TreasuryPolicy.AlreadyInitialized.selector);
        impl.initialize(board, p);
    }
}
