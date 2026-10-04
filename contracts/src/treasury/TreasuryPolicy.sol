// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// The board's investment policy, stored as data the treasury contracts enforce.
///
/// The first policy (constructor) is active immediately. Every later policy is proposed by the board,
/// waits `TIMELOCK` in public, and is then activated by anyone. Every activated version is kept forever so
/// a period close can prove which policy was in force at any timestamp (`versionAt`).
///
/// Tier 1 (T1) has no venues, no perps and no hedge overlay, so those fields must be zero.
/// Non-upgradeable. The board is a plain address (a Safe in production).
contract TreasuryPolicy {
    uint64 public constant TIMELOCK = 48 hours;
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_NAME_FLOAT_BPS = 200;
    uint32 public constant MIN_PERIOD = 1 days;

    /// Instrument kinds used in `instrumentAllowRoot` leaves: keccak256(abi.encode(asset, uint8(kind))).
    uint8 public constant KIND_CASH = 0; // a dollar stablecoin held directly (USDG)
    uint8 public constant KIND_CASH_VAULT = 1; // an ERC-4626 vault over a dollar stablecoin
    uint8 public constant KIND_STOCK_TOKEN = 2; // a Robinhood Stock Token

    struct Band {
        uint16 minBps;
        uint16 maxBps;
    }

    struct Policy {
        Band cash;
        Band equity;
        Band basis;
        int16 netDeltaMinBps;
        int16 netDeltaMaxBps;
        uint16 maxLeverageX10;
        uint64 perOrderCapUsd;
        uint64 perDayCapUsd;
        uint16 perNameFloatCapBps;
        uint16 perVenueCapBps;
        bool noNewRiskOffHours;
        int16 pauseNewRiskAtDrawdownBps;
        int16 deriskAtDrawdownBps;
        uint64 approvalAboveUsd;
        uint32 periodSeconds;
        bytes32 instrumentAllowRoot;
        bytes32 venueAllowRoot;
        address controller;
    }

    address public immutable board;

    uint32 private _version; // latest active version, starts at 1
    mapping(uint32 version => Policy) private _policies;
    mapping(uint32 version => bytes32) private _hashes;
    mapping(uint32 version => uint64) private _activatedAt;

    Policy private _pending;
    bytes32 public pendingHash;
    uint64 public pendingEta; // 0 = nothing pending

    event PolicyProposed(bytes32 indexed hash, uint64 eta);
    event PolicyCancelled(bytes32 indexed hash);
    event PolicyActivated(bytes32 indexed hash, uint32 indexed version);

    error NotBoard();
    error ZeroAddress();
    error NothingPending();
    error TimelockActive(uint64 eta);
    error UnknownVersion(uint32 version);
    error BadBand();
    error BadBandSums();
    error T1Basis();
    error T1NetDelta();
    error T1Leverage();
    error T1Venue();
    error FloatCapTooHigh();
    error BadDrawdown();
    error BadPeriod();

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    constructor(address board_, Policy memory initial) {
        if (board_ == address(0)) revert ZeroAddress();
        board = board_;
        validate(initial);
        _activate(initial, keccak256(abi.encode(initial)));
    }

    // ---------------------------------------------------------------- board

    /// Validates `p` and stores it as the single pending proposal. A new proposal replaces the old one and
    /// restarts the clock.
    function propose(Policy calldata p) external onlyBoard {
        validate(p);
        bytes32 h = keccak256(abi.encode(p));
        uint64 eta = uint64(block.timestamp) + TIMELOCK;
        _pending = p;
        pendingHash = h;
        pendingEta = eta;
        emit PolicyProposed(h, eta);
    }

    function cancel() external onlyBoard {
        if (pendingEta == 0) revert NothingPending();
        bytes32 h = pendingHash;
        _clearPending();
        emit PolicyCancelled(h);
    }

    // ---------------------------------------------------------------- anyone

    function activate() external {
        uint64 eta = pendingEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockActive(eta);
        Policy memory p = _pending;
        bytes32 h = pendingHash;
        _clearPending();
        _activate(p, h);
    }

    // ---------------------------------------------------------------- views

    function current() external view returns (Policy memory, bytes32 hash, uint32 version) {
        version = _version;
        return (_policies[version], _hashes[version], version);
    }

    function policyAt(uint32 version) external view returns (Policy memory, bytes32 hash, uint64 activatedAt) {
        if (version == 0 || version > _version) revert UnknownVersion(version);
        return (_policies[version], _hashes[version], _activatedAt[version]);
    }

    function pending() external view returns (Policy memory, bytes32 hash, uint64 eta) {
        return (_pending, pendingHash, pendingEta);
    }

    /// The version in force at `timestamp`: the latest one activated at or before it. 0 if before the first.
    function versionAt(uint64 timestamp) external view returns (uint32) {
        uint32 lo = 1;
        uint32 hi = _version;
        if (timestamp < _activatedAt[lo]) return 0;
        while (lo < hi) {
            uint32 mid = hi - (hi - lo) / 2; // upper mid, so lo always moves
            if (_activatedAt[mid] <= timestamp) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    function hashPolicy(Policy calldata p) external pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function instrumentLeaf(address asset, uint8 kind) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, kind));
    }

    /// True if (asset, kind) is in the current policy's instrument allowlist (sorted-pair Merkle proof).
    function isInstrumentAllowed(address asset, uint8 kind, bytes32[] calldata proof) external view returns (bool) {
        return MerkleProof.verifyCalldata(proof, _policies[_version].instrumentAllowRoot, instrumentLeaf(asset, kind));
    }

    /// Reverts with a specific error if `p` breaks a rule. Pure, so tools can dry-run a policy.
    function validate(Policy memory p) public pure {
        _checkBand(p.cash);
        _checkBand(p.equity);
        _checkBand(p.basis);
        uint256 sumMin = uint256(p.cash.minBps) + p.equity.minBps + p.basis.minBps;
        uint256 sumMax = uint256(p.cash.maxBps) + p.equity.maxBps + p.basis.maxBps;
        if (sumMin > BPS || sumMax < BPS) revert BadBandSums();

        if (p.basis.minBps != 0 || p.basis.maxBps != 0) revert T1Basis();
        if (p.netDeltaMinBps != 0 || p.netDeltaMaxBps != 0) revert T1NetDelta();
        if (p.maxLeverageX10 != 0) revert T1Leverage();
        if (p.perVenueCapBps != 0 || p.venueAllowRoot != bytes32(0)) revert T1Venue();
        if (p.perNameFloatCapBps > MAX_NAME_FLOAT_BPS) revert FloatCapTooHigh();

        if (!(p.deriskAtDrawdownBps < p.pauseNewRiskAtDrawdownBps && p.pauseNewRiskAtDrawdownBps <= 0)) {
            revert BadDrawdown();
        }
        if (p.periodSeconds < MIN_PERIOD) revert BadPeriod();
        if (p.controller == address(0)) revert ZeroAddress();
    }

    // ---------------------------------------------------------------- internal

    function _checkBand(Band memory b) private pure {
        if (b.minBps > b.maxBps || b.maxBps > BPS) revert BadBand();
    }

    function _activate(Policy memory p, bytes32 h) private {
        uint32 v = _version + 1;
        _version = v;
        _policies[v] = p;
        _hashes[v] = h;
        _activatedAt[v] = uint64(block.timestamp);
        emit PolicyActivated(h, v);
    }

    function _clearPending() private {
        delete _pending;
        delete pendingHash;
        delete pendingEta;
    }
}
