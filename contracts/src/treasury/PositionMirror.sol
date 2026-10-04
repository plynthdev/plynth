// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IPerpVenue} from "../interfaces/IPerpVenue.sol";

/// The on-chain copy of what off-chain perp venues (Orderly, Arcus) hold for a treasury. The risk service
/// reads each venue, and the policy's controller signs a snapshot `(venue, positions, equityUsd, flowInSeen, ts)`
/// (EIP-712; EIP-1271 for a contract controller). Anyone may submit a signed snapshot.
///
/// `flowInSeen` is the venue adapter's cumulative deposit counter the controller has accounted for, so margin
/// deposited after the snapshot still counts in NAV until the next one (no race between deposit and snapshot).
///
/// A snapshot older than STALE_AFTER makes the venue stale: the PolicyGuard then blocks new risk on it but
/// still lets the desks reduce it. One mirror per TreasuryPolicy (its controller signs).
contract PositionMirror is EIP712 {
    uint256 public constant STALE_AFTER = 10 minutes;
    uint256 public constant MAX_POSITIONS = 32;

    bytes32 public constant POSITION_TYPEHASH = keccak256("Position(address underlying,int256 tokens)");
    bytes32 public constant SNAPSHOT_TYPEHASH = keccak256(
        "Snapshot(address venue,Position[] positions,uint256 equityUsd,uint256 flowInSeen,uint64 ts)Position(address underlying,int256 tokens)"
    );

    struct Snap {
        uint256 equityUsd; // 1e18
        uint256 flowInSeen; // adapter cash units
        uint64 ts;
        IPerpVenue.Position[] positions;
    }

    TreasuryPolicy public immutable policy;
    mapping(address venue => Snap) private _latest;

    event MirrorPosted(address indexed venue, uint64 ts, uint256 equityUsd, uint256 flowInSeen, bytes32 positionsHash);

    error BadTimestamp(uint64 ts);
    error TooManyPositions();
    error BadSignature();

    constructor(TreasuryPolicy policy_) EIP712("Plinth PositionMirror", "1") {
        policy = policy_;
    }

    function post(
        address venue,
        IPerpVenue.Position[] calldata positions,
        uint256 equityUsd,
        uint256 flowInSeen,
        uint64 ts,
        bytes calldata signature
    ) external {
        Snap storage s = _latest[venue];
        // Strictly newer (no replay, no rollback), not from the future, not already stale on arrival.
        if (ts <= s.ts || ts > block.timestamp || block.timestamp - ts > STALE_AFTER) revert BadTimestamp(ts);
        if (positions.length > MAX_POSITIONS) revert TooManyPositions();
        bytes32 posHash = hashPositions(positions);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SNAPSHOT_TYPEHASH, venue, posHash, equityUsd, flowInSeen, ts))
        );
        (TreasuryPolicy.Policy memory p,,) = policy.current();
        if (!SignatureChecker.isValidSignatureNow(p.controller, digest, signature)) revert BadSignature();

        s.equityUsd = equityUsd;
        s.flowInSeen = flowInSeen;
        s.ts = ts;
        delete s.positions;
        for (uint256 i; i < positions.length; ++i) {
            s.positions.push(positions[i]);
        }
        emit MirrorPosted(venue, ts, equityUsd, flowInSeen, posHash);
    }

    // ---------------------------------------------------------------- views

    function latest(address venue)
        external
        view
        returns (IPerpVenue.Position[] memory positions, uint256 equityUsd, uint256 flowInSeen, uint64 ts)
    {
        Snap storage s = _latest[venue];
        return (s.positions, s.equityUsd, s.flowInSeen, s.ts);
    }

    /// No snapshot yet, or the last one is older than STALE_AFTER.
    function isStale(address venue) public view returns (bool) {
        uint64 ts = _latest[venue].ts;
        return ts == 0 || block.timestamp - ts > STALE_AFTER;
    }

    /// EIP-712 array hash: keccak of the concatenated struct hashes.
    function hashPositions(IPerpVenue.Position[] calldata positions) public pure returns (bytes32) {
        bytes32[] memory hs = new bytes32[](positions.length);
        for (uint256 i; i < positions.length; ++i) {
            hs[i] = keccak256(abi.encode(POSITION_TYPEHASH, positions[i].underlying, positions[i].tokens));
        }
        return keccak256(abi.encodePacked(hs));
    }

    function digestOf(address venue, IPerpVenue.Position[] calldata positions, uint256 equityUsd, uint256 flowInSeen, uint64 ts)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(SNAPSHOT_TYPEHASH, venue, hashPositions(positions), equityUsd, flowInSeen, ts))
        );
    }
}
