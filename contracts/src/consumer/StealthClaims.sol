// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC5564Announcer} from "../interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../interfaces/IERC6538Registry.sol";

/// Holds Quiet-delivered Stock Tokens for ERC-5564 stealth addresses until they are claimed, so a stealth
/// address never needs gas: its owner signs an EIP-712 `Claim` and anyone (normally the relayer) submits it.
///
/// Two buckets per token:
/// - `pooled[token]`: tokens CrowdBuy has moved here for Quiet users but not yet assigned to a stealth address.
///   CrowdBuy fills it in `deliver` (which names the user) and drains it in `deliverStealth` (which names only
///   the stealth address), in separate transactions, so the user and the stealth address never share one.
/// - `balanceOf(token, stealth)`: assigned, claimable by the stealth key.
/// Invariant: token.balanceOf(this) >= pooled[token] + sum of balanceOf(token, *) (checked on every inflow).
///
/// Trust: only CrowdBuy can pool or credit. A claim needs the stealth key's signature; nobody else, including
/// the owner of CrowdBuy or the relayer, can move a credited balance. There is no admin here at all.
contract StealthClaims is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// ERC-5564 scheme 1: secp256k1 with view tags.
    uint256 public constant SCHEME_ID = 1;

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address token,address stealth,address to,uint256 raw,uint256 nonce,uint256 deadline)"
    );

    address public immutable crowd;
    IERC5564Announcer public immutable announcer;
    IERC6538Registry public immutable registry;

    mapping(address token => uint256) public pooled;
    mapping(address token => uint256) public totalCredited;
    mapping(address token => mapping(address stealth => uint256)) private _balances;
    mapping(address stealth => uint256) public nonces;

    event Pooled(address indexed token, uint256 raw);
    event Credited(address indexed token, address indexed stealth, uint256 raw);
    event Claimed(address indexed token, address indexed stealth, address indexed to, uint256 raw, uint256 nonce);

    error ZeroAddress();
    error NotCrowd();
    error ZeroAmount();
    error Underfunded(uint256 have, uint256 need);
    error PoolTooSmall(uint256 pooled, uint256 raw);
    error Expired(uint256 deadline);
    error BadSignature();
    error BadDestination();
    error InsufficientBalance(uint256 balance, uint256 raw);

    modifier onlyCrowd() {
        if (msg.sender != crowd) revert NotCrowd();
        _;
    }

    constructor(address crowd_, IERC5564Announcer announcer_, IERC6538Registry registry_)
        EIP712("Plynth StealthClaims", "1")
    {
        if (crowd_ == address(0) || address(announcer_) == address(0) || address(registry_) == address(0)) {
            revert ZeroAddress();
        }
        crowd = crowd_;
        announcer = announcer_;
        registry = registry_;
    }

    // ---------------------------------------------------------------- crowd

    /// CrowdBuy has already transferred `raw` here; record it as unassigned.
    function pool(address token, uint256 raw) external onlyCrowd {
        if (raw == 0) revert ZeroAmount();
        pooled[token] += raw;
        _checkFunded(token);
        emit Pooled(token, raw);
    }

    /// Moves `raw` from the unassigned pool to `stealth`'s claimable balance.
    function credit(address token, address stealth, uint256 raw) external onlyCrowd {
        if (stealth == address(0)) revert ZeroAddress();
        if (raw == 0) revert ZeroAmount();
        uint256 p = pooled[token];
        if (p < raw) revert PoolTooSmall(p, raw);
        pooled[token] = p - raw;
        _balances[token][stealth] += raw;
        totalCredited[token] += raw;
        emit Credited(token, stealth, raw);
    }

    // ---------------------------------------------------------------- claims

    /// Relayed claim: `sig` is the stealth key's EIP-712 signature over
    /// Claim(token, stealth, to, raw, nonces[stealth], deadline). Partial claims are fine; each claim uses
    /// the next nonce, so a signature works once. `to` can be any address except zero and this contract.
    function claim(address token, address stealth, address to, uint256 raw, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        uint256 nonce = nonces[stealth];
        bytes32 digest = claimDigest(token, stealth, to, raw, nonce, deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || signer != stealth || stealth == address(0)) revert BadSignature();
        nonces[stealth] = nonce + 1;
        _pay(token, stealth, to, raw, nonce);
    }

    /// Unrelayed exit: the stealth address itself (if it ever has gas) can always pull its own balance.
    function claimDirect(address token, address to, uint256 raw) external nonReentrant {
        uint256 nonce = nonces[msg.sender];
        nonces[msg.sender] = nonce + 1;
        _pay(token, msg.sender, to, raw, nonce);
    }

    // ---------------------------------------------------------------- views

    function balanceOf(address token, address stealth) external view returns (uint256) {
        return _balances[token][stealth];
    }

    function claimDigest(address token, address stealth, address to, uint256 raw, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, token, stealth, to, raw, nonce, deadline)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- internal

    function _pay(address token, address stealth, address to, uint256 raw, uint256 nonce) private {
        if (to == address(0) || to == address(this)) revert BadDestination();
        if (raw == 0) revert ZeroAmount();
        uint256 bal = _balances[token][stealth];
        if (bal < raw) revert InsufficientBalance(bal, raw);
        _balances[token][stealth] = bal - raw;
        totalCredited[token] -= raw;
        IERC20(token).safeTransfer(to, raw);
        emit Claimed(token, stealth, to, raw, nonce);
    }

    function _checkFunded(address token) private view {
        uint256 need = pooled[token] + totalCredited[token];
        uint256 have = IERC20(token).balanceOf(address(this));
        if (have < need) revert Underfunded(have, need);
    }
}
