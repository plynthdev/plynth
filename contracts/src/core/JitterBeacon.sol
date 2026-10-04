// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Commit-reveal execution timing. On Robinhood Chain `block.prevrandao` is a counter, and Chainlink VRF
/// is paid, so the keeper commits to a secret before a window opens and reveals it once the window is open.
/// The execution time is `windowStart + offset`, offset = keccak256(abi.encode(secret, key)) mod (window - GRACE).
///
/// Trust: the keeper knows the execution time in advance (it chose the secret). This hides the time from
/// the public, not from the keeper. If the keeper never reveals, execution falls back to
/// `windowEnd - GRACE`, so a dead keeper delays execution but never blocks it.
contract JitterBeacon is Ownable {
    uint64 public constant GRACE = 1 hours;

    struct Beacon {
        uint64 windowStart;
        uint64 windowEnd;
        uint64 executeAt; // 0 until revealed
        bytes32 commitment;
    }

    address public keeper;
    mapping(bytes32 key => Beacon) private _beacons;

    event KeeperSet(address indexed keeper);
    event Committed(bytes32 indexed key, uint64 windowStart, uint64 windowEnd, bytes32 commitment);
    event Revealed(bytes32 indexed key, bytes32 secret, uint64 executeAt);

    error NotKeeper();
    error ZeroAddress();
    error AlreadyCommitted(bytes32 key);
    error UnknownKey(bytes32 key);
    error AlreadyRevealed(bytes32 key);
    error WindowTooShort();
    error WindowAlreadyStarted();
    error WindowNotStarted();
    error RevealTooLate();
    error WrongSecret();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(address keeper_, address owner_) Ownable(owner_) {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Commits `commitment = keccak256(abi.encode(secret, key))` for a window that has not started yet.
    function commit(bytes32 key, uint64 windowStart, uint64 windowEnd, bytes32 commitment) external onlyKeeper {
        if (_beacons[key].commitment != bytes32(0)) revert AlreadyCommitted(key);
        if (block.timestamp >= windowStart) revert WindowAlreadyStarted();
        if (windowEnd <= windowStart || windowEnd - windowStart <= GRACE) revert WindowTooShort();
        _beacons[key] = Beacon(windowStart, windowEnd, 0, commitment);
        emit Committed(key, windowStart, windowEnd, commitment);
    }

    /// Anyone may reveal once the window is open and before `windowEnd - GRACE`.
    /// A late reveal reverts: the deterministic fallback time already applies.
    function reveal(bytes32 key, bytes32 secret) external {
        Beacon storage b = _beacons[key];
        if (b.commitment == bytes32(0)) revert UnknownKey(key);
        if (b.executeAt != 0) revert AlreadyRevealed(key);
        if (block.timestamp < b.windowStart) revert WindowNotStarted();
        if (block.timestamp >= b.windowEnd - GRACE) revert RevealTooLate();
        if (keccak256(abi.encode(secret, key)) != b.commitment) revert WrongSecret();
        uint64 at = b.windowStart + offsetOf(secret, key, b.windowStart, b.windowEnd);
        b.executeAt = at;
        emit Revealed(key, secret, at);
    }

    /// Earliest time execution may happen. Unknown key: type(uint64).max. Not revealed: the fallback
    /// `windowEnd - GRACE` (a reveal can only move it earlier, never later).
    function executeAfter(bytes32 key) external view returns (uint64) {
        Beacon memory b = _beacons[key];
        if (b.commitment == bytes32(0)) return type(uint64).max;
        if (b.executeAt != 0) return b.executeAt;
        return b.windowEnd - GRACE;
    }

    function beacon(bytes32 key) external view returns (Beacon memory) {
        return _beacons[key];
    }

    /// offset = uint256(keccak256(abi.encode(secret, key))) % (windowEnd - windowStart - GRACE)
    function offsetOf(bytes32 secret, bytes32 key, uint64 windowStart, uint64 windowEnd) public pure returns (uint64) {
        return uint64(uint256(keccak256(abi.encode(secret, key))) % (windowEnd - windowStart - GRACE));
    }
}
