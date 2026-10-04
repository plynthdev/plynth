// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Read side of the eligibility registry: the only call SavingsVault and CrowdBuy make.
interface IEligibility {
    function isEligible(address user) external view returns (bool);
}
