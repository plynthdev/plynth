// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {StealthClaims} from "../../src/consumer/StealthClaims.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {PLTH} from "../../src/token/PLTH.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {IERC5564Announcer} from "../../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../../src/interfaces/IERC6538Registry.sol";
import {Permit2Code} from "../consumer/Permit2Code.sol";
import {StealthCode} from "../consumer/StealthCode.sol";

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The local mainnet fork runs under chain id 31337 so that nothing signed on it can be replayed on Robinhood
/// Chain (4663). That only holds if every EIP-712 domain the stack uses follows block.chainid instead of a value
/// cached at deploy time. These tests deploy on 4663, switch the chain id to 31337, and check that each domain
/// separator is recomputed for 31337 (and that a 4663 signature stops verifying), for Plynth's own contracts and
/// for the real Permit2 and ERC-6538 registry runtimes from 4663.
contract ForkChainIdTest is Test {
    uint256 constant MAINNET = 4663;
    uint256 constant FORK = 31337;
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _sep(string memory name, string memory version, uint256 chainId, address c) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, c));
    }

    function test_plynthDomainsFollowTheChainId() public {
        vm.chainId(MAINNET);
        MockUSDG usdg = new MockUSDG();
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        SavingsVault vault =
            new SavingsVault(IERC20(address(usdg)), Permit2Code.PERMIT2, ICanonicalRegistry(address(reg)), address(this), address(1));
        StealthClaims sc = new StealthClaims(
            address(this), IERC5564Announcer(StealthCode.ANNOUNCER), IERC6538Registry(StealthCode.REGISTRY)
        );
        EligibilityRegistry er = new EligibilityRegistry(address(this), address(2));
        PLTH plth = new PLTH(address(3), address(4), address(5));

        assertEq(vault.domainSeparator(), _sep("Plynth SavingsVault", "1", MAINNET, address(vault)));
        assertEq(sc.domainSeparator(), _sep("Plynth StealthClaims", "1", MAINNET, address(sc)));
        assertEq(er.domainSeparator(), _sep("Plynth EligibilityRegistry", "1", MAINNET, address(er)));
        assertEq(plth.DOMAIN_SEPARATOR(), _sep("Plinth", "1", MAINNET, address(plth)));

        vm.chainId(FORK);
        assertEq(vault.domainSeparator(), _sep("Plynth SavingsVault", "1", FORK, address(vault)));
        assertEq(sc.domainSeparator(), _sep("Plynth StealthClaims", "1", FORK, address(sc)));
        assertEq(er.domainSeparator(), _sep("Plynth EligibilityRegistry", "1", FORK, address(er)));
        assertEq(plth.DOMAIN_SEPARATOR(), _sep("Plinth", "1", FORK, address(plth)));
        assertTrue(vault.domainSeparator() != _sep("Plynth SavingsVault", "1", MAINNET, address(vault)));
    }

    /// An attestation signed for 4663 is refused on the 31337 fork, and the 31337 one is accepted.
    function test_signatureForMainnetDoesNotVerifyOnTheFork() public {
        (address attester, uint256 pk) = makeAddrAndKey("attester"); // test-key (generated in the test)
        vm.chainId(MAINNET);
        EligibilityRegistry er = new EligibilityRegistry(address(this), attester);
        address user = address(0xBEEF);
        uint64 issuedAt = uint64(block.timestamp);
        uint64 expiry = issuedAt + 1 days;
        bytes32 mainnetDigest = er.attestationDigest(user, issuedAt, expiry, 1);

        vm.chainId(FORK);
        bytes32 forkDigest = er.attestationDigest(user, issuedAt, expiry, 1);
        assertTrue(forkDigest != mainnetDigest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, mainnetDigest);
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        er.attest(user, issuedAt, expiry, 1, abi.encodePacked(r, s, v));

        (v, r, s) = vm.sign(pk, forkDigest);
        er.attest(user, issuedAt, expiry, 1, abi.encodePacked(r, s, v));
        assertTrue(er.isEligible(user));
    }

    /// The real Permit2 runtime from 4663 caches 4663 and recomputes for any other chain id.
    function test_realPermit2RecomputesItsDomainOnTheFork() public {
        vm.etch(Permit2Code.PERMIT2, Permit2Code.RUNTIME);
        bytes32 typehash = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
        vm.chainId(MAINNET);
        assertEq(
            IDomain(Permit2Code.PERMIT2).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typehash, keccak256("Permit2"), MAINNET, Permit2Code.PERMIT2))
        );
        vm.chainId(FORK);
        assertEq(
            IDomain(Permit2Code.PERMIT2).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typehash, keccak256("Permit2"), FORK, Permit2Code.PERMIT2))
        );
    }

    /// The real ERC-6538 registry runtime from 4663 does the same (its cached separator is for 4663).
    function test_realErc6538RegistryRecomputesItsDomainOnTheFork() public {
        vm.etch(StealthCode.REGISTRY, StealthCode.REGISTRY_RUNTIME);
        vm.chainId(MAINNET);
        bytes32 onMainnet = IDomain(StealthCode.REGISTRY).DOMAIN_SEPARATOR();
        assertEq(onMainnet, _sep("ERC6538Registry", "1.0", MAINNET, StealthCode.REGISTRY));
        vm.chainId(FORK);
        assertEq(IDomain(StealthCode.REGISTRY).DOMAIN_SEPARATOR(), _sep("ERC6538Registry", "1.0", FORK, StealthCode.REGISTRY));
    }
}
