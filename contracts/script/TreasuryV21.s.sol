// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryPolicy} from "../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../src/treasury/PeriodClose.sol";
import {TreasuryFactory} from "../src/treasury/TreasuryFactory.sol";
import {TemplateRegistry} from "../src/treasury/TemplateRegistry.sol";
import {ITierSource} from "../src/interfaces/ITierSource.sol";

/// Treasury v2.1: a partial redeploy of the treasury factory only (review v6 R6-TREAS-1 / -2 / -3).
///
/// What changes: new TreasuryAccount and PeriodClose implementations (the claim-basis low-water mark and the outflow
/// hook) and a new TreasuryFactory that clones them. PrivateSleeve has no factory implementation: each board deploys
/// its own (immutables per account, so no codehash is allow-listed for it), so new private sleeves pick up the
/// R6-TREAS-2 fix from source. The ExceptionInsurancePool binds one factory once (`bindTreasuryFactory`); the v2
/// mainnet deployment has no token stack (deployToken = false), so there is no pool to rebind, and this script
/// refuses to run on a deployment that has one.
///
/// What stays: every consumer, crowd, Hidden Vault and perps contract; the shared PolicyGuard, TemplateRegistry,
/// Receipts, CashSleeve and EquitySleeve; the locked TreasuryPolicy and BoardApprovals implementations (unchanged
/// code, reused by address). Nothing on chain references the factory except the insurance pool (absent) and the
/// FeeRouter's template source (absent), so no setter is needed. The v2 factory (no treasuries on it) stays where
/// it is; its parameters are read from it and copied: guard, cash, fee recipient (OWNER), tiers (none), templates.
///
/// Steps (all from the deployer): deploy the two implementations and the factory (3), allow-list the v2 factory's
/// adapter codehashes while the deployer owns it (2: they apply at once before the hand-over), propose OWNER
/// (1, two-step). OWNER then calls `acceptOwnership()` on the new factory. `checkHandoff` asserts the whole state
/// before anything is broadcast and `verify(file)` re-checks a written file against the chain.
///
/// Env: OWNER (required; must equal the deployment's owner), ALLOW_EOA_OWNER (default 0: OWNER must be a contract),
/// TREASURY_OUT (output file name in app/deployments; default <chainid>-treasury.json; use fork-treasury.json for a
/// fork dry run so the real file is untouched).
contract TreasuryV21 is Script {
    uint256 public constant MAINNET_CHAIN_ID = 4663;
    string public constant VERSION = "2.1";

    error WrongChain(uint256 chainId);
    error OwnerMismatch(address env, address deployment);
    error OwnerNotContract(address owner);
    error TokenStackPresent();
    error DeploymentMismatch(string what);
    error HandoffIncomplete(address target, string what);
    error BadOutName(string name);

    // inputs
    address public owner;
    bool public allowEoaOwner;
    address public deployer;
    TreasuryFactory public legacy;
    string public out;
    address public receipts;
    // deployed
    address public accountImpl;
    address public closeImpl;
    TreasuryFactory public factory;
    uint256 public startBlock;

    function run() external {
        if (block.chainid != MAINNET_CHAIN_ID) revert WrongChain(block.chainid);
        owner = vm.envAddress("OWNER");
        allowEoaOwner = vm.envOr("ALLOW_EOA_OWNER", uint256(0)) == 1;
        out = vm.envOr("TREASURY_OUT", string.concat(vm.toString(block.chainid), "-treasury.json"));
        checkOutName(out);
        _load();
        startBlock = l2BlockNumber(); // the L2 head: log scans start here (NUMBER is the L1 block on Arbitrum)

        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        if (deployer == owner) revert DeploymentMismatch("deployer == OWNER");
        _deploy();
        vm.stopBroadcast();

        checkHandoff();
        _write();
    }

    /// Reads deployments/4663.json and the live v2 factory, and checks they agree.
    function _load() private {
        string memory j = vm.readFile(_path(string.concat(vm.toString(block.chainid), ".json")));
        address depOwner = vm.parseJsonAddress(j, ".owner");
        if (owner != depOwner) revert OwnerMismatch(owner, depOwner);
        if (vm.parseJsonBool(j, ".deployToken")) revert TokenStackPresent(); // an insurance pool binds the v2 factory
        if (!allowEoaOwner && owner.code.length == 0) revert OwnerNotContract(owner);
        legacy = TreasuryFactory(vm.parseJsonAddress(j, ".treasuryFactory"));
        receipts = vm.parseJsonAddress(j, ".receipts");
        if (address(legacy).code.length == 0) revert DeploymentMismatch("no code at the v2 factory");
        if (address(legacy.guard()) != vm.parseJsonAddress(j, ".policyGuard")) revert DeploymentMismatch("guard");
        if (address(legacy.cash()) != vm.parseJsonAddress(j, ".usdg")) revert DeploymentMismatch("cash");
        if (address(legacy.templates()) != vm.parseJsonAddress(j, ".templateRegistry")) {
            revert DeploymentMismatch("templates");
        }
        if (legacy.feeRecipient() != owner) revert DeploymentMismatch("feeRecipient != OWNER");
        if (address(legacy.tiers()) != address(0)) revert DeploymentMismatch("tiers set");
        if (legacy.owner() != owner) revert DeploymentMismatch("v2 factory owner");
        bytes32[] memory want = _shippedHashes(j);
        bytes32[] memory got = legacy.allowedHashes();
        if (!_sameSet(want, got)) revert DeploymentMismatch("v2 allow-list != cashSleeve + equitySleeve");
    }

    /// eth_blockNumber of the RPC (the L2 block; on Arbitrum chains `block.number` is the L1 block).
    function l2BlockNumber() public returns (uint256 n) {
        bytes memory r = vm.rpc("eth_blockNumber", "[]");
        for (uint256 i; i < r.length; ++i) {
            n = (n << 8) | uint8(r[i]);
        }
    }

    function _deploy() private {
        accountImpl =
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0)));
        closeImpl = address(
            new PeriodClose(
                TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
            )
        );
        factory = new TreasuryFactory(
            legacy.policyImpl(),
            accountImpl,
            closeImpl,
            legacy.approvalsImpl(),
            legacy.guard(),
            legacy.cash(),
            legacy.feeRecipient(),
            legacy.tiers(),
            legacy.templates()
        );
        bytes32[] memory h = legacy.allowedHashes();
        for (uint256 i; i < h.length; ++i) {
            factory.setAdapterAllowed(h[i], true); // first-time setup: applies at once while the deployer owns it
        }
        factory.transferOwnership(owner);
    }

    /// The intended state: OWNER pending (deployer still owner) before acceptOwnership, or OWNER owner after it;
    /// every parameter copied from the v2 factory; the allow-list exactly the shipped sleeves; the new
    /// implementations locked and carrying the v2.1 code; the reused implementations the v2 factory's.
    function checkHandoff() public view {
        address o = owner;
        address f = address(factory);
        address cur = factory.owner();
        address pend = factory.pendingOwner();
        _is((cur == deployer && pend == o) || (cur == o && pend == address(0)), f, "factory owner / pendingOwner");
        _is(factory.policyImpl() == legacy.policyImpl(), f, "policyImpl reused");
        _is(factory.approvalsImpl() == legacy.approvalsImpl(), f, "approvalsImpl reused");
        _is(factory.accountImpl() == accountImpl && accountImpl.code.length != 0, f, "accountImpl");
        _is(factory.closeImpl() == closeImpl && closeImpl.code.length != 0, f, "closeImpl");
        _is(accountImpl != legacy.accountImpl() && closeImpl != legacy.closeImpl(), f, "new implementations");
        _is(factory.guard() == legacy.guard(), f, "guard");
        _is(factory.cash() == legacy.cash(), f, "cash");
        _is(factory.feeRecipient() == o, f, "feeRecipient == OWNER");
        _is(address(factory.tiers()) == address(0), f, "tiers");
        _is(factory.templates() == legacy.templates(), f, "templates");
        _is(factory.treasuryCount() == 0, f, "no treasuries yet");
        _is(_sameSet(factory.allowedHashes(), legacy.allowedHashes()), f, "allow-list == v2 allow-list");
        // v2.1 code: the claim-basis low-water mark exists (reverts on the v2 PeriodClose)
        (bool ok,) = closeImpl.staticcall(abi.encodeWithSignature("claimBasisLow()"));
        _is(ok, closeImpl, "closeImpl has claimBasisLow (v2.1)");
        // implementations are locked: an all-zero construction marks them initialized
        _is(address(PeriodClose(closeImpl).account()) == address(0), closeImpl, "closeImpl unbound");
        _is(TreasuryAccount(payable(accountImpl)).board() == address(0), accountImpl, "accountImpl unbound");
        // the v2 factory is untouched (still OWNER's)
        _is(legacy.owner() == o, address(legacy), "v2 factory owner");
    }

    /// Re-checks a written deployment file (default TREASURY_OUT) against the chain; run after the broadcast and
    /// again after OWNER accepts.
    function verify(string memory file) public {
        checkOutName(file);
        string memory j = vm.readFile(_path(file));
        owner = vm.parseJsonAddress(j, ".owner");
        deployer = vm.parseJsonAddress(j, ".deployer");
        factory = TreasuryFactory(vm.parseJsonAddress(j, ".treasuryFactory"));
        accountImpl = vm.parseJsonAddress(j, ".accountImpl");
        closeImpl = vm.parseJsonAddress(j, ".closeImpl");
        address[] memory l = vm.parseJsonAddressArray(j, ".legacyTreasuryFactories");
        legacy = TreasuryFactory(l[0]);
        checkHandoff();
    }

    function _write() private {
        string memory r = "treasuryV21";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeString(r, "treasuryVersion", VERSION);
        vm.serializeUint(r, "treasuryFactoryBlock", startBlock);
        vm.serializeAddress(r, "policyGuard", address(factory.guard()));
        vm.serializeAddress(r, "receipts", receipts);
        vm.serializeAddress(r, "templateRegistry", address(factory.templates()));
        vm.serializeAddress(r, "accountImpl", accountImpl);
        vm.serializeAddress(r, "closeImpl", closeImpl);
        vm.serializeAddress(r, "policyImpl", factory.policyImpl());
        vm.serializeAddress(r, "approvalsImpl", factory.approvalsImpl());
        address[] memory l = new address[](1);
        l[0] = address(legacy);
        vm.serializeAddress(r, "legacyTreasuryFactories", l);
        address[] memory a = new address[](1);
        a[0] = address(factory);
        vm.serializeAddress(r, "acceptOwnership", a);
        vm.serializeAddress(r, "owner", owner);
        vm.serializeAddress(r, "deployer", deployer);
        vm.serializeBool(r, "allowEoaOwner", allowEoaOwner);
        string memory s = vm.serializeAddress(r, "treasuryFactory", address(factory));
        vm.writeJson(s, _path(out));
    }

    function _shippedHashes(string memory j) private view returns (bytes32[] memory h) {
        h = new bytes32[](2);
        h[0] = vm.parseJsonAddress(j, ".cashSleeve").codehash;
        h[1] = vm.parseJsonAddress(j, ".equitySleeve").codehash;
    }

    function _sameSet(bytes32[] memory a, bytes32[] memory b) private pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i; i < a.length; ++i) {
            bool found;
            for (uint256 k; k < b.length; ++k) {
                if (a[i] == b[k]) found = true;
            }
            if (!found) return false;
        }
        return true;
    }

    function _path(string memory name) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../app/deployments/", name);
    }

    /// A plain file name inside app/deployments: letters, digits, '.', '-', '_'; no path, no "..".
    function checkOutName(string memory name) public pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 64 || b[0] == ".") revert BadOutName(name);
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == "."
                || ch == "-" || ch == "_";
            if (!ok) revert BadOutName(name);
        }
    }

    function _is(bool ok, address target, string memory what) private pure {
        if (!ok) revert HandoffIncomplete(target, what);
    }
}
