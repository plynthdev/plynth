// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITreasuryAccount} from "../interfaces/ITreasuryAccount.sol";

interface IAdapterAllowListGate {
    function isAdapterAllowed(address adapter) external view returns (bool);
}

/// The gate a perp sleeve's `addVenue` shares with `TreasuryAccount.registerDesk`: a factory treasury only takes
/// venues whose runtime codehash is on the factory's allow-list, and after the account's setup window only after a
/// public proposal has waited the policy TIMELOCK (and not expired).
library AdapterGate {
    uint64 internal constant EXPIRY = 14 days;

    error AdapterNotAllowed(address adapter);
    error AdapterNotProposed(address adapter);
    error AdapterTimelockActive(address adapter, uint64 eta);

    function allowed(address account, address adapter) internal view {
        address f = ITreasuryAccount(account).factory();
        if (f != address(0) && !IAdapterAllowListGate(f).isAdapterAllowed(adapter)) revert AdapterNotAllowed(adapter);
    }

    function propose(mapping(address => uint64) storage eta, address account, address adapter)
        internal
        returns (uint64 e)
    {
        allowed(account, adapter);
        e = uint64(block.timestamp + ITreasuryAccount(account).policy().TIMELOCK());
        eta[adapter] = e;
    }

    function apply_(mapping(address => uint64) storage eta, address account, address adapter) internal {
        allowed(account, adapter);
        if (block.timestamp <= ITreasuryAccount(account).setupEndsAt()) return; // setup window (inclusive)
        uint64 e = eta[adapter];
        if (e == 0 || block.timestamp > uint256(e) + EXPIRY) revert AdapterNotProposed(adapter);
        if (block.timestamp < e) revert AdapterTimelockActive(adapter, e);
        delete eta[adapter];
    }
}
