// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {PrivateSleeve, IPrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {TransferVerifier} from "../../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../../src/consumer/verifiers/WithdrawVerifier.sol";
import {TreasuryCloseVerifier} from "../../src/consumer/verifiers/TreasuryCloseVerifier.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {ITierSource, Tier} from "../../src/interfaces/ITierSource.sol";

contract MockTiers is ITierSource {
    bool public privateOn = true;

    function set(bool on) external {
        privateOn = on;
    }

    function tierOf(address) external view returns (Tier memory t) {
        t.privateSleeve = privateOn;
        t.weeklyClose = true;
    }
}

/// Private sleeve (todo 31) on the TreasuryFixture book, with the real ShieldedPool, the real treasury_close and
/// withdraw verifiers and proofs from circuits/scripts/treasury-close-fixtures.ts. The fixture's tree is the three
/// shields below, in this order: AAPL 250 | AAPL 200 | NVDA 300 ($120k at $200 / $100), then a public book of
/// USDG 600k + AAPL 1,550 + NVDA 200 ($930k). Total $1.05M: cash 57.1%, equity 42.9%.
contract PrivateSleeveTest is TreasuryFixture {
    bytes32 constant PRIVATE_DESK = "private";
    uint256 constant PERIOD = 30 days;
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)

    address poolOwner = makeAddr("poolOwner");
    address privKey = makeAddr("privKey");
    address feeTo = makeAddr("feeTo");

    ShieldedPool pool;
    PrivateSleeve sleeve;
    PeriodClose pc;
    MockTiers tiers;
    TreasuryCloseVerifier closeVerifier;
    string json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/treasury/fixtures/private_sleeve.json"));
        nvda.setUiMultiplier(1.001e18);
        nvda.mint(address(account), 500e18);

        pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), poolOwner, 48 hours
        );
        vm.startPrank(poolOwner);
        pool.proposeCap(address(aapl), 1e30);
        pool.proposeCap(address(nvda), 1e30);
        vm.stopPrank();
        _warp(block.timestamp + 48 hours);
        pool.applyCap(address(aapl));
        pool.applyCap(address(nvda));

        tiers = new MockTiers();
        closeVerifier = new TreasuryCloseVerifier();
        address[] memory pa = new address[](2);
        pa[0] = address(aapl);
        pa[1] = address(nvda);
        sleeve = new PrivateSleeve(
            address(account), pool, valuer, tiers, IHonkVerifier(address(closeVerifier)), 1, pa
        );
        pc = new PeriodClose(account, IERC20Metadata(address(usdg)), feeTo, ITierSource(address(0)));

        vm.startPrank(board);
        account.setPeriodClose(address(pc));
        account.registerDesk(PRIVATE_DESK, privKey, _one(address(sleeve)));
        account.setPrivateSleeve(address(sleeve), PRIVATE_DESK);
        vm.stopPrank();

        vm.prank(controller);
        sleeve.setKeys(_b(".ownerPk"), keccak256("viewing"));
    }

    // ------------------------------------------------------------ helpers

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _b(string memory key) internal view returns (bytes32) {
        return bytes32(vm.parseJsonUint(json, key));
    }

    function _hex(string memory key) internal view returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }

    function _shieldData(address asset, uint256 raw, bytes32 blinding) internal pure returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(asset, raw);
        return abi.encode(pulls, abi.encode(asset, raw, blinding, bytes("")));
    }

    function _shield(address asset, uint256 raw, bytes32 blinding) internal {
        vm.prank(privKey);
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(asset, raw, blinding), new bytes32[](0), 0);
    }

    /// The fixture's three shields, inserted into the pool tree.
    function _shieldBook() internal {
        for (uint256 i; i < 3; ++i) {
            string memory k = string.concat(".shields[", vm.toString(i), "]");
            _shield(
                vm.parseJsonAddress(json, string.concat(k, ".asset")),
                _u(string.concat(k, ".raw")),
                _b(string.concat(k, ".blinding"))
            );
        }
        _warp(block.timestamp + 1 hours + 1);
        pool.insertPending(10);
        assertEq(pool.currentRoot(), _b(".root"), "fixture tree != pool tree");
    }

    function _private() internal view returns (IPrivateSleeve.PrivateClose memory p) {
        p.proof = _hex(".close.proofHex");
        p.root = _b(".root");
        p.navUsd = _u(".close.navBound");
        for (uint256 i; i < 8; ++i) {
            p.nullifiers[i] = _b(string.concat(".close.nullifiers[", vm.toString(i), "]"));
        }
    }

    function _build(uint256 privateNav) internal view returns (PeriodClose.Close memory c) {
        (, bytes32 posHash, uint256 pubNav,,,) = pc.preview();
        uint256[3] memory band = _bands();
        band[1] += privateNav;
        uint256 nav = pubNav + privateNav;
        (, bytes32 h, uint32 v) = policy.current();
        c = PeriodClose.Close(
            uint64(block.timestamp),
            nav,
            uint16(band[0] * 10_000 / nav),
            uint16(band[1] * 10_000 / nav),
            posHash,
            keccak256("bundle"),
            h,
            v
        );
    }

    function _bands() internal view returns (uint256[3] memory b) {
        (uint256 cashUsd,) = cashSleeve.valueOf(address(account));
        (uint256 eqUsd,) = eqSleeve.valueOf(address(account));
        b[0] = cashUsd;
        b[1] = eqUsd;
    }

    function _sign(PeriodClose.Close memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(controllerKey, pc.digest(c));
        return abi.encodePacked(r, s, v);
    }

    function _ctx(uint16 equityMax) internal view returns (IPrivateSleeve.BookContext memory ctx) {
        (, bytes32 h,) = policy.current();
        ctx.policyHash = h;
        (ctx.pubNav,) = account.navUsd();
        ctx.pubBandUsd = _bands();
        ctx.bandMin = [uint16(4000), 3000, 0];
        ctx.bandMax = [uint16(7000), equityMax, 0];
    }

    function _withdrawPub() internal view returns (ShieldedPool.PublicWithdraw memory w) {
        w.root = _b(".withdraw.root");
        w.nullifier = _b(".withdraw.nullifier");
        w.changeCommitment = _b(".withdraw.changeCommitment");
        w.asset = address(aapl);
        w.amount = _u(".withdraw.amount");
        w.recipient = address(account);
    }

    // ------------------------------------------------------------ fixture == chain

    function test_fixtureMatchesChainContext() public {
        assertEq(vm.parseJsonAddress(json, ".assets[0]"), address(aapl), "aapl address");
        assertEq(vm.parseJsonAddress(json, ".assets[1]"), address(nvda), "nvda address");
        assertEq(vm.parseJsonAddress(json, ".account"), address(account), "account address");
        (, bytes32 h,) = policy.current();
        assertEq(_u(".policyHashModP"), uint256(h) % Poseidon2.P, "policy hash");
        _shieldBook();
        assertEq(sleeve.pricesCommitment(), _b(".pricesCommitment"), "prices commitment");
        (uint256 pubNav,) = account.navUsd();
        assertEq(pubNav, _u(".pubNav"), "public nav");
        uint256[3] memory b = _bands();
        assertEq(b[0], _u(".pubBandUsd[0]"));
        assertEq(b[1], _u(".pubBandUsd[1]"));
    }

    // ------------------------------------------------------------ shield (desk, tier, guard)

    function test_shieldMovesValueIntoBookAtConstantNav() public {
        PolicyGuard.Snapshot memory b = guard.snapshot(address(account));
        _shield(address(aapl), 250e18, bytes32(uint256(0x51)));
        PolicyGuard.Snapshot memory a = guard.snapshot(address(account));
        assertEq(sleeve.bookUsd(), 50_000e18);
        assertEq(a.privateUsd, 50_000e18);
        assertEq(a.nav, b.nav, "nav unchanged");
        assertEq(a.equityUsd, b.equityUsd, "private book counts in the equity band");
        assertEq(a.stockUsd, b.stockUsd, "private book is stock delta");
        assertEq(aapl.balanceOf(address(pool)), 250e18);
        (uint256 pubNav,) = account.navUsd();
        assertEq(pubNav, b.nav - 50_000e18, "account.navUsd is the public part");
        assertEq(guard.dayTotal(address(account)), 50_000e18, "shield counts toward the day cap");
    }

    function testFuzz_shieldKeepsGuardNav(uint256 raw, uint256 priceUsd) public {
        raw = bound(raw, 1, 200e18); // <= $50k: no board ticket needed
        priceUsd = bound(priceUsd, 140, 250); // keeps the book inside its bands
        aaplFeed.set(int256(priceUsd * 1e8));
        PolicyGuard.Snapshot memory b = guard.snapshot(address(account));
        (uint256 usd,) = valuer.value(address(aapl), raw);
        _shield(address(aapl), raw, bytes32(uint256(0x99)));
        PolicyGuard.Snapshot memory a = guard.snapshot(address(account));
        assertEq(a.nav, b.nav);
        assertEq(sleeve.bookUsd(), usd);
        assertEq(a.privateUsd, usd);
    }

    function test_onlyPrivateDeskMayShield() public {
        bytes32 other = "other";
        vm.prank(board);
        account.registerDesk(other, eqKey, _one(address(sleeve)));
        vm.prank(eqKey);
        _expectCode(17);
        account.execute(other, address(sleeve), _shieldData(address(aapl), 1e18, 0), new bytes32[](0), 0);
        // and the equity desk cannot reach the sleeve at all (rule 1)
        vm.prank(eqKey);
        _expectCode(1);
        account.execute(EQUITY_DESK, address(sleeve), _shieldData(address(aapl), 1e18, 0), new bytes32[](0), 0);
    }

    function test_shieldNeedsPrivateSleeveTier() public {
        tiers.set(false);
        vm.prank(privKey);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.TierTooLow.selector, board));
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), 1e18, 0), new bytes32[](0), 0);
        tiers.set(true);
        _shield(address(aapl), 1e18, 0);
    }

    function test_undesignatedSleeveCannotShield() public {
        vm.prank(board);
        account.setPrivateSleeve(address(0), bytes32(0));
        vm.prank(privKey);
        vm.expectRevert(PrivateSleeve.NotDesignated.selector);
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), 1e18, 0), new bytes32[](0), 0);
    }

    function test_shieldIsBoundByGuardCaps() public {
        // $100k + 1 over the per-order cap
        vm.prank(privKey);
        _expectCode(4);
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), 501e18, 0), new bytes32[](0), 0);
    }

    function test_shieldOnlyDeclaredAssets() public {
        vm.prank(privKey);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.NotPrivateAsset.selector, address(usdg)));
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(usdg), 1e6, 0), new bytes32[](0), 0);
    }

    function test_onlyControllerSetsKeys() public {
        vm.expectRevert(PrivateSleeve.NotController.selector);
        sleeve.setKeys(bytes32(uint256(5)), 0);
        vm.prank(controller);
        vm.expectRevert(PrivateSleeve.NotAFieldElement.selector);
        sleeve.setKeys(bytes32(Poseidon2.P), 0);
    }

    function test_replacingSleeveWithOpenBookIsRefused() public {
        _shield(address(aapl), 1e18, 0);
        vm.prank(board);
        vm.expectRevert(TreasuryAccount.PrivateBookOpen.selector);
        account.setPrivateSleeve(address(0), bytes32(0));
    }

    function test_constructorRejectsNonCanonicalOrBadBand() public {
        address[] memory pa = new address[](1);
        pa[0] = address(del); // delisted
        vm.expectRevert(PrivateSleeve.BadAssets.selector);
        new PrivateSleeve(address(account), pool, valuer, tiers, IHonkVerifier(address(closeVerifier)), 1, pa);
        pa[0] = address(aapl);
        vm.expectRevert(PrivateSleeve.BadBand.selector);
        new PrivateSleeve(address(account), pool, valuer, tiers, IHonkVerifier(address(closeVerifier)), 0, pa);
    }

    // ------------------------------------------------------------ proven close

    function test_proofVerifiesForTrueBook() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        assertEq(p.navUsd, 120_000e18);
        PeriodClose.Close memory c = _build(p.navUsd);
        assertEq(c.navUsd, 1_050_000e18);
        assertEq(c.cashBps, 5714);
        assertEq(c.equityBps, 4285);

        vm.expectEmit(true, false, false, true, address(pc));
        emit PeriodClose.PrivateSleeveProven(0, p.root, p.navUsd, _b(".pricesCommitment"), p.nullifiers);
        uint256 g = gasleft();
        pc.commitWithPrivateSleeve(c, _sign(c), p);
        emit log_named_uint("commitWithPrivateSleeve gas", g - gasleft());

        assertEq(pc.closeCount(), 1);
        assertEq(pc.latest().navUsd, 1_050_000e18);
        assertEq(sleeve.bookUsd(), 120_000e18, "book reset to the proven value");
        (uint256 pubAfter,) = account.navUsd();
        assertEq(pc.periodStartNav(), pubAfter + 120_000e18);
        uint256 fee = usdg.balanceOf(feeTo);
        assertEq(fee, pc.feeFor(1_050_000e18, c.periodEnd - pc.startTime()), "fee on total NAV");
    }

    function test_lowerBoundIsWhatWasProven() public {
        // A proof for $100k (fewer than all notes is fine: it is a lower bound) is a different statement: the
        // $120k proof cannot be reused for it.
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        p.navUsd = 100_000e18;
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_inflatedNavFails() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        p.navUsd += 1e18;
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_navMustBePublicPlusProven() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        PeriodClose.Close memory c = _build(p.navUsd);
        c.navUsd += 1;
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.NavMismatch.selector, c.navUsd - 1, c.navUsd));
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_weightsMustCountPrivateInItsBand() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        PeriodClose.Close memory c = _build(p.navUsd);
        c.equityBps = 3142; // public equity only
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.WeightsMismatch.selector, uint16(5714), uint16(4285)));
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_bandBreachFails() public {
        // The same true book against an equity band capped at 40% (it is 42.9%): the verifier refuses, so no
        // close can claim the book is inside a band it is not in.
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        sleeve.checkClose(p, _ctx(6000)); // the real bands pass
        IPrivateSleeve.BookContext memory tight = _ctx(4000);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector);
        sleeve.checkClose(p, tight);
    }

    function test_publicBookChangeInvalidatesProof() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        usdg.mint(address(account), 1e6); // public NAV moved after proving
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_priceMoveInvalidatesProof() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        aaplFeed.set(201e8);
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_staleFeedBlocksProvenClose() public {
        _shieldBook();
        vm.warp(block.timestamp + 2 hours); // feeds stale: prices cannot be pinned
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.HoldAtClose.selector, address(aapl)));
        sleeve.pricesCommitment();
    }

    function test_unknownRootFails() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        p.root = bytes32(uint256(p.root) ^ 1);
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.UnknownRoot.selector, p.root));
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_duplicateNullifierFails() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        p.nullifiers[3] = p.nullifiers[0];
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.DuplicateNullifier.selector, p.nullifiers[0]));
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_badSignatureFails() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        PeriodClose.Close memory c = _build(p.navUsd);
        bytes memory sig = _sign(c);
        c.bundleHash = keccak256("other");
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_plainCommitRefusedWhileBookOpen() public {
        _shield(address(aapl), 1e18, 0);
        (, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = pc.preview();
        (, bytes32 h, uint32 v) = policy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(block.timestamp), nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PrivateBookOpen.selector, 200e18));
        pc.commit(c, sig);
    }

    function test_noPrivateSleeveNoProvenClose() public {
        vm.prank(board);
        account.setPrivateSleeve(address(0), bytes32(0));
        PeriodClose.Close memory c = _build(0);
        IPrivateSleeve.PrivateClose memory p;
        bytes memory sig = _sign(c);
        vm.expectRevert(PeriodClose.NoPrivateSleeve.selector);
        pc.commitWithPrivateSleeve(c, sig, p);
    }

    function test_onCloseOnlyFromPeriodClose() public {
        vm.expectRevert(PrivateSleeve.NotPeriodClose.selector);
        sleeve.onClose(1);
    }

    // ------------------------------------------------------------ unshield / refund (never gated)

    function test_unshieldAlwaysWorks() public {
        _shieldBook();
        // Take away everything that gates other paths: tier, desks, the private-desk designation's desk.
        tiers.set(false);
        vm.startPrank(board);
        account.revokeDesk(PRIVATE_DESK);
        account.revokeDesk(EQUITY_DESK);
        account.revokeDesk(CASH_DESK);
        vm.stopPrank();
        vm.warp(block.timestamp + 3 days); // feeds stale: off-hours
        uint256 before = aapl.balanceOf(address(account));
        vm.prank(stranger); // anyone may submit the controller's proof
        sleeve.unshield(_hex(".withdraw.proofHex"), _withdrawPub());
        assertEq(aapl.balanceOf(address(account)) - before, 200e18, "paid to the account");
        assertEq(sleeve.bookUsd(), 80_000e18, "book debited at the held price");

        // The spent note can no longer be counted at a close.
        _warp(block.timestamp);
        IPrivateSleeve.PrivateClose memory p = _private();
        IPrivateSleeve.BookContext memory ctx = _ctx(6000);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.NullifierSpent.selector, p.nullifiers[1]));
        sleeve.checkClose(p, ctx);
    }

    function test_unshieldOnlyToAccountWithoutFee() public {
        _shieldBook();
        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        w.recipient = stranger;
        vm.expectRevert(PrivateSleeve.BadRecipient.selector);
        sleeve.unshield(_hex(".withdraw.proofHex"), w);
        w = _withdrawPub();
        w.relayerFee = 1;
        vm.expectRevert(PrivateSleeve.FeeNotAllowed.selector);
        sleeve.unshield(_hex(".withdraw.proofHex"), w);
    }

    function test_refundReturnsPendingShieldToAccount() public {
        _shield(address(nvda), 300e18, bytes32(uint256(7)));
        uint256 book = sleeve.bookUsd();
        assertEq(book, 30_000e18);
        tiers.set(false);
        uint256 before = nvda.balanceOf(address(account));
        vm.prank(stranger);
        sleeve.refund(0);
        assertEq(nvda.balanceOf(address(account)) - before, 300e18);
        assertEq(sleeve.bookUsd(), 0);
    }
}
