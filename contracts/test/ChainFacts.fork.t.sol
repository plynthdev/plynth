// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {StockTokenRegistry} from "../src/StockTokenRegistry.sol";
import {Valuer} from "../src/Valuer.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IERC4626Min {
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IAccessRegistry {
    function isBlocked(address account) external view returns (bool);
}

interface IStockTokenAdmin {
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// A contract that can hold and forward tokens, standing in for a vault or stealth-claim contract.
contract Sink {
    function forward(address token, address to, uint256 amount) external {
        IERC20Min(token).transfer(to, amount);
    }
}

/// Pins the on-chain facts that later code depends on, against a fork of Robinhood Chain mainnet (4663).
/// Skipped when RHC_MAINNET_RPC_URL is unset.
contract ChainFactsForkTest is Test {
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address constant TSLA_EOA_HOLDER = 0x92d435C96E63c43E12d6D0AB28f6b0B04072F765;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);
    }

    function _holderAmount() internal view returns (uint256 amt) {
        // If this fails the holder moved its funds: pick a new EOA holder from TSLA Transfer logs.
        assertGt(IERC20Min(TSLA).balanceOf(TSLA_EOA_HOLDER), 0, "holder emptied");
        amt = 1;
    }

    function test_stockTokenTransferToFreshEoaSucceeds() public {
        uint256 amt = _holderAmount();
        address fresh = makeAddr("fresh-eoa");
        vm.prank(TSLA_EOA_HOLDER);
        assertTrue(IERC20Min(TSLA).transfer(fresh, amt));
        assertEq(IERC20Min(TSLA).balanceOf(fresh), amt);
    }

    function test_stockTokenTransferToFreshContractAndBackSucceeds() public {
        uint256 amt = _holderAmount();
        Sink sink = new Sink();
        vm.prank(TSLA_EOA_HOLDER);
        IERC20Min(TSLA).transfer(address(sink), amt);
        assertEq(IERC20Min(TSLA).balanceOf(address(sink)), amt);
        address out = makeAddr("out");
        sink.forward(TSLA, out, amt);
        assertEq(IERC20Min(TSLA).balanceOf(out), amt);
    }

    /// Restriction is a blocklist in the token's access registry, not an allowlist.
    function test_blockedRecipientIsRejected() public {
        uint256 amt = _holderAmount();
        address reg = IStockTokenAdmin(TSLA).ACCESS_CONTROLLED_REGISTRY();
        address fresh = makeAddr("blocked");
        assertFalse(IAccessRegistry(reg).isBlocked(fresh));
        vm.mockCall(reg, abi.encodeCall(IAccessRegistry.isBlocked, (fresh)), abi.encode(true));
        vm.prank(TSLA_EOA_HOLDER);
        vm.expectRevert();
        IERC20Min(TSLA).transfer(fresh, amt);
    }

    function test_usdgIsSixDecimalGlobalDollar() public view {
        assertEq(IERC20Min(USDG).symbol(), "USDG");
        assertEq(IERC20Min(USDG).decimals(), 6);
    }

    /// The Robinhood equity feeds price one TOKEN (multiplier embedded): list them with multiplierEmbedded = true.
    function test_valuerWithRealAaplFeedAppliesNoSecondMultiplier() public {
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        Valuer valuer = new Valuer(reg, 3 days);
        reg.list(AAPL, AAPL_FEED, true);
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(AAPL_FEED).latestRoundData();
        assertEq(AggregatorV3Interface(AAPL_FEED).decimals(), 8);
        vm.warp(updatedAt + 1);
        Valuer.Quote memory q = valuer.quote(AAPL);
        assertEq(q.priceUsdPerToken, uint256(answer) * 1e10);
        assertFalse(q.hold);
    }

    function test_steakhouseUsdgVaultIsErc4626OverUsdg() public view {
        assertEq(IERC4626Min(STEAK_USDG).asset(), USDG);
        assertGt(IERC4626Min(STEAK_USDG).totalAssets(), 0);
        assertGe(IERC4626Min(STEAK_USDG).convertToAssets(1e18), 1e6); // shares 18 dec, assets 6 dec, share price >= 1
    }
}
