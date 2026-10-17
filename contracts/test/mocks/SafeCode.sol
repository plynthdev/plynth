// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The official SafeProxy runtime (v1.3.0 SafeProxyFactory.proxyRuntimeCode() on Robinhood Chain 4663, read
/// 2026-10-17) and a Safe-storage-layout stand-in for the singleton, so tests can build an OWNER that the MainnetBeta
/// pin accepts the way it would accept a real Safe: the proxy code hash and the singleton address are the real ones.
library SafeCode {
    address internal constant SINGLETON_130 = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
    bytes internal constant PROXY_130_RUNTIME = hex"608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033";
}

/// Safe's storage layout (slot 0 singleton, 1 modules, 2 owners, 3 ownerCount, 4 threshold) and the three views the pin
/// reads. Deployed at the official singleton address in tests; the proxy delegatecalls into it.
contract MockSafeSingleton {
    address internal constant SENTINEL = address(0x1);
    address internal singleton;
    mapping(address => address) internal modules;
    mapping(address => address) internal owners;
    uint256 internal ownerCount;
    uint256 internal threshold;

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory out) {
        out = new address[](ownerCount);
        address cur = owners[SENTINEL];
        for (uint256 i; cur != SENTINEL && cur != address(0); i++) {
            out[i] = cur;
            cur = owners[cur];
        }
    }

    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory page, address next) {
        page = new address[](pageSize);
        uint256 n;
        address cur = modules[start];
        while (cur != address(0) && cur != SENTINEL && n < pageSize) {
            page[n++] = cur;
            cur = modules[cur];
        }
        next = cur;
        assembly {
            mstore(page, n)
        }
    }
}
