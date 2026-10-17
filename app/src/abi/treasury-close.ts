// Hand-written ABI subsets for the close service and the CFO pack. test/abi.test.ts checks every selector
// against contracts/out.
import { parseAbi } from "viem";

const CLOSE_STRUCT =
  "struct Close { uint64 periodEnd; uint256 navUsd; uint16 cashBps; uint16 equityBps; bytes32 positionsHash; bytes32 bundleHash; bytes32 policyHash; uint32 policyVersion; }";
const POSITION_STRUCT = "struct Position { address asset; uint256 raw; uint256 price; uint256 multiplier; uint80 roundId; }";

export const periodCloseErrorsAbi = parseAbi([
  "error PeriodInFuture(uint64 periodEnd, uint256 nowTs)",
  "error PeriodTooEarly(uint64 periodEnd, uint64 earliest)",
  "error NoPolicyAt(uint64 periodEnd)",
  "error PolicyMismatch(bytes32 hash, uint32 version)",
  "error HoldAtClose(address token)",
  "error NavMismatch(uint256 expected, uint256 claimed)",
  "error WeightsMismatch(uint16 cashBps, uint16 equityBps)",
  "error PositionsMismatch(bytes32 expected)",
  "error BadSignature()",
  "error NotController()",
  "error NoSnapshot()",
  "error SnapshotBeforePeriodEnd(uint64 takenAt, uint64 periodEnd)",
  "error SnapshotExpired(uint64 takenAt)",
]);

export const periodCloseAbi = [
  ...parseAbi([
    CLOSE_STRUCT,
    POSITION_STRUCT,
    "struct BookSnapshot { uint64 takenAt; uint256 navUsd; uint16 cashBps; uint16 equityBps; bytes32 positionsHash; uint256[3] bandUsd; }",
    "function commit(Close c, bytes controllerSig)",
    "function snapshot() returns (bytes32 positionsHash, uint256 navUsd, uint16 cashBps, uint16 equityBps)",
    "function commitSnapshot(Close c, bytes controllerSig)",
    "function bookSnapshot() view returns (BookSnapshot)",
    "function SNAPSHOT_MAX_AGE() view returns (uint64)",
    "function latest() view returns (Close)",
    "function closeAt(uint256 index) view returns (Close)",
    "function closeCount() view returns (uint256)",
    "function nextPeriodEnd() view returns (uint64)",
    "function startTime() view returns (uint64)",
    "function periodStartNav() view returns (uint256)",
    "function feeOwed() view returns (uint256)",
    "function feeRecipient() view returns (address)",
    "function account() view returns (address)",
    "function policy() view returns (address)",
    "function digest(Close c) view returns (bytes32)",
    "function feeFor(uint256 navUsd, uint256 elapsed) view returns (uint256)",
    "function preview() view returns (Position[] positions, bytes32 positionsHash, uint256 navUsd, uint16 cashBps, uint16 equityBps, address holdToken)",
    "event BookSnapshotted(uint64 takenAt, bytes32 positionsHash, uint256 navUsd, uint16 cashBps, uint16 equityBps)",
    "event PeriodClosed(uint256 indexed index, uint64 indexed periodEnd, Close close, uint256 feeRaw, uint256 feePaid, uint256 feeOwed)",
  ]),
  ...periodCloseErrorsAbi,
] as const;

export const closePolicyAbi = parseAbi([
  "struct Band { uint16 minBps; uint16 maxBps; }",
  "struct Policy { Band cash; Band equity; Band basis; int16 netDeltaMinBps; int16 netDeltaMaxBps; uint16 maxLeverageX10; uint64 perOrderCapUsd; uint64 perDayCapUsd; uint16 perNameFloatCapBps; uint16 perVenueCapBps; bool noNewRiskOffHours; int16 pauseNewRiskAtDrawdownBps; int16 deriskAtDrawdownBps; uint64 approvalAboveUsd; uint32 periodSeconds; bytes32 instrumentAllowRoot; bytes32 venueAllowRoot; address controller; }",
  "function versionAt(uint64 timestamp) view returns (uint32)",
  "function policyAt(uint32 version) view returns (Policy, bytes32 hash, uint64 activatedAt)",
]);

/** EIP-712 types the controller signs; must match PeriodClose.CLOSE_TYPEHASH. */
export const CLOSE_TYPES = {
  Close: [
    { name: "periodEnd", type: "uint64" },
    { name: "navUsd", type: "uint256" },
    { name: "cashBps", type: "uint16" },
    { name: "equityBps", type: "uint16" },
    { name: "positionsHash", type: "bytes32" },
    { name: "bundleHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
  ],
} as const;

export const closeDomain = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Plynth PeriodClose", version: "1", chainId, verifyingContract }) as const;
