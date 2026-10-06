// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {AssetValuation} from "../../src/libs/AssetValuation.sol";
import {ISleeve} from "../../src/interfaces/ISleeve.sol";

contract MockCashVault is ERC4626 {
    constructor(IERC20 usdg) ERC20("Mock steakUSDG", "msUSDG") ERC4626(usdg) {}
}

contract MockPeriodClose {
    uint256 public periodStartNav;

    function set(uint256 v) external {
        periodStartNav = v;
    }
}

contract ForceEth {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// Base: values its declared assets with the same AssetValuation the guard uses.
abstract contract MockSleeveBase is ISleeve {
    Valuer public immutable valuer;
    address[] internal _assets;
    uint8[] internal _kinds;

    constructor(Valuer valuer_) {
        valuer = valuer_;
    }

    function assets() external view returns (address[] memory, uint8[] memory) {
        return (_assets, _kinds);
    }

    function valueOf(address account) external view returns (uint256 usd, bool hold) {
        for (uint256 i; i < _assets.length; ++i) {
            (uint256 v, bool h) =
                AssetValuation.value(valuer, _assets[i], _kinds[i], IERC20(_assets[i]).balanceOf(account));
            usd += v;
            hold = hold || h;
        }
    }
}

/// Test equity sleeve: a market maker that fills at the oracle price minus `feeBps`, from its own inventory.
/// Extra ops simulate a malicious or broken adapter.
contract MockEquitySleeve is MockSleeveBase {
    uint8 public constant OP_BUY = 0; // a = token, b = USDG in
    uint8 public constant OP_SELL = 1; // a = token, b = token raw in
    uint8 public constant OP_LEAK = 2; // pull b USDG and keep it
    uint8 public constant OP_ETH = 3; // force b wei of ETH into the caller
    uint8 public constant OP_ADD_ASSET = 4; // add asset a to the declared list mid-operation
    uint8 public constant OP_NOOP = 5;
    uint8 public constant OP_GIFT = 6; // pull b USDG, send b * 1e12 raw of token a (no price needed)

    IERC20 public immutable usdg;
    uint16 public feeBps = 30;

    constructor(Valuer valuer_, IERC20 usdg_, address[] memory tokens) MockSleeveBase(valuer_) {
        usdg = usdg_;
        for (uint256 i; i < tokens.length; ++i) {
            _assets.push(tokens[i]);
            _kinds.push(AssetValuation.KIND_STOCK_TOKEN);
        }
    }

    receive() external payable {}

    function setFee(uint16 f) external {
        feeBps = f;
    }

    function band() external pure returns (uint8) {
        return 1;
    }

    function run(bytes calldata data) external returns (bytes memory) {
        (uint8 op, address a, uint256 b) = abi.decode(data, (uint8, address, uint256));
        if (op == OP_BUY) {
            usdg.transferFrom(msg.sender, address(this), b);
            uint256 price = valuer.quote(a).priceUsdPerToken;
            uint256 out = b * 1e12 * (10_000 - feeBps) / 10_000 * 1e18 / price;
            IERC20(a).transfer(msg.sender, out);
            return abi.encode(out);
        } else if (op == OP_SELL) {
            IERC20(a).transferFrom(msg.sender, address(this), b);
            uint256 price = valuer.quote(a).priceUsdPerToken;
            uint256 out = b * price / 1e18 * (10_000 - feeBps) / 10_000 / 1e12;
            usdg.transfer(msg.sender, out);
            return abi.encode(out);
        } else if (op == OP_LEAK) {
            usdg.transferFrom(msg.sender, address(this), b);
        } else if (op == OP_ETH) {
            new ForceEth{value: b}(payable(msg.sender));
        } else if (op == OP_ADD_ASSET) {
            _assets.push(a);
            _kinds.push(AssetValuation.KIND_STOCK_TOKEN);
        } else if (op == OP_GIFT) {
            usdg.transferFrom(msg.sender, address(this), b);
            IERC20(a).transfer(msg.sender, b * 1e12);
        }
        return "";
    }
}

contract MockCashSleeve is MockSleeveBase {
    uint8 public constant OP_DEPOSIT = 0; // b = USDG in
    uint8 public constant OP_REDEEM = 1; // b = shares in
    uint8 public constant OP_LOSSY_DEPOSIT = 2; // b = USDG in, uint160(a) = USDG kept back (a vault paying less)

    IERC20 public immutable usdg;
    MockCashVault public immutable vault;

    constructor(Valuer valuer_, IERC20 usdg_, MockCashVault vault_) MockSleeveBase(valuer_) {
        usdg = usdg_;
        vault = vault_;
        _assets.push(address(usdg_));
        _kinds.push(AssetValuation.KIND_CASH);
        _assets.push(address(vault_));
        _kinds.push(AssetValuation.KIND_CASH_VAULT);
    }

    function band() external pure returns (uint8) {
        return 0;
    }

    function run(bytes calldata data) external returns (bytes memory) {
        (uint8 op, address a, uint256 b) = abi.decode(data, (uint8, address, uint256));
        if (op == OP_DEPOSIT) {
            usdg.transferFrom(msg.sender, address(this), b);
            usdg.approve(address(vault), b);
            return abi.encode(vault.deposit(b, msg.sender));
        } else if (op == OP_LOSSY_DEPOSIT) {
            uint256 loss = uint160(a);
            usdg.transferFrom(msg.sender, address(this), b);
            usdg.approve(address(vault), b - loss);
            return abi.encode(vault.deposit(b - loss, msg.sender));
        } else {
            vault.transferFrom(msg.sender, address(this), b);
            return abi.encode(vault.redeem(b, msg.sender, address(this)));
        }
    }
}
