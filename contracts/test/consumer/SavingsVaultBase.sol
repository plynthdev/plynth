// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {ISignatureTransfer, IAllowanceTransfer} from "../../src/interfaces/IPermit2.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {Permit2Code} from "./Permit2Code.sol";

abstract contract SavingsVaultBase is Test {
    uint256 internal constant U = 1e6; // USDG base units

    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    MockUSDG internal usdg;
    StockTokenRegistry internal registry;
    SavingsVault internal vault;
    address internal permit2 = Permit2Code.PERMIT2;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal crowd = makeAddr("crowd");
    address internal alice;
    uint256 internal alicePk;
    address internal bob = makeAddr("bob");

    address internal tsla = makeAddr("TSLA");
    address internal nvda = makeAddr("NVDA");
    address internal aapl = makeAddr("AAPL");
    address internal msft = makeAddr("MSFT");
    address internal meta = makeAddr("META");
    address internal mstr = makeAddr("MSTR");

    function setUp() public virtual {
        vm.etch(permit2, Permit2Code.RUNTIME);
        (alice, alicePk) = makeAddrAndKey("alice");
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        address feed = makeAddr("feed");
        registry.list(tsla, feed, true);
        registry.list(nvda, feed, true);
        registry.list(aapl, feed, true);
        registry.list(msft, feed, true);
        registry.list(meta, feed, true);
        registry.list(mstr, feed, true);
        vault = new SavingsVault(IERC20(address(usdg)), permit2, ICanonicalRegistry(address(registry)), owner, keeper);
        vm.prank(owner);
        vault.setCrowd(crowd);
        vm.warp(1_760_000_000);
    }

    function _fund(address user, uint256 amount) internal {
        usdg.mint(user, amount);
        vm.startPrank(user);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _settings(address user, uint8 roundTo, uint8 mult, uint256 cap, uint256 topUp) internal {
        vm.prank(user);
        vault.setSettings(SavingsVault.Settings(roundTo, mult, uint64(cap), uint64(topUp), 0));
    }

    function _mix1(address user, address token) internal {
        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](1);
        m[0] = SavingsVault.MixEntry(token, 10_000);
        vm.prank(user);
        vault.setMix(m);
    }

    function _avail(address user) internal view returns (uint256 a) {
        (a,) = vault.balancesOf(user);
    }

    function _pend(address user) internal view returns (uint256 p) {
        (, p) = vault.balancesOf(user);
    }

    function _signPermit(uint256 pk, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig)
    {
        p = ISignatureTransfer.PermitTransferFrom(ISignatureTransfer.TokenPermissions(address(usdg), amount), nonce, deadline);
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TRANSFER_FROM_TYPEHASH,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(usdg), amount)),
                address(vault),
                nonce,
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _signLink(uint256 walletPk, address user, address wallet, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(vault.LINK_TYPEHASH(), user, wallet, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
