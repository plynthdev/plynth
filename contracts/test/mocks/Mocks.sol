// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(uint8 d, int256 a) {
        decimals = d;
        set(a, block.timestamp);
    }

    function set(int256 a, uint256 t) public {
        answer = a;
        updatedAt = t;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract MockStockToken {
    uint8 public decimals = 18;
    uint256 public uiMultiplier = 1e18;
    string public symbol = "MOCK";

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}
