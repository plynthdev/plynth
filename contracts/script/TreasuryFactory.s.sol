// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../src/core/StockTokenRegistry.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {TreasuryPolicy} from "../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../src/treasury/PeriodClose.sol";
import {BoardApprovals} from "../src/treasury/BoardApprovals.sol";
import {TreasuryFactory} from "../src/treasury/TreasuryFactory.sol";
import {ITierSource} from "../src/interfaces/ITierSource.sol";
import {TemplateRegistry} from "../src/treasury/TemplateRegistry.sol";
import {Receipts} from "../src/treasury/Receipts.sol";

/// Deploys the shared PolicyGuard, the four locked implementations and the TreasuryFactory. Runs after the core
/// deployment: `run()` reads deployments/<chainid>.json (stockTokenRegistry, valuer, usdg) and writes
/// deployments/<chainid>-treasury.json (policyGuard, treasuryFactory, treasuryFactoryBlock), which the API merges.
/// Also deploys the shared Receipts contract (todo 30) and, when TEMPLATE_COMMITTEE is set, the TemplateRegistry
/// the factory builds marketplace treasuries from (written as receipts / templateRegistry).
/// Env: FEE_RECIPIENT (optional, default none), MAX_OP_LOSS_BPS (optional, default 200),
/// TEMPLATE_COMMITTEE (optional, the review Safe; default no marketplace).
contract TreasuryFactoryScript is Script {
    struct Deployment {
        PolicyGuard guard;
        TreasuryFactory factory;
        TemplateRegistry templates;
        Receipts receipts;
    }

    function run() external returns (Deployment memory d) {
        string memory path = string.concat(vm.projectRoot(), "/../app/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        StockTokenRegistry registry = StockTokenRegistry(vm.parseJsonAddress(json, ".stockTokenRegistry"));
        Valuer valuer = Valuer(vm.parseJsonAddress(json, ".valuer"));
        IERC20Metadata usdg = IERC20Metadata(vm.parseJsonAddress(json, ".usdg"));
        address feeTo = vm.envOr("FEE_RECIPIENT", address(0));
        uint16 lossBps = uint16(vm.envOr("MAX_OP_LOSS_BPS", uint256(200)));
        address committee = vm.envOr("TEMPLATE_COMMITTEE", address(0));
        vm.startBroadcast();
        d = _deploy(registry, valuer, usdg, feeTo, lossBps, committee);
        vm.stopBroadcast();
        string memory root = "treasury";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "treasuryFactoryBlock", vm.getBlockNumber());
        vm.serializeAddress(root, "policyGuard", address(d.guard));
        vm.serializeAddress(root, "receipts", address(d.receipts));
        vm.serializeAddress(root, "templateRegistry", address(d.templates));
        string memory out = vm.serializeAddress(root, "treasuryFactory", address(d.factory));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/../app/deployments/", vm.toString(block.chainid), "-treasury.json"));
    }

    /// Same deployment without broadcasting or writing files, for tests.
    function deploy(StockTokenRegistry registry, Valuer valuer, IERC20Metadata usdg, address feeTo, uint16 lossBps)
        external
        returns (Deployment memory)
    {
        return _deploy(registry, valuer, usdg, feeTo, lossBps, address(0));
    }

    function _deploy(
        StockTokenRegistry registry,
        Valuer valuer,
        IERC20Metadata usdg,
        address feeTo,
        uint16 lossBps,
        address committee
    ) internal
        returns (Deployment memory d)
    {
        d.guard = new PolicyGuard(registry, valuer, lossBps);
        TreasuryPolicy.Policy memory none;
        address policyImpl = address(new TreasuryPolicy(address(0), none, 48 hours));
        address accountImpl =
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0)));
        address closeImpl = address(
            new PeriodClose(
                TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
            )
        );
        address approvalsImpl = address(new BoardApprovals(address(0), address(0)));
        if (committee != address(0)) d.templates = new TemplateRegistry(committee, ITierSource(address(0)));
        d.receipts = new Receipts();
        d.factory = new TreasuryFactory(
            policyImpl, accountImpl, closeImpl, approvalsImpl, d.guard, usdg, feeTo, ITierSource(address(0)), d.templates
        );
    }
}
