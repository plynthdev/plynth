// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";

/// Commit-reveal execution timing. On Robinhood Chain `block.prevrandao` is a counter, and Chainlink VRF
/// is paid, so the keeper commits to a secret before a window opens and reveals it at the execution time.
/// commitment = keccak256(abi.encode(secret, key)); the execution time is `windowStart + offset` with
/// offset = keccak256(abi.encode(OFFSET_TAG, secret, key)) mod (window - GRACE), a different hash than the
/// commitment, so the published commitment says nothing about the time. A reveal is accepted only from the
/// execution time on (until windowEnd - GRACE), so revealing never publishes the time before it has come.
///
/// Trust: the keeper knows the execution time in advance (it chose the secret). This hides the time from
/// the public, not from the keeper. If the keeper never reveals, execution falls back to
/// `windowEnd - GRACE`, so a dead keeper delays execution but never blocks it.
contract JitterBeacon is Ownable, ChangeDelay {
    /// Hard floor for the deploy-time GRACE (mainnet/fork deploys use 1 hour; testnet 15 minutes).
    uint64 public constant MIN_GRACE = 10 minutes;
    /// The tail of every window in which no reveal is accepted; the fallback execution time is windowEnd - GRACE.
    uint64 public immutable GRACE;
    bytes32 public constant OFFSET_TAG = keccak256("plynth.jitter-beacon.offset");

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
    error RevealTooEarly(uint64 executeAt);
    error GraceTooShort();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(address keeper_, address owner_, uint64 grace_) Ownable(owner_) {
        if (keeper_ == address(0)) revert ZeroAddress();
        if (grace_ < MIN_GRACE) revert GraceTooShort();
        GRACE = grace_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// A new keeper waits CHANGE_DELAY (48 h) in public.
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        if (!_delayed()) return;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    /// Commits `commitment = keccak256(abi.encode(secret, key))` for a window that has not started yet.
    function commit(bytes32 key, uint64 windowStart, uint64 windowEnd, bytes32 commitment) external onlyKeeper {
        if (_beacons[key].commitment != bytes32(0)) revert AlreadyCommitted(key);
        if (block.timestamp >= windowStart) revert WindowAlreadyStarted();
        if (windowEnd <= windowStart || windowEnd - windowStart <= GRACE) revert WindowTooShort();
        _beacons[key] = Beacon(windowStart, windowEnd, 0, commitment);
        emit Committed(key, windowStart, windowEnd, commitment);
    }

    /// Anyone may reveal from the execution time it sets (never earlier: that would publish the time ahead)
    /// until `windowEnd - GRACE`. A late reveal reverts: the deterministic fallback time already applies.
    function reveal(bytes32 key, bytes32 secret) external {
        Beacon storage b = _beacons[key];
        if (b.commitment == bytes32(0)) revert UnknownKey(key);
        if (b.executeAt != 0) revert AlreadyRevealed(key);
        if (block.timestamp < b.windowStart) revert WindowNotStarted();
        if (block.timestamp >= b.windowEnd - GRACE) revert RevealTooLate();
        if (keccak256(abi.encode(secret, key)) != b.commitment) revert WrongSecret();
        uint64 at = b.windowStart + offsetOf(secret, key, b.windowStart, b.windowEnd);
        if (block.timestamp < at) revert RevealTooEarly(at);
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

    /// offset = uint256(keccak256(abi.encode(OFFSET_TAG, secret, key))) % (windowEnd - windowStart - GRACE).
    /// Domain-separated from the commitment: the old offset was the commitment itself mod the range.
    function offsetOf(bytes32 secret, bytes32 key, uint64 windowStart, uint64 windowEnd) public view returns (uint64) {
        return uint64(uint256(keccak256(abi.encode(OFFSET_TAG, secret, key))) % (windowEnd - windowStart - GRACE));
    }
}
