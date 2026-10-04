// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITreasuryAccount} from "./interfaces/ITreasuryAccount.sol";

/// Board sign-off for large desk operations (policy rule 9).
///
/// A desk asks for a ticket for one exact operation (`opHash`, see TreasuryAccount.opHashOf). The board
/// approves or rejects it. The PolicyGuard consumes an approved ticket once, for that opHash only, within
/// `TTL` of the request. One BoardApprovals serves one TreasuryAccount, bound once by the board.
contract BoardApprovals {
    uint64 public constant TTL = 24 hours;

    enum Status {
        None,
        Requested,
        Approved,
        Rejected,
        Consumed
    }

    struct Ticket {
        bytes32 opHash;
        address requester;
        uint64 requestedAt;
        uint64 decidedAt;
        Status status;
    }

    address public immutable board;
    address public immutable guard;
    address public account;
    uint256 public ticketCount;
    mapping(bytes32 ticket => Ticket) private _tickets;

    event AccountBound(address indexed account);
    event Requested(bytes32 indexed ticket, bytes32 indexed opHash, address indexed requester);
    event Approved(bytes32 indexed ticket, bytes32 indexed opHash);
    event Rejected(bytes32 indexed ticket, bytes32 indexed opHash);
    event Consumed(bytes32 indexed ticket, bytes32 indexed opHash);

    error NotBoard();
    error NotGuard();
    error NotDesk();
    error ZeroAddress();
    error AlreadyBound();
    error NotBound();
    error WrongAccount();
    error BadStatus(Status status);
    error Expired();
    error InvalidTicket();

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    constructor(address board_, address guard_) {
        if (board_ == address(0) || guard_ == address(0)) revert ZeroAddress();
        board = board_;
        guard = guard_;
    }

    function bindAccount(address account_) external onlyBoard {
        if (account != address(0)) revert AlreadyBound();
        if (account_ == address(0)) revert ZeroAddress();
        account = account_;
        emit AccountBound(account_);
    }

    /// Called by a desk key of the bound account. Returns the ticket id (1, 2, 3, ... as bytes32).
    function request(bytes32 opHash) external returns (bytes32 ticket) {
        address a = account;
        if (a == address(0)) revert NotBound();
        if (!ITreasuryAccount(a).isDeskKey(msg.sender)) revert NotDesk();
        ticket = bytes32(++ticketCount);
        _tickets[ticket] = Ticket(opHash, msg.sender, uint64(block.timestamp), 0, Status.Requested);
        emit Requested(ticket, opHash, msg.sender);
    }

    function approve(bytes32 ticket) external onlyBoard {
        Ticket storage t = _tickets[ticket];
        if (t.status != Status.Requested) revert BadStatus(t.status);
        if (block.timestamp > t.requestedAt + TTL) revert Expired();
        t.status = Status.Approved;
        t.decidedAt = uint64(block.timestamp);
        emit Approved(ticket, t.opHash);
    }

    function reject(bytes32 ticket) external onlyBoard {
        Ticket storage t = _tickets[ticket];
        if (t.status != Status.Requested && t.status != Status.Approved) revert BadStatus(t.status);
        t.status = Status.Rejected;
        t.decidedAt = uint64(block.timestamp);
        emit Rejected(ticket, t.opHash);
    }

    /// True if `ticket` is approved, unused, for `opHash`, for `account_`, and requested at most TTL ago.
    function isValid(bytes32 ticket, bytes32 opHash, address account_) public view returns (bool) {
        Ticket storage t = _tickets[ticket];
        return account_ == account && account_ != address(0) && t.status == Status.Approved && t.opHash == opHash
            && block.timestamp <= t.requestedAt + TTL;
    }

    /// Guard only, once per ticket.
    function consume(bytes32 ticket, bytes32 opHash, address account_) external {
        if (msg.sender != guard) revert NotGuard();
        if (account_ != account) revert WrongAccount();
        if (!isValid(ticket, opHash, account_)) revert InvalidTicket();
        _tickets[ticket].status = Status.Consumed;
        emit Consumed(ticket, opHash);
    }

    function ticketOf(bytes32 ticket) external view returns (Ticket memory) {
        return _tickets[ticket];
    }
}
