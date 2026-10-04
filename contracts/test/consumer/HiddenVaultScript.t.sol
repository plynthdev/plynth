// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HiddenVault} from "../../script/HiddenVault.s.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {IParkAdapter} from "../../src/interfaces/IParkAdapter.sol";
import {IMorphoBlue, MarketParams} from "../../src/interfaces/IMorphoBlue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {IPoolManager} from "../../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockUsdgVault} from "../mocks/MockUsdgVault.sol";

interface IMorphoOwner {
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function createMarket(MarketParams memory marketParams) external;
}

/// Deploy-script rule: mainnet caps stay 0; elsewhere caps are only proposed (48h timelock).
contract HiddenVaultScriptTest is Test {
    HiddenVault script;
    address asset = makeAddr("usdg");
    address crowd = makeAddr("crowd");

    function setUp() public {
        script = new HiddenVault();
    }

    function _one(uint256 c) internal view returns (address[] memory a, uint256[] memory caps) {
        a = new address[](1);
        caps = new uint256[](1);
        a[0] = asset;
        caps[0] = c;
    }

    function test_mainnetDeployLeavesCapsZero() public {
        vm.chainId(4663);
        (address[] memory a, uint256[] memory c) = _one(0);
        ShieldedPool pool = script.deploy(address(script), crowd, a, c);
        assertEq(pool.cap(asset), 0);
        (, uint64 eta) = pool.capProposal(asset);
        assertEq(eta, 0);
        assertEq(pool.crowd(), crowd);
        assertEq(pool.owner(), address(script));
    }

    function test_mainnetDeployRefusesNonZeroCap() public {
        vm.chainId(4663);
        (address[] memory a, uint256[] memory c) = _one(1);
        vm.expectRevert(abi.encodeWithSelector(HiddenVault.MainnetCapMustBeZero.selector, asset, 1));
        script.deploy(address(script), crowd, a, c);
    }

    function test_testnetDeployOnlyProposesCaps() public {
        vm.chainId(46630);
        (address[] memory a, uint256[] memory c) = _one(1e12);
        ShieldedPool pool = script.deploy(address(script), address(0), a, c);
        assertEq(pool.cap(asset), 0); // not live until the timelock passes
        (uint256 cap, uint64 eta) = pool.capProposal(asset);
        assertEq(cap, 1e12);
        assertEq(eta, block.timestamp + 48 hours);
        vm.warp(eta);
        pool.applyCap(asset);
        assertEq(pool.cap(asset), 1e12);
    }

    function test_lengthMismatchRejected() public {
        vm.expectRevert(HiddenVault.LengthMismatch.selector);
        script.deploy(address(script), crowd, new address[](1), new uint256[](0));
    }

    function test_deployTradeSetsModuleAndProposesAdapters() public {
        MockUSDG usdg = new MockUSDG();
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        StockRouter router =
            new StockRouter(IPoolManager(address(1)), reg, new Valuer(reg, 1 days), IERC20Metadata(address(usdg)), address(this));
        MockUsdgVault vault = new MockUsdgVault(IERC20(address(usdg)));

        // A local Morpho Blue (real 4663 runtime) with one USDG market.
        address morpho = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
        vm.etch(morpho, vm.parseBytes(string.concat("0x", vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/morpho_blue.runtime.hex")))));
        vm.store(morpho, bytes32(0), bytes32(uint256(uint160(address(this)))));
        MarketParams memory mp = MarketParams(address(usdg), makeAddr("coll"), makeAddr("oracle"), address(0), 0.9e18);
        IMorphoOwner(morpho).enableIrm(address(0));
        IMorphoOwner(morpho).enableLltv(0.9e18);
        IMorphoOwner(morpho).createMarket(mp);

        (address[] memory a, uint256[] memory c) = _one(0);
        ShieldedPool pool = script.deploy(address(script), crowd, a, c);
        address[] memory vaults = new address[](1);
        vaults[0] = address(vault);
        bytes32[] memory markets = new bytes32[](1);
        markets[0] = keccak256(abi.encode(mp));
        ShieldedTrade trade = script.deployTrade(pool, address(script), router, vaults, IMorphoBlue(morpho), markets);

        assertEq(pool.trade(), address(trade));
        assertEq(trade.owner(), address(script));
        assertEq(trade.usdg(), address(usdg));
        (IParkAdapter va, uint64 eta) = trade.adapterProposal(address(vault));
        assertEq(va.shareToken(), address(vault));
        assertEq(eta, block.timestamp + 48 hours);
        assertEq(address(trade.adapterOf(address(vault))), address(0), "not live before the timelock");
        vm.warp(eta);
        trade.applyAdapter(address(vault));
        assertTrue(trade.parkEnabled(va));
    }
}
