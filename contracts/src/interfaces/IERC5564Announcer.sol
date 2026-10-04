// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// ERC-5564 singleton announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564 on 4663 and 46630).
interface IERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}
