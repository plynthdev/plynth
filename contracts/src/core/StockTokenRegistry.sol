// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChangeDelay} from "../libs/ChangeDelay.sol";

/// Board-curated list of canonical Stock Tokens and their price feeds. Unknown tokens are never canonical.
/// Listing a token for the first time applies at once (nobody holds a position priced by it yet); changing a listed
/// token's feed or flag, or re-listing a delisted token, waits CHANGE_DELAY (48 h) in public. Delisting applies at
/// once: it only stops new buys (exits never need a canonical token).
contract StockTokenRegistry is ChangeDelay {
    struct Entry {
        address feed;
        bool multiplierEmbedded; // feed already prices one token (multiplier applied), so never re-apply it
        bool active;
    }

    address public owner;
    address public pendingOwner;
    mapping(address token => Entry) private _entries;
    /// When the token was last delisted (0 = never): perp markets measure a delisted token's hold from here.
    mapping(address token => uint64) public delistedAt;
    address[] private _tokens;

    event Listed(address indexed token, address indexed feed, bool multiplierEmbedded);
    event Delisted(address indexed token);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function list(address token, address feed, bool multiplierEmbedded) external onlyOwner {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        Entry memory cur = _entries[token];
        if (cur.active && cur.feed == feed && cur.multiplierEmbedded == multiplierEmbedded) return; // unchanged
        bool fresh = cur.feed == address(0);
        if (!fresh && !_delayed()) return;
        if (fresh) _tokens.push(token);
        _entries[token] = Entry(feed, multiplierEmbedded, true);
        emit Listed(token, feed, multiplierEmbedded);
    }

    function delist(address token) external onlyOwner {
        _entries[token].active = false;
        delistedAt[token] = uint64(block.timestamp);
        emit Delisted(token);
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    function isCanonical(address token) external view returns (bool) {
        return _entries[token].active;
    }

    function entry(address token) external view returns (Entry memory) {
        return _entries[token];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
        _bumpChangeNonce(); // a new owner starts with no queued changes (review v2 L-6)
    }
}
