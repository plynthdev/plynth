// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {IParkAdapter} from "../../src/consumer/park/IParkAdapter.sol";
import {ERC4626Park} from "../../src/consumer/park/ERC4626Park.sol";
import {MorphoBluePark} from "../../src/consumer/park/MorphoBluePark.sol";
import {IMorphoBlue, Market, MarketParams} from "../../src/consumer/park/IMorphoBlue.sol";
import {MockERC20} from "../mocks/MockV4.sol";
import {ShieldedTradeBase} from "./ShieldedTradeBase.sol";
import {MockUsdgVault} from "../mocks/MockUsdgVault.sol";

interface IMorphoAdmin {
    function owner() external view returns (address);
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function createMarket(MarketParams memory marketParams) external;
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;
    function borrow(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
}

/// Constant borrow rate per second (1e18-scaled), like Morpho's IIrm.
contract FixedRateIrm {
    uint256 public immutable rate;

    constructor(uint256 r) {
        rate = r;
    }

    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }

    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }
}

/// Morpho oracle: price of 1 collateral unit in loan units, scaled 1e36.
contract FixedOracle {
    uint256 public price = 1e24; // 1 collateral (18 dp) = 1 USDG (6 dp)
}

/// An adapter that lies about its asset or share token.
contract FakeAdapter {
    address public asset;
    address public shareToken;

    constructor(address a, address s) {
        asset = a;
        shareToken = s;
    }
}

