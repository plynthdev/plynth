// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test stand-in for a Safe: the two views the MainnetBeta OWNER pin reads (getThreshold, getOwners).
contract MockSafe {
    address[] internal _owners;
    uint256 internal _threshold;

    constructor(address[] memory owners_, uint256 threshold_) {
        _owners = owners_;
        _threshold = threshold_;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }
}
