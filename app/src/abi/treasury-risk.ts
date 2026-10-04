// Hand-written ABI subsets the risk service needs. test/risk.test.ts checks every selector against contracts/out.
import { parseAbi } from "viem";

export const positionMirrorAbi = parseAbi([
  "struct Position { address underlying; int256 tokens; }",
  "function post(address venue, Position[] positions, uint256 equityUsd, uint256 flowInSeen, uint64 ts, bytes signature)",
  "function latest(address venue) view returns (Position[] positions, uint256 equityUsd, uint256 flowInSeen, uint64 ts)",
  "function isStale(address venue) view returns (bool)",
  "function digestOf(address venue, Position[] positions, uint256 equityUsd, uint256 flowInSeen, uint64 ts) view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function STALE_AFTER() view returns (uint256)",
  "event MirrorPosted(address indexed venue, uint64 ts, uint256 equityUsd, uint256 flowInSeen, bytes32 positionsHash)",
  "error BadTimestamp(uint64 ts)",
  "error TooManyPositions()",
  "error BadSignature()",
]);

export const perpSleeveAbi = parseAbi([
  "function venues() view returns (address[])",
  "function band() view returns (uint8)",
  "function account() view returns (address)",
]);

export const perpVenueAbi = parseAbi([
  "struct Position { address underlying; int256 tokens; }",
  "function positionOf() view returns (Position[])",
  "function equityOf() view returns (uint256 usd, bool stale)",
  "function flowIn() view returns (uint256)",
  "function markets() view returns (address[])",
]);

export const perpMarketAbi = parseAbi([
  "function underlying() view returns (address)",
  "function fundingRate() view returns (uint256 ratePerSecond, bool longsPay)",
]);

export const riskAccountAbi = parseAbi([
  "function policy() view returns (address)",
  "function guard() view returns (address)",
  "function periodClose() view returns (address)",
  "function positionSleeves() view returns (address[])",
  "function trackedAssets() view returns (address[] assets, uint8[] kinds, uint8[] bands)",
]);

export const riskPolicyAbi = parseAbi([
  "struct Band { uint16 minBps; uint16 maxBps; }",
  "struct Policy { Band cash; Band equity; Band basis; int16 netDeltaMinBps; int16 netDeltaMaxBps; uint16 maxLeverageX10; uint64 perOrderCapUsd; uint64 perDayCapUsd; uint16 perNameFloatCapBps; uint16 perVenueCapBps; bool noNewRiskOffHours; int16 pauseNewRiskAtDrawdownBps; int16 deriskAtDrawdownBps; uint64 approvalAboveUsd; uint32 periodSeconds; bytes32 instrumentAllowRoot; bytes32 venueAllowRoot; address controller; }",
  "function current() view returns (Policy, bytes32 hash, uint32 version)",
]);

export const periodStartAbi = parseAbi(["function periodStartNav() view returns (uint256)"]);

export const valuerQuoteAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote)",
  "function value(address token, uint256 rawUnits) view returns (uint256 usd, bool hold)",
]);

export const riskGuardAbi = parseAbi(["function valuer() view returns (address)"]);
