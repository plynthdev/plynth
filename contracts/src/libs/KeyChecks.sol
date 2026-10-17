// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// On-chain sanity checks for the privacy keys savers register (audit M-6): a malformed key used to stop Quiet and
/// Hidden delivery for everyone, because the keeper threw on it mid-pass.
library KeyChecks {
    /// secp256k1 field prime.
    uint256 internal constant SECP_P = type(uint256).max - 2 ** 32 - 976; // 2^256 - 2^32 - 977

    /// True if `pub` (an x25519 public key as its 32-byte little-endian encoding, the way the SDK stores it) is a
    /// low-order point: every shared secret with it is all zeros, so a note "encrypted" to it is readable by anyone
    /// and x25519 libraries refuse it. The high bit is masked first (RFC 7748 ignores it), which leaves the 7
    /// encodings libsodium rejects: 0, 1, the two order-8 points, p - 1, p and p + 1.
    function isLowOrderX25519(bytes32 pub) internal pure returns (bool) {
        bytes32 u = pub & ~bytes32(uint256(0x80)); // byte 31 is the most significant byte of the little-endian u
        return u == bytes32(0)
            || u == 0x0100000000000000000000000000000000000000000000000000000000000000 // not-a-key: x25519 u = 1
            || u == 0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800 // not-a-key: x25519 order-8 point
            || u == 0x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157 // not-a-key: x25519 order-8 point
            || u == 0xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f // not-a-key: x25519 u = p - 1
            || u == 0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f // not-a-key: x25519 u = p
            || u == 0xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f; // not-a-key: x25519 u = p + 1
    }

    /// True if `meta` is an ERC-5564 scheme-1 meta-address: 66 bytes, two compressed secp256k1 points
    /// (spending || viewing), each with prefix 0x02/0x03, x below the field prime and x^3 + 7 a square (on the curve).
    function isValidMetaAddress(bytes memory meta) internal view returns (bool) {
        if (meta.length != 66) return false;
        return _onCurve(meta, 0) && _onCurve(meta, 33);
    }

    function _onCurve(bytes memory b, uint256 off) private view returns (bool) {
        bytes1 prefix = b[off];
        if (prefix != 0x02 && prefix != 0x03) return false;
        uint256 x;
        assembly ("memory-safe") {
            x := mload(add(add(b, 0x21), off))
        }
        if (x >= SECP_P) return false;
        uint256 rhs = addmod(mulmod(mulmod(x, x, SECP_P), x, SECP_P), 7, SECP_P);
        // Euler's criterion: rhs is a non-zero square iff rhs^((p-1)/2) == 1 (rhs is never 0: -7 is not a cube mod p).
        return _modexp(rhs, (SECP_P - 1) / 2, SECP_P) == 1;
    }

    function _modexp(uint256 base, uint256 e, uint256 m) private view returns (uint256 r) {
        (bool ok, bytes memory out) = address(0x05).staticcall(abi.encode(uint256(32), uint256(32), uint256(32), base, e, m));
        if (!ok || out.length != 32) return 0;
        r = abi.decode(out, (uint256));
    }
}
