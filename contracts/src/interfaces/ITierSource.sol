// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// What a staking tier unlocks for a treasury whose board holds the stake.
struct Tier {
    uint8 maxDesks; // active (not revoked) desks a factory-made TreasuryAccount may register
    bool weeklyClose; // PeriodClose accepts a period shorter than 28 days
    bool privateSleeve; // the private sleeve may be attached
    uint8 templatePriority; // ordering weight in the templates marketplace (higher first)
}

interface ITierSource {
    function tierOf(address staker) external view returns (Tier memory);
}
