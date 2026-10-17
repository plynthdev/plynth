// The slice of each contract the keeper calls. Signatures mirror contracts/src (checked in abi.test.ts).
import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct Account { uint256 available; uint256 pending; uint64 week; uint64 accruedThisWeek; uint64 lastTopUpAt; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function accrue(address user, bytes32 sourceTx, uint32 logIndex, uint256 spendAmount) returns (uint256 added)",
  "function accrueBatch(address user, bytes32[] sourceTxs, uint32[] logIndexes, uint256[] spends) returns (uint256 added)",
  "function MAX_ACCRUE_BATCH() view returns (uint256)",
  "function pullFixedTopUp(address user)",
  "function settingsOf(address user) view returns (Settings)",
  "struct HiddenKeys { bytes32 ownerPk; bytes32 viewingPub; }",
  "function hiddenKeysOf(address user) view returns (HiddenKeys)",
  "function accountOf(address user) view returns (Account)",
  "function balancesOf(address user) view returns (uint256 available, uint256 pending)",
  "function mixOf(address user) view returns (MixEntry[])",
  "function linkedUser(address wallet) view returns (address)",
  "function sourceUsed(bytes32 key) view returns (bool)",
  "function roundUp(uint256 spend, uint8 roundTo, uint8 multiplier) view returns (uint256)",
  "function unit() view returns (uint256)",
  "function keeper() view returns (address)",
  "function TOP_UP_SPACING() view returns (uint64)",
  "event Accrued(address indexed user, bytes32 indexed sourceTx, uint32 logIndex, uint256 spend, uint256 added, uint64 week)",
  "event TopUpPulled(address indexed user, uint256 amount)",
  "error NotKeeper()",
  "error AlreadyAccrued(bytes32 sourceTx, uint32 logIndex)",
  "error InvalidBatch()",
  "error NoFixedTopUp()",
  "error TopUpTooSoon(uint256 nextAt)",
  "error InsufficientBalance(uint256 requested, uint256 balance)",
  "error NoMix()",
]);

export const crowdAbi = parseAbi([
  "struct Book { uint256 usdgTotal; uint32 accounts; uint64 openedAt; uint256 rawOut; bool executed; uint64 crowdSince; }",
  "function join(address user)",
  "function joinBatch(address[] users) returns (uint256 joined)",
  "function execute(address asset)",
  "function openBook(address asset) view returns (uint256 bookId, Book b)",
  "function book(address asset, uint256 bookId) view returns (Book)",
  "function beaconKey(address asset, uint64 windowStart) pure returns (bytes32)",
  "function windowOf(uint256 t) view returns (uint64 start, uint64 end)",
  "function lastExecutedWindow(address asset) view returns (uint64)",
  "function allocationOf(address asset, uint256 bookId, address user) view returns (uint256)",
  "function claimOpen(address asset, uint256 bookId)",
  "function deliver(address asset, uint256 bookId, address user, bytes route)",
  "function deliverStealth(address asset, address stealth, uint256 raw, bytes ephemeralPubKey, bytes1 viewTag)",
  "function settled(address asset, uint256 bookId, address user) view returns (bool)",
  "function orderOf(address asset, uint256 bookId, address user) view returns (uint256)",
  "function metaAddressValid(address user) view returns (bool)",
  "function stealthClaims() view returns (address)",
  "function shieldedPool() view returns (address)",
  "function MIN_CROWD() view returns (uint32)",
  "function GENESIS() view returns (uint64)",
  "function WINDOW() view returns (uint64)",
  "function valuer() view returns (address)",
  "function beacon() view returns (address)",
  "event Executed(address indexed asset, uint256 indexed bookId, uint256 usdgTotal, uint256 rawOut, uint32 accounts, uint80 roundId)",
  "event Joined(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg)",
  "error NothingPending()",
  "error CrowdTooSmall(uint32 accounts, uint32 minCrowd)",
  "error TooEarly(uint64 executeAfter)",
  "error AlreadyExecutedThisWindow(uint64 windowStart)",
  "error MarketOnHold(address asset)",
  "error BeforeGenesis()",
  "error AlreadyExecuted()",
  "error NotExecuted()",
  "error NoOrder()",
  "error AlreadySettled()",
  "error QuietNotConfigured()",
  "error UnknownRoute(bytes route)",
  "error NotQuiet(address user)",
  "error NoMetaAddress(address user)",
  "error BadMetaAddress(address user)",
  "error BadEphemeralKey()",
  "error HiddenNotConfigured()",
  "error NotHidden(address user)",
  "error NoHiddenKeys(address user)",
  "error NoMix()",
]);

export const stealthClaimsAbi = parseAbi([
  "function pooled(address token) view returns (uint256)",
  "function balanceOf(address token, address stealth) view returns (uint256)",
  "function registry() view returns (address)",
  "function announcer() view returns (address)",
  "error PoolTooSmall(uint256 pooled, uint256 raw)",
  "error NotCrowd()",
  "error ZeroAmount()",
]);

export const beaconAbi = parseAbi([
  "struct Beacon { uint64 windowStart; uint64 windowEnd; uint64 executeAt; bytes32 commitment; }",
  "function commit(bytes32 key, uint64 windowStart, uint64 windowEnd, bytes32 commitment)",
  "function reveal(bytes32 key, bytes32 secret)",
  "function executeAfter(bytes32 key) view returns (uint64)",
  "function beacon(bytes32 key) view returns (Beacon)",
  "function GRACE() view returns (uint64)",
  "error NotKeeper()",
  "error AlreadyCommitted(bytes32 key)",
  "error UnknownKey(bytes32 key)",
  "error AlreadyRevealed(bytes32 key)",
  "error WindowTooShort()",
  "error WindowAlreadyStarted()",
  "error WindowNotStarted()",
  "error RevealTooLate()",
  "error WrongSecret()",
]);

export const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote q)",
]);

export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/** Every custom error the keeper may see, for decoding reverts from any of its targets. */
export const errorsAbi = [...vaultAbi, ...crowdAbi, ...beaconAbi, ...stealthClaimsAbi].filter((x) => x.type === "error");

// Job liquidate: the protocol liquidator for the in-house perp markets (and settleHeld for dead markets).
export const perpMarketKeeperAbi = parseAbi([
  "function pool() view returns (address)",
  "function openPositions() view returns (address[])",
  "function isLiquidatable(address account) view returns (bool)",
  "function heldFor() view returns (uint256)",
  "function HELD_GRACE() view returns (uint256)",
  "function liquidate(address account)",
  "function settleHeld(address account)",
  "function openPositionCount() view returns (uint256)",
  "function lastPriceAt() view returns (uint256)",
  "function unpricedSince() view returns (uint256)",
  "function valuer() view returns (address)",
  "function underlying() view returns (address)",
  "function poke()",
  "event Liquidated(address indexed account, address indexed by, uint256 size, int256 equity, uint256 reward, uint256 price)",
  "error NotAuthorized()",
  "error NoPosition()",
  "error NotLiquidatable()",
  "error NotHeldLongEnough(uint256 heldFor)",
]);

export const perpPoolKeeperAbi = parseAbi(["function isOperator(address account, address operator) view returns (bool)"]);
