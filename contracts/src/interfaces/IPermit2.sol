// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Subset of Uniswap Permit2 (canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3, deployed on
/// Robinhood Chain mainnet and testnet). Struct layouts match Permit2 exactly; tests run against the
/// real Permit2 runtime bytecode.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function transferFrom(address from, address to, uint160 amount, address token) external;

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
