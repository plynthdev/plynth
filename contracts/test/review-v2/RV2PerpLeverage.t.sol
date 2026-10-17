// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpSleeveTest} from "../treasury/sleeves/PerpSleeve.t.sol";

/// review-v2 V2-L9 / V2-L10 regressions: L-5's per-position leverage check, attacked as new code.
contract RV2PerpLeverageTest is PerpSleeveTest {
    function _ratioX100() internal view returns (uint256) {
        return inHouse.positionOf()[0].marginUsd == 0
            ? type(uint256).max
            : _notional() * 100 / inHouse.positionOf()[0].marginUsd;
    }

    function _notional() internal view returns (uint256) {
        int256 t = inHouse.positionOf()[0].tokens;
        (uint256 usd,) = valuer.value(address(aapl), uint256(t < 0 ? -t : t));
        return usd;
    }

    function _drifted(uint256 deposit) internal {
        _activateT2();
        _depositTo(0, deposit);
        _short(150_000e6, 55_000e6); // 2.7x
        aaplFeed.set(230e8); // the short loses: ~5.3x
        _warp(block.timestamp);
        assertGt(_ratioX100(), 500, "drifted far over the 3x cap");
    }

    /// V2-L9: the PoC grew a drifted 5.3x position by $100k at ~5.1x (ratio "lowered"). Growth of an over-cap
    /// position is now refused whatever its ratio does; within the cap it is still allowed.
    function test_rv2_driftedPositionCannotBeGrownAboveCap() public {
        _drifted(150_000e6);
        uint256 nBefore = _notional();
        _expectCode(guard.R5_LEVERAGE());
        _short(100_000e6, 19_500e6); // +100k notional at ~5.1x: refused
        assertEq(_notional(), nBefore, "size unchanged");
        // Growing it back within 3x is fine: 272.5k notional needs > 90.8k margin (32k left + 60k new).
        _short(100_000e6, 60_000e6);
        assertLe(_ratioX100(), 300, "now within the cap");
    }

    /// V2-L10: with all margin posted (no idle cash at the venue), a margin rescue deposit into the venue must go
    /// through: the drifted position is unchanged by it, and an unchanged position is not a new risk.
    function test_rv2_marginRescueAllowedWhenNoIdle() public {
        _drifted(55_000e6); // all cash posted
        uint256 r = _ratioX100();
        _depositTo(0, 40_000e6); // risk-reducing deposit: accepted
        _short(0, 40_000e6); // and onto the position: margin only
        assertLt(_ratioX100(), r, "rescued");
        assertLe(_ratioX100(), 300);
    }
}
