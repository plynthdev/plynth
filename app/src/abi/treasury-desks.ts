// Hand-written ABI subsets the desks need. test/abi.test.ts checks every selector against contracts/out.
import { parseAbi } from "viem";

/** Every custom error a desk operation can revert with, so eth_call reverts decode to a name. */
export const errorsAbi = parseAbi([
  // TreasuryAccount
  "error GuardRejected(uint8 code)",
  "error NotBoard()",
  "error BadDesk()",
  "error DeskNotActive()",
  // CashSleeve
  "error UnknownVault(address vault)",
  "error UnknownOp(uint8 op)",
  "error ZeroAmount()",
  "error MinOut(uint256 minOut, uint256 got)",
  "error Residual(address token)",
  // EquitySleeve
  "error UnknownToken(address token)",
  "error SlippageAbovePolicy(uint16 asked, uint16 allowed)",
  "error FloatCapExceeded(address token, uint256 held, uint256 cap)",
  // StockRouter / Valuer
  "error NotCanonical(address token)",
  "error MarketOnHold(address token)",
  "error Slippage(uint256 minOut, uint256 got)",
  "error SlippageTooHigh(uint16 bps)",
  "error NoPool(address token)",
  "error PartialFill(uint256 wanted, uint256 used)",
  "error BadAnswer(address token, int256 answer)",
  // OpenZeppelin ERC20 / ERC4626
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)",
  "error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)",
  "error SafeERC20FailedOperation(address token)",
  "error ReentrancyGuardReentrantCall()",
  // JitterBeacon
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

export const accountAbi = [
  ...parseAbi([
    "struct Pull { address token; uint256 amount; }",
    "function execute(bytes32 deskId, address adapter, bytes data, bytes32[] allowProof, bytes32 approvalTicket) returns (bytes)",
    "function trackedAssets() view returns (address[] assets, uint8[] kinds, uint8[] bands)",
    "function policy() view returns (address)",
    "function guard() view returns (address)",
    "function isDeskKey(address key) view returns (bool)",
    "function navUsd() view returns (uint256 nav, bool hold)",
    "function registerDesk(bytes32 deskId, address key, address[] adapters)",
  ]),
  ...errorsAbi,
] as const;

export const guardAbi = parseAbi([
  "struct Pos { address underlying; uint256 notional; uint256 margin; }",
  "struct Venue { address venue; uint256 equity; uint256 gross; bool stale; Pos[] positions; }",
  "struct Snapshot { address[] assets; uint256[] raw; uint256[] usd; uint256 nav; uint256 cashUsd; uint256 equityUsd; uint256 eth; bool equityHold; uint256 basisUsd; uint256 stockUsd; int256 perpDeltaUsd; Venue[] venues; uint256 privateUsd; bool privateStale; }",
  "function snapshot(address account) view returns (Snapshot)",
  "function dayTotal(address account) view returns (uint256)",
  "function dayLoss(address account) view returns (uint256)",
  "function DAY_LOSS_BPS() view returns (uint256)",
  "function maxOpLossBps() view returns (uint16)",
]);

export const policyAbi = parseAbi([
  "struct Band { uint16 minBps; uint16 maxBps; }",
  "struct Policy { Band cash; Band equity; Band basis; int16 netDeltaMinBps; int16 netDeltaMaxBps; uint16 maxLeverageX10; uint64 perOrderCapUsd; uint64 perDayCapUsd; uint16 perNameFloatCapBps; uint16 perVenueCapBps; bool noNewRiskOffHours; int16 pauseNewRiskAtDrawdownBps; int16 deriskAtDrawdownBps; uint64 approvalAboveUsd; uint32 periodSeconds; bytes32 instrumentAllowRoot; bytes32 venueAllowRoot; address controller; }",
  "function current() view returns (Policy, bytes32 hash, uint32 version)",
]);

export const equitySleeveAbi = parseAbi([
  "function assets() view returns (address[], uint8[])",
  "function holdings(address account) view returns (address[] tokens, uint256[] raw)",
  "function floatCapRaw(address token, uint16 floatCapBps) view returns (uint256)",
  "function valueOf(address account) view returns (uint256 usd, bool hold)",
  "function valuer() view returns (address)",
]);

export const cashSleeveAbi = parseAbi([
  "function assets() view returns (address[], uint8[])",
  "function vaults() view returns (address[])",
  "function valueOf(address account) view returns (uint256 usd, bool hold)",
]);

export const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote)",
]);

export const vaultAbi = parseAbi([
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const beaconAbi = [
  ...parseAbi([
    "struct Beacon { uint64 windowStart; uint64 windowEnd; uint64 executeAt; bytes32 commitment; }",
    "function commit(bytes32 key, uint64 windowStart, uint64 windowEnd, bytes32 commitment)",
    "function reveal(bytes32 key, bytes32 secret)",
    "function executeAfter(bytes32 key) view returns (uint64)",
    "function beacon(bytes32 key) view returns (Beacon)",
    "function keeper() view returns (address)",
    "function GRACE() view returns (uint64)",
  ]),
  ...errorsAbi,
] as const;
