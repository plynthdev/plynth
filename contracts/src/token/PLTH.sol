// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// PLTH: fixed supply, minted once in the constructor and never again (there is no mint function and no
/// owner). The supply is split between four allocations given to the deploy script:
///   80% worker, 10% treasury, 5% stakers' reward reserve, 5% burned in the constructor.
/// The burn is a real mint-then-burn so it is visible on-chain as two Transfer events (to this contract,
/// then to address(0)) and `totalSupply()` ends at 95% of `INITIAL_SUPPLY`.
/// ERC20Permit for gasless approvals; ERC20Votes (block-number clock) so a board can later vote with it.
contract PLTH is ERC20, ERC20Permit, ERC20Votes {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant WORKER_BPS = 8000;
    uint256 public constant TREASURY_BPS = 1000;
    uint256 public constant STAKER_RESERVE_BPS = 500;
    uint256 public constant BURN_BPS = 500;
    uint256 private constant BPS = 10_000;

    address public immutable worker;
    address public immutable treasury;
    address public immutable stakerReserve;

    error ZeroAddress();

    constructor(address worker_, address treasury_, address stakerReserve_)
        ERC20("Plinth", "PLTH")
        ERC20Permit("Plinth")
    {
        if (worker_ == address(0) || treasury_ == address(0) || stakerReserve_ == address(0)) revert ZeroAddress();
        worker = worker_;
        treasury = treasury_;
        stakerReserve = stakerReserve_;
        _mint(worker_, INITIAL_SUPPLY * WORKER_BPS / BPS);
        _mint(treasury_, INITIAL_SUPPLY * TREASURY_BPS / BPS);
        _mint(stakerReserve_, INITIAL_SUPPLY * STAKER_RESERVE_BPS / BPS);
        uint256 burn = INITIAL_SUPPLY * BURN_BPS / BPS;
        _mint(address(this), burn);
        _burn(address(this), burn);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
