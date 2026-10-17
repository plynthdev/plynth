// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Valuer} from "../../src/core/Valuer.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Test-only: a PerpMarket whose front-running guards (and minimum collateral) can be switched off, so the PnL, fee, funding and
/// liquidation unit tests keep their exact reference numbers. Tests of the guards themselves (PerpAudit) put the
/// production values back; every other suite (invariant, kit, treasury, fork) runs the real contract.
contract PerpMarketHarness is PerpMarket {
    constructor(PerpPool pool_, Valuer valuer_, address underlying_, address owner_)
        PerpMarket(pool_, valuer_, underlying_, owner_)
    {}

    /// Open spread, minimum hold and minimum collateral off; the minimum liquidation reward stays (it changes
    /// no payout above it).
    function guardsOff() external {
        (openSpreadBps, minHoldSeconds, minCollateral) = (0, 0, 0);
    }

    /// Bounds-checked params without the timelock (the PnL/fee unit tests change params mid-test with LPs in).
    function paramsUnchecked(Params memory p) external {
        _checkParams(p);
        _applyParams(p);
    }

    function setGuardsUnchecked(uint256 openSpreadBps_, uint256 minHoldSeconds_, uint256 minCollateral_) external {
        (openSpreadBps, minHoldSeconds, minCollateral) = (openSpreadBps_, minHoldSeconds_, minCollateral_);
    }
}
