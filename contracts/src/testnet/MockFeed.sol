// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET ONLY. Chainlink AggregatorV3-shaped price feed whose answer the owner sets.
/// Every `set` starts a new round (round ids from 1); `setUpdatedAt` back- or forward-dates the latest
/// round to simulate a stale or off-hours feed. `getRoundData` returns any past round and reverts on
/// an unknown one, like Chainlink.
contract MockFeed is Ownable {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint80 public latestRound;
    mapping(uint80 roundId => Round) private _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error NoRound(uint80 roundId);

    constructor(uint8 decimals_, int256 answer_, string memory description_) Ownable(msg.sender) {
        decimals = decimals_;
        description = description_;
        _newRound(answer_);
    }

    function set(int256 answer_) external onlyOwner {
        _newRound(answer_);
    }

    function setUpdatedAt(uint256 t) external onlyOwner {
        _rounds[latestRound].updatedAt = t;
    }

    function latestAnswer() external view returns (int256) {
        return _rounds[latestRound].answer;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return _round(latestRound);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        if (roundId == 0 || roundId > latestRound) revert NoRound(roundId);
        return _round(roundId);
    }

    function _round(uint80 id) private view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[id];
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function _newRound(int256 answer_) private {
        uint80 id = ++latestRound;
        _rounds[id] = Round(answer_, block.timestamp);
        emit AnswerUpdated(answer_, id, block.timestamp);
    }
}
