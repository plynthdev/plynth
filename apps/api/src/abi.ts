// The slice of each contract the API reads or builds calls for. Signatures mirror contracts/src; the tx
// builders are decoded against the compiled forge artifacts in test/api.anvil.test.ts.
import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct Account { uint256 available; uint256 pending; uint64 week; uint64 accruedThisWeek; uint64 lastTopUpAt; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount, address to)",
  "function setSettings(Settings s)",
  "function setMix(MixEntry[] mix)",
  "function settingsOf(address user) view returns (Settings)",
  "function accountOf(address user) view returns (Account)",
  "function mixOf(address user) view returns (MixEntry[])",
  "function MAX_WEEKLY_CAP() view returns (uint64)",
  "struct HiddenKeys { bytes32 ownerPk; bytes32 viewingPub; }",
  "function hiddenKeysOf(address user) view returns (HiddenKeys)",
  "event HiddenKeysSet(address indexed user, bytes32 ownerPk, bytes32 viewingPub)",
]);

export const crowdAbi = parseAbi([
  "struct Book { uint256 usdgTotal; uint32 accounts; uint64 openedAt; uint256 rawOut; bool executed; }",
  "function openBook(address asset) view returns (uint256 bookId, Book b)",
  "function book(address asset, uint256 bookId) view returns (Book)",
  "function allocationOf(address asset, uint256 bookId, address user) view returns (uint256)",
  "function claimOpen(address asset, uint256 bookId)",
  "function beaconKey(address asset, uint64 windowStart) pure returns (bytes32)",
  "function windowOf(uint256 t) view returns (uint64 start, uint64 end)",
  "function lastExecutedWindow(address asset) view returns (uint64)",
  "function MIN_CROWD() view returns (uint32)",
]);

export const beaconAbi = parseAbi([
  "struct Beacon { uint64 windowStart; uint64 windowEnd; uint64 executeAt; bytes32 commitment; }",
  "function beacon(bytes32 key) view returns (Beacon)",
]);

export const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote q)",
  "function value(address token, uint256 rawUnits) view returns (uint256 usd, bool hold)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
