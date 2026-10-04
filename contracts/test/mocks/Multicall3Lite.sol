// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Local-only stand-in for Multicall3 (0xcA11…CA11 on 4663 and 46630): the `aggregate3` entry point the
/// keeper uses, with the same ABI. A plain anvil chain has no Multicall3, so the local consumer script
/// deploys this one and records its address.
contract Multicall3Lite {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        uint256 n = calls.length;
        returnData = new Result[](n);
        for (uint256 i; i < n; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (!ok && !calls[i].allowFailure) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            returnData[i] = Result(ok, ret);
        }
    }

    function getCurrentBlockTimestamp() external view returns (uint256) {
        return block.timestamp;
    }
}
