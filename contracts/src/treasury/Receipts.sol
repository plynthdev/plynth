// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";

interface IReceiptsAccount {
    function policy() external view returns (TreasuryPolicy);
}

/// Hourly receipts of every desk decision. Once an hour is over, the treasury's controller posts the Merkle
/// root of that hour's desk actions (each leaf = `leafOf(keccak256(canonical JSON of one desk_actions row))`,
/// guard denials included) and how many leaves it has. A posted hour can never change, so a desk decision
/// cannot be rewritten after the fact without the proof failing.
///
/// One contract serves every treasury: entries are keyed by TreasuryAccount, and only the controller in that
/// account's current policy may post for it. Hours are UTC epoch hours (`timestamp / 3600`). An hour with no
/// desk actions may be posted as (root 0, leafCount 0) to show it was not skipped; a non-empty hour needs a
/// non-zero root. Trees use OpenZeppelin's sorted-pair hashing, so `MerkleProof.verify` checks any leaf.
contract Receipts {
    struct Receipt {
        bytes32 root;
        uint32 leafCount;
        uint64 postedAt;
    }

    mapping(address account => mapping(uint64 hour => Receipt)) private _receipts;
    mapping(address account => uint64) public lastHour; // highest hour posted (0 = none)

    event ReceiptPosted(address indexed account, uint64 indexed hour, bytes32 root, uint32 leafCount, address controller);

    error NotController(address controller);
    error HourNotOver(uint64 hour);
    error AlreadyPosted(uint64 hour);
    error BadRoot();

    function post(address account, uint64 hour, bytes32 root, uint32 leafCount) external {
        address controller = controllerOf(account);
        if (msg.sender != controller) revert NotController(controller);
        if (uint256(hour) >= block.timestamp / 1 hours) revert HourNotOver(hour);
        Receipt storage r = _receipts[account][hour];
        if (r.postedAt != 0) revert AlreadyPosted(hour);
        if ((leafCount == 0) != (root == bytes32(0))) revert BadRoot();
        r.root = root;
        r.leafCount = leafCount;
        r.postedAt = uint64(block.timestamp);
        if (hour > lastHour[account]) lastHour[account] = hour;
        emit ReceiptPosted(account, hour, root, leafCount, msg.sender);
    }

    function receipt(address account, uint64 hour) external view returns (Receipt memory) {
        return _receipts[account][hour];
    }

    /// True if `leaf` is in the posted tree of (account, hour).
    function verify(address account, uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        Receipt storage r = _receipts[account][hour];
        if (r.postedAt == 0 || r.leafCount == 0) return false;
        return MerkleProof.verifyCalldata(proof, r.root, leaf);
    }

    /// Leaf for one desk-action row hash (double hashing keeps leaves apart from inner nodes).
    function leafOf(bytes32 rowHash) public pure returns (bytes32) {
        return keccak256(abi.encode(rowHash));
    }

    /// The controller in the account's current policy (who may post for it).
    function controllerOf(address account) public view returns (address) {
        (TreasuryPolicy.Policy memory p,,) = IReceiptsAccount(account).policy().current();
        return p.controller;
    }
}
