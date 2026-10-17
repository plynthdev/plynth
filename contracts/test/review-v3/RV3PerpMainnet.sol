// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Review v3 (2026-10-17) perps fixture with NO harness: the real PerpMarket and PerpPool wired exactly as
/// MainnetBeta._perps() wires them (setParams / setGuards with the script's constants while the pool has no LP,
/// addMarket, setMakerRegistrar, openDeposits), priced by the real Valuer with the mainnet staleness (26 h) and the
/// mainnet market calendar (NYSE table, early closes, valid until 2029-10-01). The only stand-ins are the price
/// source (a Chainlink-shaped MockFeed whose answer the test sets), the USDG token and the Stock Token.
abstract contract RV3PerpMainnet is Test {
    /// Tue 2026-11-10 14:00 UTC: a weekday, market open, no holiday nearby.
    uint256 internal constant TUE_1400 = 20767 days + 14 hours;
    int256 internal constant P0 = 100e8;

    MainnetBeta internal script;
    MockUSDG internal usdg;
    StockTokenRegistry internal registry;
    Valuer internal valuer;
    MockStockToken internal token;
    MockFeed internal feed;
    PerpPool internal pool;
    PerpMarket internal market;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    uint256 internal constant LP_SEED = 1_000_000e6;

    function setUp() public virtual {
        vm.warp(TUE_1400);
        script = new MainnetBeta();
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, script.DEFAULT_MAX_STALENESS());
        valuer.enableMarketCalendar();
        valuer.closeDays(script.nyseClosedDays());
        valuer.earlyCloseDays(script.nyseEarlyCloses());
        valuer.setCalendarValidUntil(script.CALENDAR_VALID_UNTIL());
        token = new MockStockToken("Mock Tesla", "mTSLA");
        feed = new MockFeed(8, P0, "mTSLA / USD");
        registry.list(address(token), address(feed), true);

        pool = new PerpPool(usdg, owner, script.PERP_COOLDOWN(), script.TIMELOCK());
        vm.startPrank(owner);
        market = new PerpMarket(pool, valuer, address(token), owner);
        market.setParams(
            script.PERP_TAKER_FEE_BPS(),
            script.PERP_MAKER_FEE_BPS(),
            market.offHoursSpreadBps(),
            market.borrowBpsPerHour(),
            market.fundingK(),
            script.PERP_OI_CAP_BPS(),
            market.maxProfitBps(),
            market.liquidationFee()
        );
        market.setGuards(
            script.PERP_OPEN_SPREAD_BPS(), script.PERP_MIN_HOLD(), script.PERP_MIN_LIQ_REWARD(), script.PERP_MIN_COLLATERAL()
        );
        pool.addMarket(address(market));
        pool.setMakerRegistrar(owner);
        pool.openDeposits();
        vm.stopPrank();

        usdg.mint(lp, LP_SEED);
        vm.startPrank(lp);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(LP_SEED, lp);
        vm.stopPrank();

        // The deployed values, read back from the real contract (no harness switched anything).
        assertEq(market.takerFeeBps(), 10);
        assertEq(market.makerFeeBps(), 6);
        assertEq(market.openSpreadBps(), 40);
        assertEq(market.minHoldSeconds(), 30 minutes);
        assertEq(market.borrowBpsPerHour(), 1);
        assertEq(market.offHoursSpreadBps(), 1_000);
        assertEq(market.oiCapBps(), 2_000);
        assertEq(market.maxProfitBps(), 10_000);
        assertEq(market.minCollateral(), 100e6);
        assertEq(market.FEED_DEVIATION_BPS(), 50);
        assertEq(valuer.maxStaleness(), 26 hours);
        assertTrue(valuer.marketCalendar());
        assertFalse(valuer.marketClosed());
    }

    function _trader(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.prank(a);
        usdg.approve(address(pool), type(uint256).max);
    }

    function _open(address who, bool isLong, uint256 size, uint256 collateral) internal {
        usdg.mint(who, collateral);
        vm.prank(who);
        market.open(isLong, size, collateral, 10_000);
    }

    struct Closed {
        uint256 size;
        int256 pnl;
        int256 funding;
        uint256 borrow;
        uint256 fee;
        uint256 payout;
        uint256 price;
    }

    /// The fields of the market's Decreased event in the recorded logs.
    function _decreased(Vm.Log[] memory logs) internal view returns (Closed memory c) {
        bytes32 sig = PerpMarket.Decreased.selector;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(market) && logs[i].topics[0] == sig) {
                (c.size, c.pnl, c.funding, c.borrow, c.fee, c.payout, c.price) =
                    abi.decode(logs[i].data, (uint256, int256, int256, uint256, uint256, uint256, uint256));
                return c;
            }
        }
        revert("no Decreased event");
    }
}
