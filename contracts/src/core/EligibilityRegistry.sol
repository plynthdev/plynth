// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";

/// @title EligibilityRegistry
/// @notice On-chain record of the eligibility service's decisions. Stock Tokens are not offered to US, UK,
/// Canadian or Swiss persons; the off-chain service screens a wallet (signed self-attestation, IP country,
/// sanctions lists) and signs an `Attestation`. Anyone may submit that signature with `attest`, so the user
/// (or a relayer) pays the gas and the service needs no funded key.
///
/// Rules:
///   E1 An attestation is valid only if signed by the current attester (EOA or ERC-1271).
///   E2 issuedAt <= now < expiry, and expiry - issuedAt <= MAX_TTL. Expired => not eligible.
///   E3 Replay guard: issuedAt must be strictly newer than the user's last attestation and last revocation,
///      so an old signature cannot undo a revoke or shorten a newer record.
///   E4 The attester can revoke a user at any time; the owner can rotate the attester. Rotation invalidates
///      unsubmitted signatures from the old attester, not records already on chain (revoke those explicitly).
///   E5 This registry only gates buying. It holds no funds and nothing here can block an exit.
contract EligibilityRegistry is IEligibility, Ownable2Step, EIP712 {
    struct Record {
        uint64 issuedAt;
        uint64 expiry;
        uint32 flags; // which checks passed (bitmask, see FLAG_*); informational on chain
    }

    uint32 public constant FLAG_SELF_ATTESTED = 1;
    uint32 public constant FLAG_IP_COUNTRY = 2;
    uint32 public constant FLAG_SANCTIONS = 4;
    uint64 public constant MAX_TTL = 31 days;

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address user,uint64 issuedAt,uint64 expiry,uint32 flags)");

    address public attester;
    mapping(address user => Record) private _records;
    mapping(address user => uint64) public revokedAt;

    event AttesterSet(address indexed attester);
    event Attested(address indexed user, uint64 issuedAt, uint64 expiry, uint32 flags);
    event Revoked(address indexed user, uint64 at);

    error ZeroAddress();
    error NotAttester();
    error BadSignature();
    error BadWindow();
    error Stale();

    constructor(address owner_, address attester_) Ownable(owner_) EIP712("Plynth EligibilityRegistry", "1") {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }

    function setAttester(address attester_) external onlyOwner {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }

    /// Anyone may submit a signed attestation for any user.
    function attest(address user, uint64 issuedAt, uint64 expiry, uint32 flags, bytes calldata sig) external {
        if (user == address(0)) revert ZeroAddress();
        if (issuedAt > block.timestamp || expiry <= block.timestamp || expiry <= issuedAt || expiry - issuedAt > MAX_TTL)
        {
            revert BadWindow();
        }
        if (issuedAt <= _records[user].issuedAt || issuedAt <= revokedAt[user]) revert Stale();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, user, issuedAt, expiry, flags)));
        if (!SignatureChecker.isValidSignatureNow(attester, digest, sig)) revert BadSignature();
        _records[user] = Record(issuedAt, expiry, flags);
        emit Attested(user, issuedAt, expiry, flags);
    }

    function revoke(address user) external {
        if (msg.sender != attester) revert NotAttester();
        uint64 t = uint64(block.timestamp);
        revokedAt[user] = t;
        delete _records[user].expiry;
        emit Revoked(user, t);
    }

    function isEligible(address user) external view returns (bool) {
        Record memory r = _records[user];
        return r.expiry > block.timestamp && r.issuedAt > revokedAt[user];
    }

    function recordOf(address user) external view returns (Record memory) {
        return _records[user];
    }

    function attestationDigest(address user, uint64 issuedAt, uint64 expiry, uint32 flags)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, user, issuedAt, expiry, flags)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
