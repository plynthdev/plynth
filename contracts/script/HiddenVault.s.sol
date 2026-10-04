// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {TransferVerifier} from "../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/consumer/verifiers/WithdrawVerifier.sol";

/// Deploys the Hidden Vault (both verifiers + ShieldedPool) and optionally hands it to CrowdBuy.
///
/// Caps: on Robinhood Chain mainnet (4663) every cap stays 0, and this script refuses to propose a non-zero
/// one: the vault needs a human audit before any cap rises (then through the 48h timelock, by the owner).
/// Elsewhere (testnet 46630, forks, anvil) the listed caps are proposed; they apply after 48h via applyCap.
///
/// Env: HIDDEN_CROWD (optional CrowdBuy; pool.setCrowd is called, CrowdBuy.setShieldedPool is left to its
/// owner), HIDDEN_CAP_ASSETS / HIDDEN_CAP_RAWS (optional comma-separated address[] / uint256[] of equal length).
contract HiddenVault is Script {
    uint256 public constant MAINNET = 4663;

    error MainnetCapMustBeZero(address asset, uint256 cap);
    error LengthMismatch();

    function run() external returns (ShieldedPool pool) {
        address crowd = vm.envOr("HIDDEN_CROWD", address(0));
        address[] memory assets = vm.envOr("HIDDEN_CAP_ASSETS", ",", new address[](0));
        uint256[] memory caps = vm.envOr("HIDDEN_CAP_RAWS", ",", new uint256[](0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        pool = deploy(deployer, crowd, assets, caps);
        vm.stopBroadcast();
        console.log("PLYNTH_HIDDEN_VAULT", address(pool));
    }

    /// `owner` must be the account sending the following calls (the broadcaster, or this script in tests).
    function deploy(address owner, address crowd, address[] memory assets, uint256[] memory caps)
        public
        returns (ShieldedPool pool)
    {
        if (assets.length != caps.length) revert LengthMismatch();
        if (block.chainid == MAINNET) {
            for (uint256 i; i < caps.length; ++i) {
                if (caps[i] != 0) revert MainnetCapMustBeZero(assets[i], caps[i]);
            }
        }
        pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), owner
        );
        if (crowd != address(0)) pool.setCrowd(crowd);
        for (uint256 i; i < assets.length; ++i) {
            if (caps[i] != 0) pool.proposeCap(assets[i], caps[i]);
        }
    }
}
