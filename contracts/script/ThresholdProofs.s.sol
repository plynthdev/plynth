// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {ThresholdVerifier} from "../src/consumer/ThresholdVerifier.sol";
import {ThresholdHoldingsVerifier} from "../src/consumer/verifiers/ThresholdHoldingsVerifier.sol";
import {ThresholdSavingsVerifier} from "../src/consumer/verifiers/ThresholdSavingsVerifier.sol";

/// Deploys both threshold-proof UltraHonk verifiers and the ThresholdVerifier wrapper for an existing
/// ShieldedPool. No owner, no admin, nothing to configure: it only reads the pool.
/// Env: THRESHOLD_POOL (the ShieldedPool address).
contract ThresholdProofs is Script {
    function run() external returns (ThresholdVerifier tv) {
        ShieldedPool pool = ShieldedPool(vm.envAddress("THRESHOLD_POOL"));
        vm.startBroadcast();
        tv = deploy(pool);
        vm.stopBroadcast();
        console.log("PLYNTH_THRESHOLD_VERIFIER", address(tv));
    }

    function deploy(ShieldedPool pool) public returns (ThresholdVerifier) {
        return new ThresholdVerifier(
            pool,
            IHonkVerifier(address(new ThresholdHoldingsVerifier())),
            IHonkVerifier(address(new ThresholdSavingsVerifier()))
        );
    }
}
