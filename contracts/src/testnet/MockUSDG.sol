// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET ONLY. Stand-in for USDG on Robinhood Chain testnet demos and local tests.
/// 6 decimals like real USDG (verified on 4663 and 46630). The owner mints freely and can freeze an
/// address, which blocks every transfer from or to it (including mint and burn), to simulate an
/// issuer freeze so exits can be tested against a frozen holder.
contract MockUSDG is ERC20, Ownable {
    mapping(address account => bool) public frozen;

    event Frozen(address indexed account);
    event Unfrozen(address indexed account);

    error AccountFrozen(address account);

    constructor() ERC20("Mock USDG", "mUSDG") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function freeze(address account) external onlyOwner {
        frozen[account] = true;
        emit Frozen(account);
    }

    function unfreeze(address account) external onlyOwner {
        frozen[account] = false;
        emit Unfrozen(account);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (frozen[from]) revert AccountFrozen(from);
        if (frozen[to]) revert AccountFrozen(to);
        super._update(from, to, value);
    }
}
