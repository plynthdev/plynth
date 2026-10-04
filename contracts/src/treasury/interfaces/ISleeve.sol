// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// An adapter the TreasuryAccount calls with `call` (never `delegatecall`). Before the call the account
/// approves the adapter for exact token amounts; the adapter pulls them with `transferFrom`, does its work
/// and sends every result back to `msg.sender` (the account). The account resets the approvals afterwards.
interface IAdapter {
    function run(bytes calldata data) external returns (bytes memory);
}

/// A sleeve is an adapter that also declares which assets it manages for an account and which policy band
/// they count toward. The PolicyGuard values those assets itself (AssetValuation), so a sleeve's
/// `valueOf` must equal the sum of AssetValuation over its declared assets at the account's balances.
interface ISleeve is IAdapter {
    /// 0 = cash band, 1 = equity band (TreasuryAccount.BAND_CASH / BAND_EQUITY).
    function band() external view returns (uint8);

    /// Assets this sleeve can hold for an account, with their instrument kind
    /// (TreasuryPolicy.KIND_CASH / KIND_CASH_VAULT / KIND_STOCK_TOKEN). An asset belongs to one sleeve only.
    function assets() external view returns (address[] memory assets_, uint8[] memory kinds);

    /// USD value (1e18) of what `account` holds in this sleeve; `hold` is true if any price is stale.
    function valueOf(address account) external view returns (uint256 usd, bool hold);
}

/// Read by the PolicyGuard for the drawdown rule. Written by PeriodClose at every close.
interface IPeriodStartNav {
    function periodStartNav() external view returns (uint256);
}
