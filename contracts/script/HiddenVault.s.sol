// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {TransferVerifier} from "../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/consumer/verifiers/WithdrawVerifier.sol";
import {SwapVerifier} from "../src/consumer/verifiers/SwapVerifier.sol";
import {SettleVerifier} from "../src/consumer/verifiers/SettleVerifier.sol";
import {ShieldedTrade} from "../src/consumer/ShieldedTrade.sol";
import {IParkAdapter} from "../src/consumer/park/IParkAdapter.sol";
import {ERC4626Park} from "../src/consumer/park/ERC4626Park.sol";
import {MorphoBluePark} from "../src/consumer/park/MorphoBluePark.sol";
import {IMorphoBlue, MarketParams} from "../src/consumer/park/IMorphoBlue.sol";
import {StockRouter} from "../src/core/StockRouter.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// Deploys the Hidden Vault (both verifiers + ShieldedPool) and optionally hands it to CrowdBuy.
///
/// Caps: on Robinhood Chain mainnet (4663) every cap stays 0, and this script refuses to propose a non-zero
/// one: the vault needs a human audit before any cap rises (then through the 48h timelock, by the owner).
/// Elsewhere (testnet 46630, forks, anvil) the listed caps are proposed; they apply after 48h via applyCap.
///
/// Private sell/buy/park (todo 25): with HIDDEN_STOCK_ROUTER set, ShieldedTrade (swap + settle verifiers) is
/// deployed and set on the pool (this must happen before the first deposit). Park adapters are then proposed
/// (48h timelock, `applyAdapter` by anyone afterwards): one ERC4626Park per HIDDEN_PARK_VAULTS entry (e.g.
/// Steakhouse USDG 0xBeEff033F34C046626B8D0A041844C5d1A5409dd on 4663) and one MorphoBluePark per
/// HIDDEN_MORPHO_MARKETS id on the Morpho Blue core (HIDDEN_MORPHO, default the 4663 core). Park share tokens
/// still need a pool cap before anyone can park (0 on mainnet, as above).
///
/// Env: HIDDEN_CROWD (optional CrowdBuy; pool.setCrowd is called, CrowdBuy.setShieldedPool is left to its
/// owner), HIDDEN_CAP_ASSETS / HIDDEN_CAP_RAWS (optional comma-separated address[] / uint256[] of equal length),
/// HIDDEN_STOCK_ROUTER, HIDDEN_PARK_VAULTS (address[]), HIDDEN_MORPHO_MARKETS (bytes32[]), HIDDEN_MORPHO.
contract HiddenVault is Script {
    uint256 public constant MAINNET = 4663;
    address public constant MORPHO_4663 = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;

    error MainnetCapMustBeZero(address asset, uint256 cap);
    error LengthMismatch();

    function run() external returns (ShieldedPool pool) {
        address crowd = vm.envOr("HIDDEN_CROWD", address(0));
        address[] memory assets = vm.envOr("HIDDEN_CAP_ASSETS", ",", new address[](0));
        uint256[] memory caps = vm.envOr("HIDDEN_CAP_RAWS", ",", new uint256[](0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        pool = deploy(deployer, crowd, assets, caps);
        address router = vm.envOr("HIDDEN_STOCK_ROUTER", address(0));
        if (router != address(0)) {
            ShieldedTrade trade = deployTrade(
                pool,
                deployer,
                StockRouter(router),
                vm.envOr("HIDDEN_PARK_VAULTS", ",", new address[](0)),
                IMorphoBlue(vm.envOr("HIDDEN_MORPHO", MORPHO_4663)),
                vm.envOr("HIDDEN_MORPHO_MARKETS", ",", new bytes32[](0))
            );
            console.log("PLYNTH_SHIELDED_TRADE", address(trade));
        }
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

    /// ShieldedTrade + park adapter proposals. `owner` must own `pool` and send these calls.
    function deployTrade(
        ShieldedPool pool,
        address owner,
        StockRouter router,
        address[] memory vaults,
        IMorphoBlue morpho,
        bytes32[] memory morphoMarkets
    ) public returns (ShieldedTrade trade) {
        trade = new ShieldedTrade(
            pool, IHonkVerifier(address(new SwapVerifier())), IHonkVerifier(address(new SettleVerifier())), router, owner
        );
        pool.setTrade(address(trade));
        address usdg = address(router.usdg());
        for (uint256 i; i < vaults.length; ++i) {
            trade.proposeAdapter(IParkAdapter(address(new ERC4626Park(IERC4626(vaults[i]), usdg))));
        }
        for (uint256 i; i < morphoMarkets.length; ++i) {
            MarketParams memory p;
            (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = morpho.idToMarketParams(morphoMarkets[i]);
            trade.proposeAdapter(IParkAdapter(address(new MorphoBluePark(morpho, p, usdg))));
        }
    }
}
