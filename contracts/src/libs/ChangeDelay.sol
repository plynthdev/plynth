// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// A 48-hour public delay for admin changes that could hurt users (feeds, pools, keepers, risk params): the first
/// call of a setter with given arguments only queues it (`ChangeQueued`, with the exact calldata), the same call
/// again once the delay has passed applies it. The owner can cancel a queued change. Each contract decides which
/// changes are harmless enough to apply at once (first-time setup, risk-reducing ones) and documents them.
///
/// A queued change is good for CHANGE_EXPIRY after its eta: later, the same call queues it again with a fresh
/// notice instead of applying a change announced long ago (review v2 L-6). The id also carries `changeNonce`,
/// which the contract bumps on every ownership change, so a change queued by one owner (the deployer) can never be
/// applied by the next one without a notice of its own.
abstract contract ChangeDelay {
    uint64 public constant CHANGE_DELAY = 48 hours;
    uint64 public constant CHANGE_EXPIRY = 14 days;

    /// Bumped on every ownership change; part of every change id.
    uint256 public changeNonce;
    /// changeId(calldata) => when it may be applied (0 = not queued).
    mapping(bytes32 id => uint64 eta) public changeEta;

    event ChangeQueued(bytes32 indexed id, bytes data, uint64 eta);
    event ChangeApplied(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);
    event ChangeNonceBumped(uint256 nonce);

    error ChangeTooEarly(bytes32 id, uint64 eta);
    error ChangeNotQueued(bytes32 id);

    /// The id of a setter call (its full calldata) under the current owner.
    function changeId(bytes memory data) public view returns (bytes32) {
        return keccak256(abi.encode(changeNonce, data));
    }

    /// Queues `msg.data` the first time (or once an earlier queue has expired) and returns false; returns true (and
    /// clears the entry) once its delay has passed. Call it from an access-controlled setter:
    /// `if (!_delayed()) return;`.
    function _delayed() internal returns (bool ready) {
        bytes32 id = changeId(msg.data);
        uint64 eta = changeEta[id];
        if (eta == 0 || block.timestamp > uint256(eta) + CHANGE_EXPIRY) {
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

    /// Call on every ownership change: every change queued so far is void.
    function _bumpChangeNonce() internal {
        uint256 n = changeNonce + 1;
        changeNonce = n;
        emit ChangeNonceBumped(n);
    }
}
