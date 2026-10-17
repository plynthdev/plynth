// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockERC20, MockPoolManager, MockStockERC20} from "../mocks/MockV4.sol";

contract StockRouterTest is Test {
    StockTokenRegistry reg;
    Valuer valuer;
    MockFeed feed;
    MockStockERC20 tok;
    MockERC20 usdg;
    MockPoolManager pm;
    StockRouter router;
    PoolKey key;

    address board = makeAddr("board");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant PRICE = 250e18; // USD per token, 1e18
    uint24 constant FEE = 500; // 0.05%

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new StockTokenRegistry(board);
        valuer = new Valuer(reg, 30 minutes);
        feed = new MockFeed(8, 250e8, "mock");
        tok = new MockStockERC20("TSLA", 18);
        usdg = new MockERC20("USDG", 6);
        vm.prank(board);
        reg.list(address(tok), address(feed), true);

        pm = new MockPoolManager();
        router = new StockRouter(IPoolManager(address(pm)), reg, valuer, IERC20Metadata(address(usdg)), board);
        key = _key(address(usdg), address(tok), FEE);
        vm.prank(board);
        router.setPool(address(tok), key);
        _setPoolPrice(PRICE);

        usdg.mint(address(pm), 1e15); // 1bn USDG liquidity
        tok.mint(address(pm), 1e27); // 1bn tokens
        usdg.mint(alice, 1e12);
        tok.mint(alice, 1000e18);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        tok.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ---------- helpers ----------

    function _key(address a, address b, uint24 fee) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(c0, c1, fee, 10, IHooks(address(0)));
    }

    /// Pool exchange rate equal to `usdPerToken` (1e18) for the 6dp USDG / 18dp token pair.
    function _setPoolPrice(uint256 usdPerToken) internal {
        // stock raw per usdg raw = 1e18 / (price * 1e6), price = usdPerToken / 1e18
        if (key.currency0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (usdPerToken * 1e6));
        else pm.setRate(key, usdPerToken * 1e6 / 1e18);
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdg.balanceOf(address(router)), 0, "router usdg");
        assertEq(tok.balanceOf(address(router)), 0, "router stock");
    }

    // ---------- R1 canonical ----------

    function test_R1_buyNonCanonicalReverts() public {
        MockStockERC20 fake = new MockStockERC20("FAKE", 18);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.NotCanonical.selector, address(fake)));
        vm.prank(alice);
        router.buy(address(fake), 100e6, 100, alice);
    }

    function test_R1_sellDelistedReverts() public {
        vm.prank(board);
        reg.delist(address(tok));
        vm.expectRevert(abi.encodeWithSelector(StockRouter.NotCanonical.selector, address(tok)));
        vm.prank(alice);
        router.sell(address(tok), 1e18, 100, alice);
    }

    function test_R1_quoteNonCanonicalReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StockRouter.NotCanonical.selector, address(0xBEEF)));
        router.quoteMinOut(address(0xBEEF), 1e6, true, 100);
    }

    // ---------- R2 hold ----------

    function test_R2_staleFeedBlocksBuyAndSell() public {
        feed.set(250e8);
        feed.setUpdatedAt(block.timestamp - 31 minutes);
        (, bool hold) = router.quoteMinOut(address(tok), 100e6, true, 100);
        assertTrue(hold);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.MarketOnHold.selector, address(tok)));
        router.buy(address(tok), 100e6, 100, alice);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.MarketOnHold.selector, address(tok)));
        router.sell(address(tok), 1e18, 100, alice);
        vm.stopPrank();
    }

    // ---------- R3 oracle minOut ----------

    function test_R3_buyMinOutFromOracle() public view {
        // 1000 USDG at $250 = 4 tokens; 1% slippage -> 3.96
        (uint256 minOut, bool hold) = router.quoteMinOut(address(tok), 1000e6, true, 100);
        assertEq(minOut, 3.96e18);
        assertFalse(hold);
        // 4 tokens at $250 = 1000 USDG; 1% -> 990
        (minOut,) = router.quoteMinOut(address(tok), 4e18, false, 100);
        assertEq(minOut, 990e6);
    }

    function test_R3_minOutIgnoresPoolPrice() public {
        (uint256 before,) = router.quoteMinOut(address(tok), 1000e6, true, 100);
        _setPoolPrice(500e18);
        (uint256 afterPool,) = router.quoteMinOut(address(tok), 1000e6, true, 100);
        assertEq(before, afterPool);
    }

    function test_R3_minOutAppliesMultiplierOnceWhenFeedIsPerShare() public {
        vm.prank(board);
        reg.list(address(tok), address(feed), false); // a listed token's feed/flag change waits 48 h (ChangeDelay)
        vm.warp(block.timestamp + 48 hours); // ChangeDelay
        vm.prank(board);
        reg.list(address(tok), address(feed), false);
        vm.warp(block.timestamp - 48 hours);
        tok.setMultiplier(1.25e18); // token = 1.25 shares -> $312.5
        (uint256 minOut,) = router.quoteMinOut(address(tok), 312.5e6, true, 0);
        assertEq(minOut, 1e18);
    }

    function test_R3_buyBelowMinOutReverts() public {
        _setPoolPrice(255e18); // pool 2% worse than oracle
        (uint256 minOut,) = router.quoteMinOut(address(tok), 1000e6, true, 100);
        uint256 got = uint256(1000e6) * (1e6 - FEE) / 1e6 * pm.rate1Per0X18(keccak256(abi.encode(key))) / 1e18;
        if (key.currency0 != address(usdg)) got = uint256(1000e6) * (1e6 - FEE) / 1e6 * 1e18 / pm.rate1Per0X18(keccak256(abi.encode(key)));
        vm.expectRevert(abi.encodeWithSelector(StockRouter.Slippage.selector, minOut, got));
        vm.prank(alice);
        router.buy(address(tok), 1000e6, 100, alice);
    }

    function test_R3_sellBelowMinOutReverts() public {
        _setPoolPrice(245e18);
        vm.expectPartialRevert(StockRouter.Slippage.selector);
        vm.prank(alice);
        router.sell(address(tok), 1e18, 100, alice);
    }

    function test_R3_maxSlippageCappedAt500() public {
        vm.expectRevert(abi.encodeWithSelector(StockRouter.SlippageTooHigh.selector, uint16(501)));
        vm.prank(alice);
        router.buy(address(tok), 100e6, 501, alice);
        _setPoolPrice(260e18); // 4% worse: fits in 5%
        vm.prank(alice);
        router.buy(address(tok), 100e6, 500, alice);
    }

    /// Independent reference: plain checked arithmetic (no mulDiv), with inputs bounded so it cannot
    /// overflow. One floor division each side, so results must match exactly.
    function testFuzz_R3_minOutMatchesReference(
        uint256 amountIn,
        uint256 price,
        uint8 tokDec,
        uint8 usdDec,
        uint16 bps,
        bool isBuy
    ) public {
        amountIn = bound(amountIn, 1, 1e30);
        price = bound(price, 1e10, 1e24); // $0.00000001 .. $1,000,000 per token
        tokDec = uint8(bound(tokDec, 0, 18));
        usdDec = uint8(bound(usdDec, 0, 18));
        bps = uint16(bound(bps, 0, 500));

        MockStockERC20 t = new MockStockERC20("T", tokDec);
        MockERC20 u = new MockERC20("U", usdDec);
        MockFeed f = new MockFeed(18, int256(price), "mock");
        vm.prank(board);
        reg.list(address(t), address(f), true);
        StockRouter r = new StockRouter(IPoolManager(address(pm)), reg, valuer, IERC20Metadata(address(u)), board);

        (uint256 got,) = r.quoteMinOut(address(t), amountIn, isBuy, bps);
        uint256 ref;
        if (isBuy) {
            ref = amountIn * 10 ** tokDec * 1e18 * (10_000 - bps) / (price * 10 ** usdDec * 10_000);
        } else {
            ref = amountIn * price * 10 ** usdDec * (10_000 - bps) / (10 ** tokDec * 1e18 * 10_000);
        }
        assertEq(got, ref);
    }

    /// Property: what minOut is worth at the oracle price never exceeds what was paid.
    function testFuzz_R3_minOutNeverWorthMoreThanInput(uint256 usdgIn, uint256 price, uint16 bps) public {
        usdgIn = bound(usdgIn, 1, 1e18);
        price = bound(price, 1e16, 1e24);
        bps = uint16(bound(bps, 0, 500));
        feed.set(int256(price / 1e10));
        feed.setUpdatedAt(block.timestamp);
        (uint256 minOut,) = router.quoteMinOut(address(tok), usdgIn, true, bps);
        (uint256 usd,) = valuer.value(address(tok), minOut);
        assertLe(usd, usdgIn * 1e12); // USDG 6dp -> 1e18
    }

    // ---------- R4 caller pays, recipient receives, router keeps nothing ----------

    function test_R4_buyPullsFromCallerPaysRecipient() public {
        uint256 aliceUsdg = usdg.balanceOf(alice);
        vm.prank(alice);
        uint256 out = router.buy(address(tok), 1000e6, 100, bob);
        assertEq(usdg.balanceOf(alice), aliceUsdg - 1000e6);
        assertEq(tok.balanceOf(bob), out);
        assertEq(out, uint256(1000e6) * (1e6 - FEE) / 1e6 * 4e18 / 1000e6);
        _assertRouterEmpty();
        assertEq(pm.delta(address(usdg)), 0);
        assertEq(pm.delta(address(tok)), 0);
    }

    function test_R4_buyWithoutApprovalReverts() public {
        usdg.mint(bob, 100e6);
        vm.expectRevert();
        vm.prank(bob);
        router.buy(address(tok), 100e6, 100, bob);
    }

    function test_R4_partialFillReverts() public {
        pm.setFillBps(9_000);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.PartialFill.selector, 1000e6, 900e6));
        vm.prank(alice);
        router.buy(address(tok), 1000e6, 500, alice);
    }

    function test_R4_zeroAmountAndZeroRecipientRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(StockRouter.ZeroAmount.selector);
        router.buy(address(tok), 0, 100, alice);
        vm.expectRevert(StockRouter.ZeroAddress.selector);
        router.buy(address(tok), 1e6, 100, address(0));
        vm.stopPrank();
    }

    function testFuzz_R4_routerAlwaysEmpty(uint256 usdgIn, uint256 rawIn, bool isBuy) public {
        vm.startPrank(alice);
        if (isBuy) {
            usdgIn = bound(usdgIn, 1e4, 1e12); // >= 0.01 USDG: below that fee rounding alone exceeds 1%
            uint256 bobBefore = tok.balanceOf(bob);
            uint256 out = router.buy(address(tok), usdgIn, 100, bob);
            assertEq(tok.balanceOf(bob) - bobBefore, out);
        } else {
            rawIn = bound(rawIn, 1e14, 1000e18);
            uint256 bobBefore = usdg.balanceOf(bob);
            uint256 out = router.sell(address(tok), rawIn, 100, bob);
            assertEq(usdg.balanceOf(bob) - bobBefore, out);
        }
        vm.stopPrank();
        _assertRouterEmpty();
    }

    function test_R4_unlockCallbackOnlyFromPoolManager() public {
        vm.expectRevert(StockRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    // ---------- R5 USDG decimals from the token ----------

    function test_R5_usdgDecimalsReadFromToken() public {
        assertEq(router.usdgDecimals(), 6);
        MockERC20 u18 = new MockERC20("USDG18", 18);
        StockRouter r18 = new StockRouter(IPoolManager(address(pm)), reg, valuer, IERC20Metadata(address(u18)), board);
        assertEq(r18.usdgDecimals(), 18);
        (uint256 m6,) = router.quoteMinOut(address(tok), 1000e6, true, 0);
        (uint256 m18,) = r18.quoteMinOut(address(tok), 1000e18, true, 0);
        assertEq(m6, 4e18);
        assertEq(m18, 4e18);
    }

    // ---------- R6 sell mirrors buy ----------

    function test_R6_sellPullsTokensPaysUsdg() public {
        uint256 aliceTok = tok.balanceOf(alice);
        vm.prank(alice);
        uint256 out = router.sell(address(tok), 2e18, 100, bob);
        assertEq(tok.balanceOf(alice), aliceTok - 2e18);
        assertEq(usdg.balanceOf(bob), out);
        assertEq(out, uint256(2e18) * (1e6 - FEE) / 1e6 * 250e6 / 1e18);
        _assertRouterEmpty();
    }

    function test_R6_bothCurrencyOrdersWork() public {
        // One token below USDG's address (token is currency0), one above (USDG is currency0).
        address[2] memory at = [address(0x1000), address(uint160(type(uint160).max) - 0x1000)];
        for (uint256 i; i < 2; i++) {
            deployCodeTo("MockV4.sol:MockStockERC20", abi.encode("T2", uint8(18)), at[i]);
            MockStockERC20 t2 = MockStockERC20(at[i]);
            vm.prank(board);
            reg.list(address(t2), address(feed), true);
            PoolKey memory k = _key(address(usdg), address(t2), FEE);
            vm.prank(board);
            router.setPool(address(t2), k);
            if (k.currency0 == address(usdg)) pm.setRate(k, uint256(1e36) / 250e6);
            else pm.setRate(k, 250e6);
            t2.mint(address(pm), 1e24);
            t2.mint(alice, 10e18);
            vm.startPrank(alice);
            t2.approve(address(router), type(uint256).max);
            uint256 got = router.buy(address(t2), 250e6, 100, alice);
            assertApproxEqRel(got, 1e18, 0.001e18);
            uint256 back = router.sell(address(t2), 1e18, 100, alice);
            assertApproxEqRel(back, 250e6, 0.001e18);
            vm.stopPrank();
            assertEq(t2.balanceOf(address(router)), 0);
        }
        _assertRouterEmpty();
    }

    // ---------- pool admin ----------

    function test_setPoolRequiresUsdgAndToken() public {
        vm.startPrank(board);
        vm.expectRevert(StockRouter.BadPoolKey.selector);
        router.setPool(address(tok), _key(address(tok), address(0xCAFE), FEE));
        vm.expectRevert(StockRouter.BadPoolKey.selector);
        router.setPool(address(0xCAFE), key);
        vm.stopPrank();
    }

    function test_setPoolOnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        router.setPool(address(tok), key);
    }

    function test_noPoolReverts() public {
        MockStockERC20 t2 = new MockStockERC20("T2", 18);
        vm.prank(board);
        reg.list(address(t2), address(feed), true);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.NoPool.selector, address(t2)));
        vm.prank(alice);
        router.buy(address(t2), 100e6, 100, alice);
    }
}
