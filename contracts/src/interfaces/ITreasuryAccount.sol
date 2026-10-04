// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TreasuryPolicy} from "../treasury/TreasuryPolicy.sol";

/// What the PolicyGuard and BoardApprovals read from a TreasuryAccount.
interface ITreasuryAccount {
    function board() external view returns (address);
    function policy() external view returns (TreasuryPolicy);
    function approvals() external view returns (address);
    function periodClose() external view returns (address);
    /// The private sleeve (PrivateSleeve), zero if none.
    function privateSleeve() external view returns (address);
    function isDeskKey(address key) external view returns (bool);
    /// Every asset of every sleeve the account has ever registered, with its kind and band.
    /// Registered sleeves whose value sits at perp venues (IPositionSleeve).
    function positionSleeves() external view returns (address[] memory);
    function trackedAssets() external view returns (address[] memory assets, uint8[] memory kinds, uint8[] memory bands);
}
