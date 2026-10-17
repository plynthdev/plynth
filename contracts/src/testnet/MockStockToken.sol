// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET ONLY. Stand-in for an ERC-8056 Stock Token (none exist on testnet).
/// 18 decimals; `uiMultiplier()` is 1e18-scaled (shares per token) and set by the owner, which emits
/// `UIMultiplierUpdated` like a dividend or split adjustment would. The owner mints freely.
contract MockStockToken is ERC20, Ownable {
    uint256 public uiMultiplier = 1e18;

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    error ZeroMultiplier();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setUiMultiplier(uint256 newMultiplier) external onlyOwner {
        if (newMultiplier == 0) revert ZeroMultiplier();
        emit UIMultiplierUpdated(uiMultiplier, newMultiplier);
        uiMultiplier = newMultiplier;
    }
}
