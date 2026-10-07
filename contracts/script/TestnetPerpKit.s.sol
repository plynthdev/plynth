// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {PerpPool} from "../src/perps/PerpPool.sol";
import {PerpMarket} from "../src/perps/PerpMarket.sol";

/// Testnet kit, perps part: one PerpPool over mock USDG and a PerpMarket for each of mTSLA, mAAPL and mSPY,
/// with 200k mock USDG of LP liquidity deposited by the deployer. Runs after TestnetKit: `run()` reads
/// deployments/<chainid>.json and writes deployments/<chainid>-perps.json. The deployer must own MockUSDG.
contract TestnetPerpKit is Script {
    uint256 public constant LP_SEED = 200_000e6;
    string[3] internal SYMBOLS = ["mTSLA", "mAAPL", "mSPY"];

    struct Deployment {
        PerpPool pool;
        PerpMarket[3] markets;
    }

    function run() external returns (Deployment memory d) {
        string memory path = string.concat(vm.projectRoot(), "/../app/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        MockUSDG usdg = MockUSDG(vm.parseJsonAddress(json, ".usdg"));
        Valuer valuer = Valuer(vm.parseJsonAddress(json, ".valuer"));
        address[3] memory tokens;
        for (uint256 i; i < 3; i++) {
            tokens[i] = vm.parseJsonAddress(json, string.concat(".stocks.", SYMBOLS[i], ".token"));
        }
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = _deploy(deployer, usdg, valuer, tokens);
        vm.stopBroadcast();
        _write(d);
    }

    /// Same deployment without broadcasting or writing files, for tests.
    function deployAs(address deployer, MockUSDG usdg, Valuer valuer, address[3] memory tokens)
        external
        returns (Deployment memory d)
    {
        vm.startPrank(deployer);
        d = _deploy(deployer, usdg, valuer, tokens);
        vm.stopPrank();
    }

    function _deploy(address deployer, MockUSDG usdg, Valuer valuer, address[3] memory tokens)
        internal
        returns (Deployment memory d)
    {
        d.pool = new PerpPool(usdg, deployer, 24 hours);
        for (uint256 i; i < 3; i++) {
            d.markets[i] = new PerpMarket(d.pool, valuer, tokens[i], deployer);
            d.pool.addMarket(address(d.markets[i]));
        }
        usdg.mint(deployer, LP_SEED);
        usdg.approve(address(d.pool), LP_SEED);
        d.pool.deposit(LP_SEED, deployer);
    }

    function _write(Deployment memory d) internal {
        string memory root = "perps";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployBlock", vm.getBlockNumber());
        vm.serializeAddress(root, "perpPool", address(d.pool));
        string memory m = "markets";
        string memory mj;
        for (uint256 i; i < 3; i++) {
            mj = vm.serializeAddress(m, SYMBOLS[i], address(d.markets[i]));
        }
        string memory json = vm.serializeString(root, "markets", mj);
        string memory dir = string.concat(vm.projectRoot(), "/../app/deployments");
        vm.writeJson(json, string.concat(dir, "/", vm.toString(block.chainid), "-perps.json"));
    }
}