/// Private park / unpark: an OpenZeppelin ERC-4626 vault over USDG and the REAL Morpho Blue runtime (fetched from
/// 4663, test/consumer/fixtures/morpho_blue.runtime.hex) etched at its canonical address with a local market.
contract ShieldedParkTest is ShieldedTradeBase {
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    uint256 internal constant LLTV = 0.915e18;
    uint256 internal constant RATE = 3_170_979_198; // ~10% APR per second, 1e18-scaled

    MockUsdgVault internal vault;
    ERC4626Park internal vaultPark;
    MorphoBluePark internal morphoPark;
    MarketParams internal params;
    MockERC20 internal collateral;
    address internal borrower = makeAddr("borrower");

    function setUp() public override {
        super.setUp();
        vault = new MockUsdgVault(IERC20(address(usdg)));
        vaultPark = new ERC4626Park(IERC4626(address(vault)), address(usdg));
        _setUpMorpho();
        morphoPark = new MorphoBluePark(IMorphoBlue(MORPHO), params, address(usdg));

        _addAdapter(vaultPark);
        _addAdapter(morphoPark);
        _raiseCap(address(vault), type(uint128).max);
        _raiseCap(address(morphoPark), type(uint128).max);
    }

    function _setUpMorpho() internal {
        vm.etch(MORPHO, vm.parseBytes(string.concat("0x", vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/morpho_blue.runtime.hex")))));
        vm.store(MORPHO, bytes32(0), bytes32(uint256(uint160(owner)))); // Morpho.owner is slot 0
        assertEq(IMorphoAdmin(MORPHO).owner(), owner);
        collateral = new MockERC20("COLL", 18);
        params = MarketParams(address(usdg), address(collateral), address(new FixedOracle()), address(new FixedRateIrm(RATE)), LLTV);
        vm.startPrank(owner);
        IMorphoAdmin(MORPHO).enableIrm(params.irm);
        IMorphoAdmin(MORPHO).enableLltv(LLTV);
        IMorphoAdmin(MORPHO).createMarket(params);
        vm.stopPrank();
    }

    function _addAdapter(IParkAdapter a) internal {
        vm.prank(owner);
        trade.proposeAdapter(a);
        vm.warp(block.timestamp + trade.ADAPTER_DELAY());
        trade.applyAdapter(a.shareToken());
        _refreshFeed();
    }

    function _borrow(uint256 assets) internal {
        collateral.mint(borrower, assets * 2e12);
        vm.startPrank(borrower);
        collateral.approve(MORPHO, type(uint256).max);
        IMorphoAdmin(MORPHO).supplyCollateral(params, assets * 2e12, borrower, "");
        IMorphoAdmin(MORPHO).borrow(params, assets, 0, borrower, borrower);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ ERC-4626

    function test_erc4626ParkUnparkAccruesVaultGain() public {
        _note(address(usdg), 1000 * U);
        ShieldedTrade.PublicSwap memory s = _pub(address(usdg), 1000 * U, 0, address(vault), 0);
        assertEq(uint8(trade.kindOf(address(usdg), address(vault))), uint8(ShieldedTrade.Kind.Park));
        (uint256 shares,) = _swap(s);
        assertEq(shares, vault.balanceOf(address(pool)));
        assertEq(pool.shielded(address(vault)), shares);
        assertEq(pool.shielded(address(usdg)), 0);
        assertApproxEqAbs(trade.parkValue(address(vault), shares), 1000 * U, 1);

        usdg.mint(address(vault), 10 * U); // the vault gains 1%
        uint256 value = trade.parkValue(address(vault), shares);
        assertApproxEqAbs(value, 1010 * U, 1);

        ShieldedTrade.PublicSwap memory u = _pub(address(vault), shares, 0, address(usdg), value);
        assertEq(uint8(trade.kindOf(address(vault), address(usdg))), uint8(ShieldedTrade.Kind.Unpark));
        (uint256 back,) = _swap(u);
        assertEq(back, value, "unpark pays the shown value");
        assertEq(pool.shielded(address(vault)), 0);
        assertEq(pool.shielded(address(usdg)), back);
        _assertBacked(_two(address(usdg), address(vault)));
    }

    function test_parkShareNoteIsUntouchedByVaultGains() public {
        _note(address(usdg), 1000 * U);
        (uint256 shares,) = _swap(_pub(address(usdg), 1000 * U, 0, address(vault), 0));
        bytes32 root = pool.currentRoot();
        usdg.mint(address(vault), 10 * U);
        assertEq(pool.shielded(address(vault)), shares, "shares, not USDG, are the note amount");
        assertEq(pool.currentRoot(), root);
    }

    // ------------------------------------------------------------ Morpho Blue (real runtime)

    function test_morphoParkUnparkAccruesInterest() public {
        _note(address(usdg), 10_000 * U);
        ShieldedTrade.PublicSwap memory s = _pub(address(usdg), 10_000 * U, 0, address(morphoPark), 0);
        (uint256 shares,) = _swap(s);
        assertEq(morphoPark.balanceOf(address(pool)), shares);
        assertEq(morphoPark.totalSupply(), shares, "token supply == adapter's Morpho supply shares");
        assertEq(pool.shielded(address(morphoPark)), shares);
        assertApproxEqAbs(trade.parkValue(address(morphoPark), shares), 10_000 * U, 1);

        _borrow(5_000 * U);
        vm.warp(block.timestamp + 365 days);
        uint256 shown = trade.parkValue(address(morphoPark), shares);
        // ~10% APR on 5k borrowed, continuously compounded, all to the single lender: ~ +525 USDG.
        assertGt(shown, 10_500 * U);
        assertLt(shown, 10_550 * U);
        // The view equals Morpho's own accrual.
        IMorphoBlue(MORPHO).accrueInterest(params);
        assertEq(morphoPark.convertToAssets(shares), shown, "expected share price == accrued share price");

        _refreshFeed();
        // Unpark a third (the rest of the market is lent out).
        uint256 part = shares / 3;
        uint256 partValue = trade.parkValue(address(morphoPark), part);
        ShieldedTrade.PublicSwap memory u = _pub(address(morphoPark), part, 0, address(usdg), partValue);
        (uint256 back,) = _swap(u);
        assertEq(back, partValue, "unpark pays the shown value");
        assertApproxEqAbs(back, shown / 3, 1);
        assertEq(pool.shielded(address(morphoPark)), shares - part);
        assertEq(morphoPark.totalSupply(), shares - part);
        _assertBacked(_two(address(usdg), address(morphoPark)));
    }

    function test_morphoUnparkRevertsWhenFullyBorrowed_noteStaysUnspent() public {
        _note(address(usdg), 1000 * U);
        (uint256 shares,) = _swap(_pub(address(usdg), 1000 * U, 0, address(morphoPark), 0));
        _borrow(1000 * U); // 100% utilisation
        ShieldedTrade.PublicSwap memory u = _pub(address(morphoPark), shares, 0, address(usdg), 0);
        vm.expectRevert(); // Morpho: insufficient liquidity
        trade.swap("", u, BPS, "", "");
        assertFalse(pool.nullifierSpent(u.nullifier));
        assertEq(pool.shielded(address(morphoPark)), shares);
    }

    // ------------------------------------------------------------ exits stay ungated

    function test_disableParkBlocksParkNotUnpark() public {
        _note(address(usdg), 2000 * U);
        (uint256 shares,) = _swap(_pub(address(usdg), 1000 * U, 0, address(vault), 0));
        vm.prank(owner);
        trade.disablePark(vaultPark);
        ShieldedTrade.PublicSwap memory p = _pub(address(usdg), 1000 * U, 0, address(vault), 0);
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.ParkDisabled.selector, address(vaultPark)));
        trade.swap("", p, BPS, "", "");

        // Paused deposits + disabled adapter + caps at zero: unpark still works.
        vm.startPrank(owner);
        pool.setDepositsPaused(true);
        pool.proposeCap(address(usdg), 0);
        pool.proposeCap(address(vault), 0);
        vm.stopPrank();
        (uint256 back,) = _swap(_pub(address(vault), shares, 0, address(usdg), 0));
        assertApproxEqAbs(back, 1000 * U, 1);
    }

    function test_parkSharesWithdrawnAsSharesRedeemDirectly() public {
        _note(address(usdg), 1000 * U);
        (uint256 vShares,) = _swap(_pub(address(usdg), 500 * U, 0, address(vault), 0));
        // Settled and withdrawn from the pool as shares (stand-in withdraw verifier).
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = bytes32(uint256(4242));
        w.changeCommitment = bytes32(uint256(4343));
        w.asset = address(vault);
        w.amount = vShares;
        w.recipient = alice;
        pool.withdraw("", w);
        assertEq(vault.balanceOf(alice), vShares);
        vm.startPrank(alice);
        vault.approve(address(vaultPark), vShares);
        uint256 got = vaultPark.unpark(vShares, alice);
        vm.stopPrank();
        assertApproxEqAbs(got, 500 * U, 1);

        // Same for Morpho park tokens.
        (uint256 mShares,) = _swap(_pub(address(usdg), 500 * U, 0, address(morphoPark), 0));
        w.root = pool.currentRoot();
        w.nullifier = bytes32(uint256(4444));
        w.asset = address(morphoPark);
        w.amount = mShares;
        pool.withdraw("", w);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        morphoPark.unpark(mShares, alice);
        assertApproxEqAbs(usdg.balanceOf(alice) - before, 500 * U, 1);
        assertEq(morphoPark.totalSupply(), 0);
    }

    function test_unparkOfAnotherHoldersSharesImpossible() public {
        _note(address(usdg), 1000 * U);
        _swap(_pub(address(usdg), 1000 * U, 0, address(morphoPark), 0));
        vm.prank(alice);
        vm.expectRevert(); // burns from msg.sender, who holds nothing
        morphoPark.unpark(1, alice);
    }

    // ------------------------------------------------------------ allow-list

    function test_adapterAllowListIsTimelocked() public {
        MockUsdgVault v2 = new MockUsdgVault(IERC20(address(usdg)));
        ERC4626Park a2 = new ERC4626Park(IERC4626(address(v2)), address(usdg));
        vm.prank(alice);
        vm.expectRevert(); // only owner
        trade.proposeAdapter(a2);
        vm.expectRevert(ShieldedTrade.NoProposal.selector);
        trade.applyAdapter(address(v2));
        vm.prank(owner);
        trade.proposeAdapter(a2);
        (, uint64 eta) = trade.adapterProposal(address(v2));
        vm.expectRevert(abi.encodeWithSelector(ShieldedTrade.TooEarly.selector, eta));
        trade.applyAdapter(address(v2));
        // Before it applies, v2 shares are not a park asset (v2 -> USDG would be a "sell" the router refuses).
        assertEq(uint8(trade.kindOf(address(v2), address(usdg))), uint8(ShieldedTrade.Kind.Sell));
        vm.warp(eta);
        trade.applyAdapter(address(v2));
        assertEq(address(trade.adapterOf(address(v2))), address(a2));
        assertTrue(trade.parkEnabled(a2));
    }

    function test_badAdaptersRejected() public {
        IParkAdapter[4] memory bad4 = [
            IParkAdapter(address(new FakeAdapter(address(stock), makeAddr("s")))), // wrong asset
            IParkAdapter(address(new FakeAdapter(address(usdg), address(stock)))), // share is a canonical Stock Token
            IParkAdapter(address(new FakeAdapter(address(usdg), address(usdg)))), // share is USDG
            IParkAdapter(address(new FakeAdapter(address(usdg), address(vault)))) // share already routed elsewhere
        ];
        vm.startPrank(owner);
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(ShieldedTrade.BadAdapter.selector);
            trade.proposeAdapter(bad4[i]);
        }
        vm.stopPrank();
        MockUsdgVault stockVault = new MockUsdgVault(IERC20(address(stock)));
        vm.expectRevert(abi.encodeWithSelector(ERC4626Park.WrongAsset.selector, address(stock), address(usdg)));
        new ERC4626Park(IERC4626(address(stockVault)), address(usdg));
        MarketParams memory bad = params;
        bad.lltv = 0.5e18;
        vm.expectRevert(abi.encodeWithSelector(MorphoBluePark.UnknownMarket.selector, keccak256(abi.encode(bad))));
        new MorphoBluePark(IMorphoBlue(MORPHO), bad, address(usdg));
    }

    function test_parkValueUnknownShareReverts() public {
        vm.expectRevert(ShieldedTrade.BadAdapter.selector);
        trade.parkValue(address(stock), 1);
    }

    function test_morphoParkDecimals() public view {
        assertEq(morphoPark.decimals(), 12);
        assertEq(morphoPark.asset(), address(usdg));
        assertEq(morphoPark.shareToken(), address(morphoPark));
        assertEq(morphoPark.marketId(), keccak256(abi.encode(params)));
    }

    function testFuzz_erc4626ParkRoundTripNeverGainsWithoutYield(uint256 amount, uint256 gainBps) public {
        amount = bound(amount, U, 1_000_000 * U);
        gainBps = bound(gainBps, 0, 500);
        _note(address(usdg), amount);
        (uint256 shares,) = _swap(_pub(address(usdg), amount, 0, address(vault), 0));
        uint256 gain = vault.totalAssets() * gainBps / 10_000;
        usdg.mint(address(vault), gain);
        (uint256 back,) = _swap(_pub(address(vault), shares, 0, address(usdg), 0));
        assertLe(back, amount + gain, "never more than deposit + yield");
        assertGe(back + 2, amount + gain, "loses at most rounding");
        _assertBacked(_two(address(usdg), address(vault)));
    }
}
