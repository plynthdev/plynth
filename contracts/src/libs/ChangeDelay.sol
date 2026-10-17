// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// A 48-hour public delay for admin changes that could hurt users (feeds, pools, keepers, risk params): the first
/// call of a setter with given arguments only queues it (`ChangeQueued`, with the exact calldata), the same call
/// again once the delay has passed applies it. The owner can cancel a queued change. Each contract decides which
/// changes are harmless enough to apply at once (first-time setup, risk-reducing ones) and documents them.
abstract contract ChangeDelay {
    uint64 public constant CHANGE_DELAY = 48 hours;

    /// keccak256 of the setter's calldata => when it may be applied (0 = not queued).
    mapping(bytes32 id => uint64 eta) public changeEta;

    event ChangeQueued(bytes32 indexed id, bytes data, uint64 eta);
    event ChangeApplied(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);

    error ChangeTooEarly(bytes32 id, uint64 eta);
    error ChangeNotQueued(bytes32 id);

    /// Queues `msg.data` the first time and returns false; returns true (and clears the entry) once its delay has
    /// passed. Call it from an access-controlled setter: `if (!_delayed()) return;`.
    function _delayed() internal returns (bool ready) {
        bytes32 id = keccak256(msg.data);
        uint64 eta = changeEta[id];
        if (eta == 0) {
            eta = uint64(block.timestamp) + CHANGE_DELAY;
            changeEta[id] = eta;
            emit ChangeQueued(id, msg.data, eta);
            return false;
        }
        if (block.timestamp < eta) revert ChangeTooEarly(id, eta);
        delete changeEta[id];
        emit ChangeApplied(id);
        return true;
    }

    function _cancelChange(bytes32 id) internal {
        if (changeEta[id] == 0) revert ChangeNotQueued(id);
        delete changeEta[id];
        emit ChangeCancelled(id);
    }
}
