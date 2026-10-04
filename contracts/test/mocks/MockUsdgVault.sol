// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// OpenZeppelin ERC-4626 over USDG (tests and local anvil only). Gains are simulated by sending USDG to it.
contract MockUsdgVault is ERC4626 {
    constructor(IERC20 usdg) ERC20("Mock USDG vault", "mvUSDG") ERC4626(usdg) {}

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
