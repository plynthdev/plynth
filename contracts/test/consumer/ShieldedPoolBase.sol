// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

/// Stand-in verifier: accepts everything, rejects everything, or reverts.
contract SwitchVerifier is IHonkVerifier {
    bool public accept = true;
    bool public reverts;

    function set(bool accept_, bool reverts_) external {
        accept = accept_;
        reverts = reverts_;
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external view returns (bool) {
        if (reverts) revert("bad proof");
        inputs;
        return accept;
    }
}

/// Verifier that only accepts one exact public-input vector: proves the pool passes inputs in circuit order.
contract ExpectVerifier is IHonkVerifier {
    bytes32 public expectedHash;

    function expect_(bytes32[] calldata inputs) external {
        expectedHash = keccak256(abi.encode(inputs));
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external view returns (bool) {
        return keccak256(abi.encode(inputs)) == expectedHash;
    }
}

abstract contract ShieldedPoolBase is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant U = 1e6;

    ShieldedPool internal pool;
    SwitchVerifier internal tv;
    SwitchVerifier internal wv;
    MockUSDG internal usdg;
    MockStockToken internal stock;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");
    address internal crowdAddr = makeAddr("crowd");

    uint256 internal capUsdg = 1_000_000 * U;
    uint256 internal capStock = 1_000_000e18;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        tv = new SwitchVerifier();
        wv = new SwitchVerifier();
        usdg = new MockUSDG();
        stock = new MockStockToken("Mock TSLA", "mTSLA");
        pool = new ShieldedPool(tv, wv, owner);
        _raiseCap(address(usdg), capUsdg);
        _raiseCap(address(stock), capStock);
        vm.prank(owner);
        pool.setCrowd(crowdAddr);
        _fund(alice);
        _fund(bob);
        _fund(crowdAddr);
    }

    function _raiseCap(address asset, uint256 c) internal {
        vm.prank(owner);
        pool.proposeCap(asset, c);
        vm.warp(block.timestamp + pool.CAP_DELAY());
        pool.applyCap(asset);
    }

    function _fund(address who) internal {
        usdg.mint(who, 10_000_000 * U);
        stock.mint(who, 10_000_000e18);
        vm.startPrank(who);
        usdg.approve(address(pool), type(uint256).max);
        stock.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address who, address asset, uint256 raw, uint256 salt) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.deposit(asset, raw, bytes32(salt % P), bytes32((salt * 7 + 1) % P), "");
    }

    function _insertAll() internal {
        vm.warp(block.timestamp + pool.MIN_PENDING_DELAY());
        pool.insertPending(type(uint256).max);
    }

    function _pubT(bytes32 n0, bytes32 n1, address asset) internal view returns (ShieldedPool.PublicTransfer memory t) {
        t.root = pool.currentRoot();
        t.nullifiers = [n0, n1];
        t.outCommitments = [keccak256(abi.encode(n0, "out0")) >> 3, keccak256(abi.encode(n1, "out1")) >> 3];
        t.asset = asset;
    }

    function _pubW(bytes32 n, address asset, uint256 amount, address recipient, uint256 fee)
        internal
        view
        returns (ShieldedPool.PublicWithdraw memory w)
    {
        w.root = pool.currentRoot();
        w.nullifier = n;
        w.changeCommitment = keccak256(abi.encode(n, "change")) >> 3;
        w.asset = asset;
        w.amount = amount;
        w.recipient = recipient;
        w.relayerFee = fee;
    }

    function _notes() internal pure returns (bytes[2] memory e) {
        e[0] = "";
        e[1] = "";
    }
}
