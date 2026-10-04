// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon} from "../../src/consumer/CrowdBuy.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockPoolManager, MockStockERC20} from "../mocks/MockV4.sol";

/// Stock token that can call `crowd.join(user)` when it receives tokens: simulates a join landing
/// in the middle of an execution.
contract HookStock is MockStockERC20 {
    CrowdBuy public crowd;
    address public hookUser;

    constructor(string memory sym) MockStockERC20(sym, 18) {}

    function arm(CrowdBuy c, address user) external {
        crowd = c;
        hookUser = user;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hookUser != address(0) && to == address(crowd)) {
            address u = hookUser;
            hookUser = address(0);
            crowd.join(u);
        }
    }
}

abstract contract CrowdBuyBase is Test {
    uint256 internal constant U = 1e6;
    uint256 internal constant PRICE_A = 250e18;
    uint256 internal constant PRICE_B = 37e18;
    uint24 internal constant FEE = 500;
    uint16 internal constant SLIP = 100;
    uint64 internal constant T0 = 1_800_000_000;
    uint64 internal constant GENESIS = T0 + 1 days;

    MockUSDG internal usdg;
    StockTokenRegistry internal registry;
    Valuer internal valuer;
    MockPoolManager internal pm;
    StockRouter internal router;
    JitterBeacon internal beacon;
    SavingsVault internal vault;
    CrowdBuy internal crowd;
    HookStock internal tokA;
    HookStock internal tokB;
    MockFeed internal feedA;
    MockFeed internal feedB;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    uint256 internal srcNonce;

    function _minCrowd() internal pure virtual returns (uint32) {
        return 3;
    }

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, 2 hours);
        tokA = new HookStock("TSLA");
        tokB = new HookStock("NVDA");
        feedA = new MockFeed(8, int256(PRICE_A / 1e10), "A");
        feedB = new MockFeed(8, int256(PRICE_B / 1e10), "B");
        registry.list(address(tokA), address(feedA), true);
        registry.list(address(tokB), address(feedB), true);

        pm = new MockPoolManager();
        router = new StockRouter(IPoolManager(address(pm)), registry, valuer, IERC20Metadata(address(usdg)), owner);
        _setPool(address(tokA), PRICE_A);
        _setPool(address(tokB), PRICE_B);
        usdg.mint(address(pm), 1e15);
        tokA.mint(address(pm), 1e27);
        tokB.mint(address(pm), 1e27);

        beacon = new JitterBeacon(keeper, owner);
        vault = new SavingsVault(
            IERC20(address(usdg)), makeAddr("permit2"), ICanonicalRegistry(address(registry)), owner, keeper
        );
        crowd = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), _minCrowd(), SLIP, GENESIS, owner, keeper);
        vm.prank(owner);
        vault.setCrowd(address(crowd));
    }

    // ---------------------------------------------------------------- helpers

    function _setPool(address tok, uint256 usdPerToken) internal {
        (address c0, address c1) = address(usdg) < tok ? (address(usdg), tok) : (tok, address(usdg));
        PoolKey memory key = PoolKey(c0, c1, FEE, 10, IHooks(address(0)));
        vm.prank(owner);
        router.setPool(tok, key);
        if (c0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (usdPerToken * 1e6));
        else pm.setRate(key, usdPerToken * 1e6 / 1e18);
    }

    function _user(uint256 i) internal returns (address) {
        return makeAddr(string(abi.encodePacked("user", vm.toString(i))));
    }

    /// Gives `user` settings and a mix, funds them and accrues exactly `amount` into pending.
    function _prepare(address user, address[] memory tokens, uint16[] memory weights, uint256 amount) internal {
        vm.startPrank(user);
        vault.setSettings(SavingsVault.Settings(10, 1, uint64(500 * U), 0, 0));
        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            m[i] = SavingsVault.MixEntry(tokens[i], weights[i]);
        }
        vault.setMix(m);
        vm.stopPrank();
        _accrue(user, amount);
    }

    function _accrue(address user, uint256 amount) internal {
        usdg.mint(user, amount);
        vm.startPrank(user);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        uint256 left = amount;
        while (left != 0) {
            uint256 chunk = left < 10 * U - 1 ? left : 10 * U - 1;
            vm.prank(keeper);
            vault.accrue(user, bytes32(++srcNonce), 0, 10 * U - chunk);
            left -= chunk;
        }
    }

    function _one(address t) internal pure returns (address[] memory a, uint16[] memory w) {
        a = new address[](1);
        w = new uint16[](1);
        a[0] = t;
        w[0] = 10_000;
    }

    /// Prepares and joins `user` with `amount` into token A only.
    function _joinA(address user, uint256 amount) internal {
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(user, a, w, amount);
        crowd.join(user);
    }

    function _windowStart(uint256 idx) internal pure returns (uint64) {
        return GENESIS + uint64(idx) * 1 days;
    }

    /// Commits a beacon for (asset, window idx). Must run before the window starts.
    function _commit(address asset, uint256 idx, bytes32 secret) internal {
        uint64 s = _windowStart(idx);
        bytes32 key = crowd.beaconKey(asset, s);
        vm.prank(keeper);
        beacon.commit(key, s, s + 1 days, keccak256(abi.encode(secret, key)));
    }

    function _reveal(address asset, uint256 idx, bytes32 secret) internal returns (uint64 at) {
        bytes32 key = crowd.beaconKey(asset, _windowStart(idx));
        beacon.reveal(key, secret);
        at = beacon.executeAfter(key);
    }

    function _freshFeeds() internal {
        feedA.set(int256(PRICE_A / 1e10));
        feedB.set(int256(PRICE_B / 1e10));
    }
}
