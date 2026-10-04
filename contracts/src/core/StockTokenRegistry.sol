// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Board-curated list of canonical Stock Tokens and their price feeds. Unknown tokens are never canonical.
contract StockTokenRegistry {
    struct Entry {
        address feed;
        bool multiplierEmbedded; // feed already prices one token (multiplier applied), so never re-apply it
        bool active;
    }

    address public owner;
    address public pendingOwner;
    mapping(address token => Entry) private _entries;
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
        if (_entries[token].feed == address(0)) _tokens.push(token);
        _entries[token] = Entry(feed, multiplierEmbedded, true);
        emit Listed(token, feed, multiplierEmbedded);
    }

    function delist(address token) external onlyOwner {
        _entries[token].active = false;
        emit Delisted(token);
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
    }
}
