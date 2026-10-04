// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault, ICanonicalRegistry} from "../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon, IShieldedDeposit} from "../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../src/consumer/StealthClaims.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../src/consumer/ShieldedTrade.sol";
import {TransferVerifier} from "../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/consumer/verifiers/WithdrawVerifier.sol";
import {SwapVerifier} from "../src/consumer/verifiers/SwapVerifier.sol";
import {SettleVerifier} from "../src/consumer/verifiers/SettleVerifier.sol";
import {IERC5564Announcer} from "../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../src/interfaces/IERC6538Registry.sol";
import {StockRouter} from "../src/core/StockRouter.sol";
import {JitterBeacon} from "../src/core/JitterBeacon.sol";

/// The consumer stack on top of the testnet kit: JitterBeacon (keeper = KEEPER_ADDRESS), SavingsVault, CrowdBuy,
/// StealthClaims on the canonical ERC-5564 Announcer / ERC-6538 Registry, and the Hidden Vault (ShieldedPool +
/// verifiers + ShieldedTrade, wired to CrowdBuy). Run after TestnetKit.s.sol: it reads deployments/<chainid>.json
/// (usdg, stockTokenRegistry, stockRouter, stocks) and writes the same file back with the consumer addresses
/// added, which is what the indexer, keeper, relayer and API read.
///
/// Hidden Vault caps: proposed for USDG and every kit stock (they apply 48h later via applyCap, by anyone). On
/// Robinhood Chain mainnet (4663) nothing is proposed: caps stay 0 until an external audit.
/// Env: KEEPER_ADDRESS (required), MIN_CROWD (default 3), HIDDEN_USDG_CAP (raw, default 1e12 = 1M USDG),
/// HIDDEN_STOCK_CAP (raw, default 1e24).
contract TestnetConsumer is Script {
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address public constant REGISTRY_6538 = 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538;
    uint16 public constant SLIPPAGE_BPS = 100;
    uint256 public constant MAINNET = 4663;

    struct Out {
        address beacon;
        address vault;
        address crowd;
        address stealthClaims;
        address shieldedPool;
        address shieldedTrade;
        uint64 genesis;
    }

    error MissingCanonical(address what);

    function run() external returns (Out memory o) {
        string memory path = string.concat(vm.projectRoot(), "/../app/deployments/", vm.toString(block.chainid), ".json");
        string memory kit = vm.readFile(path);
        for (uint256 i; i < 3; ++i) {
            address c = [PERMIT2, ANNOUNCER, REGISTRY_6538][i];
            if (c.code.length == 0) revert MissingCanonical(c);
        }
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        o = _deploy(kit, owner, keeper);
        vm.stopBroadcast();

        string memory r = "consumer";
        vm.serializeJson(r, kit);
        vm.serializeAddress(r, "jitterBeacon", o.beacon);
        vm.serializeAddress(r, "savingsVault", o.vault);
        vm.serializeAddress(r, "crowdBuy", o.crowd);
        vm.serializeAddress(r, "stealthClaims", o.stealthClaims);
        vm.serializeAddress(r, "erc5564Announcer", ANNOUNCER);
        vm.serializeAddress(r, "erc6538Registry", REGISTRY_6538);
        vm.serializeAddress(r, "shieldedPool", o.shieldedPool);
        vm.serializeAddress(r, "shieldedTrade", o.shieldedTrade);
        vm.serializeAddress(r, "permit2", PERMIT2);
        string memory json = vm.serializeUint(r, "genesis", o.genesis);
        vm.writeJson(json, path);
    }

    function _deploy(string memory kit, address owner, address keeper) private returns (Out memory o) {
        IERC20 usdg = IERC20(vm.parseJsonAddress(kit, ".usdg"));
        StockRouter router = StockRouter(vm.parseJsonAddress(kit, ".stockRouter"));
        // The kit's own beacon is keyed to its deployer; the consumer gets one keyed to the keeper.
        o.beacon = address(new JitterBeacon(keeper, owner));
        SavingsVault vault = new SavingsVault(
            usdg, PERMIT2, ICanonicalRegistry(vm.parseJsonAddress(kit, ".stockTokenRegistry")), owner, keeper
        );
        o.vault = address(vault);
        uint256 ts = vm.getBlockTimestamp();
        o.genesis = uint64(ts - (ts % 1 days)); // windows line up with UTC days
        CrowdBuy crowd = new CrowdBuy(
            vault,
            router,
            IExecuteBeacon(o.beacon),
            uint32(vm.envOr("MIN_CROWD", uint256(3))),
            SLIPPAGE_BPS,
            o.genesis,
            owner,
            keeper
        );
        o.crowd = address(crowd);
        vault.setCrowd(o.crowd);
        StealthClaims sc = new StealthClaims(o.crowd, IERC5564Announcer(ANNOUNCER), IERC6538Registry(REGISTRY_6538));
        crowd.setStealthClaims(sc);
        o.stealthClaims = address(sc);

        (o.shieldedPool, o.shieldedTrade) = _hidden(owner, crowd, router);
        if (block.chainid != MAINNET) _caps(ShieldedPool(o.shieldedPool), kit, address(usdg));
    }

    function _hidden(address owner, CrowdBuy crowd, StockRouter router) private returns (address, address) {
        ShieldedPool pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), owner
        );
        pool.setCrowd(address(crowd));
        // ShieldedTrade must be set before the first deposit; park adapters are proposed later by the owner
        // (48h timelock), as in HiddenVault.s.sol.
        ShieldedTrade trade = new ShieldedTrade(
            pool, IHonkVerifier(address(new SwapVerifier())), IHonkVerifier(address(new SettleVerifier())), router, owner
        );
        pool.setTrade(address(trade));
        crowd.setShieldedPool(IShieldedDeposit(address(pool)));
        return (address(pool), address(trade));
    }

    function _caps(ShieldedPool pool, string memory kit, address usdg) private {
        pool.proposeCap(usdg, vm.envOr("HIDDEN_USDG_CAP", uint256(1e12)));
        string[] memory syms = vm.parseJsonKeys(kit, ".stocks");
        uint256 stockCap = vm.envOr("HIDDEN_STOCK_CAP", uint256(1e24));
        for (uint256 i; i < syms.length; ++i) {
            pool.proposeCap(vm.parseJsonAddress(kit, string.concat(".stocks.", syms[i], ".token")), stockCap);
        }
    }
}
