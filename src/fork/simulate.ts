// Simulate before sending (todo 41 item 4): every transaction is run as an eth_call first; a revert is decoded
// against the custom errors of the contracts the dashboard talks to and shown as a sentence, and the wallet is
// never opened (MetaMask would otherwise show "fee unavailable" for a call that can only revert).
import { decodeErrorResult, parseAbi, type Hex } from "viem";

/** Custom errors of SavingsVault, CrowdBuy, EligibilityRegistry, StealthClaims, ShieldedPool, MockUSDG (OZ ERC20)
 *  and StockRouter, from backend/contracts/out (regenerate when a contract's errors change). */
export const ERRORS_ABI = parseAbi([
  "error AlreadyAccrued(bytes32 sourceTx, uint32 logIndex)",
  "error BadSignature()",
  "error CrowdAlreadySet()",
  "error EligibilityAlreadySet()",
  "error InsufficientBalance(uint256 requested, uint256 balance)",
  "error InvalidMix()",
  "error InvalidSettings()",
  "error InvalidShortString()",
  "error NoFixedTopUp()",
  "error NoMix()",
  "error NotCrowd()",
  "error NotEligible(address user)",
  "error NotKeeper()",
  "error NotLinked()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)",
  "error SafeERC20FailedOperation(address token)",
  "error SignatureExpired()",
  "error StringTooLong(string str)",
  "error TopUpTooSoon(uint256 nextAt)",
  "error WrongPermitToken()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error AlreadyExecuted()",
  "error AlreadyExecutedThisWindow(uint64 windowStart)",
  "error AlreadySet()",
  "error AlreadySettled()",
  "error BadEphemeralKey()",
  "error BadParam()",
  "error BadWindow()",
  "error BeforeGenesis()",
  "error CrowdTooSmall(uint32 accounts, uint32 minCrowd)",
  "error HiddenNotConfigured()",
  "error MarketOnHold(address asset)",
  "error NoHiddenKeys(address user)",
  "error NoMetaAddress(address user)",
  "error NoOrder()",
  "error NotExecuted()",
  "error NotHidden(address user)",
  "error NotQuiet(address user)",
  "error NotYet()",
  "error NothingPending()",
  "error QuietNotConfigured()",
  "error ReentrancyGuardReentrantCall()",
  "error TooEarly(uint64 executeAfter)",
  "error UnknownRoute(bytes route)",
  "error NotAttester()",
  "error Stale()",
  "error BadDestination()",
  "error Expired(uint256 deadline)",
  "error PoolTooSmall(uint256 pooled, uint256 raw)",
  "error Underfunded(uint256 have, uint256 need)",
  "error BadAmount()",
  "error CapExceeded(uint256 shielded, uint256 raw, uint256 cap)",
  "error DelayTooShort()",
  "error InvalidProof()",
  "error LevelOutOfRange()",
  "error NoProposal()",
  "error NotAFieldElement()",
  "error NotOrigin(uint256 pendingId)",
  "error NotPending(uint256 pendingId)",
  "error NotTrade()",
  "error NoteTooLarge()",
  "error NothingToInsert()",
  "error NullifierAlreadySpent(bytes32 nullifier)",
  "error Paused()",
  "error TooLate()",
  "error TransferAmountMismatch(uint256 received, uint256 expected)",
  "error UnknownRoot(bytes32 root)",
  "error AccountFrozen(address account)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidSpender(address spender)",
  "error BadPoolKey()",
  "error NoPool(address token)",
  "error NotCanonical(address token)",
  "error NotPoolManager()",
  "error PartialFill(uint256 wanted, uint256 used)",
  "error Slippage(uint256 minOut, uint256 got)",
  "error SlippageTooHigh(uint16 bps)"
]);

/** One sentence a person can act on, per error the dashboard's own actions can hit. */
const FRIENDLY: Record<string, (args: readonly unknown[]) => string> = {
  NotEligible: () =>
    "This address is not eligible yet. Finish the eligibility self-attestation (Settings → Sign and attest) first.",
  NothingPending: () =>
    "Nothing pending to join: only pending round-ups join a Crowd Buy (import a statement to get some).",
  InsufficientBalance: (a) =>
    `The vault holds less than that (asked ${usdg(a[0])} USDG, have ${usdg(a[1])} USDG).`,
  ERC20InsufficientBalance: (a) =>
    `Your wallet holds ${usdg(a[1])} USDG, the transaction needs ${usdg(a[2])} USDG.`,
  ERC20InsufficientAllowance: (a) =>
    `The USDG allowance is ${usdg(a[1])}, the transaction needs ${usdg(a[2])}.`,
  InvalidMix: () => "The buy mix is not valid: 1 to 5 Stock Tokens, percentages adding up to 100.",
  NoMix: () => "Save a buy mix first.",
  InvalidSettings: () => "These settings are out of range (round to 1/5/10, multiplier 1-3, weekly cap at most 500).",
  ZeroAmount: () => "The amount must be more than 0.",
  CapExceeded: () => "The Hidden Vault deposit cap would be exceeded.",
  NoOrder: () => "You have no order in that book.",
  NotExecuted: () => "That book has not executed yet.",
  AlreadySettled: () => "That allocation was already claimed.",
  Stale: () => "The eligibility attestation is stale: sign and attest again.",
  BadSignature: () => "The signature was refused.",
};

const usdg = (v: unknown) => {
  const b = typeof v === "bigint" ? v : 0n;
  const frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${b / 1_000_000n}${frac ? `.${frac}` : ""}`;
};

export type DecodedRevert = { name: string; args: readonly unknown[]; message: string };

/** Revert data -> error name, args and a sentence; null when the data matches none of the known errors. */
export function decodeRevert(data: Hex | undefined): DecodedRevert | null {
  if (!data || data === "0x" || data.length < 10) return null;
  try {
    const r = decodeErrorResult({ abi: ERRORS_ABI, data });
    const args = (r.args ?? []) as readonly unknown[];
    const f = FRIENDLY[r.errorName];
    return { name: r.errorName, args, message: f ? f(args) : `${r.errorName}(${args.map(String).join(", ")})` };
  } catch {
    try {
      // Error(string) and Panic(uint256) are built into viem's decoder even with a custom ABI.
      const r = decodeErrorResult({ abi: [], data });
      const args = (r.args ?? []) as readonly unknown[];
      return { name: r.errorName, args, message: `${r.errorName}: ${args.map(String).join(", ")}` };
    } catch {
      return null;
    }
  }
}

/** Finds revert data anywhere in a viem error chain (CallExecutionError -> RpcRequestError -> {data}). */
export function revertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  const stack: unknown[] = [err];
  while (stack.length) {
    cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const o = cur as { data?: unknown; cause?: unknown; error?: unknown; raw?: unknown };
    if (typeof o.raw === "string" && /^0x[0-9a-fA-F]{8,}$/.test(o.raw)) return o.raw as Hex;
    if (typeof o.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(o.data)) return o.data as Hex;
    if (o.data && typeof o.data === "object") stack.push(o.data);
    stack.push(o.cause, o.error);
  }
  return undefined;
}

/** Thrown instead of opening the wallet when the simulation reverts. */
export class SimulationRevert extends Error {
  constructor(
    readonly label: string,
    readonly decoded: DecodedRevert | null,
    fallback: string,
  ) {
    super(
      decoded
        ? `${label} would revert (${decoded.name}): ${decoded.message} Nothing was sent.`
        : `${label} would revert: ${fallback} Nothing was sent.`,
    );
  }
}

export type SimClient = {
  getBlockNumber(): Promise<bigint>;
  call(a: { account: Hex; to: Hex; data: Hex; value: bigint }): Promise<unknown>;
  estimateGas(a: { account: Hex; to: Hex; data: Hex; value: bigint }): Promise<bigint>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the transaction as an eth_call (after the node has seen `minBlock`, the receipt of the action's previous
 * transaction, since a load-balanced public RPC can answer from an older node) and returns a gas limit with
 * headroom (+25% +50k, as the backend's lib/gas.ts) so the wallet does not estimate on its own. A revert throws
 * SimulationRevert; one retry after a short pause absorbs a node that was a block behind.
 */
export async function simulateTx(
  client: SimClient,
  req: { account: Hex; to: Hex; data: Hex; value: bigint },
  label: string,
  opts: { minBlock?: bigint; waitMs?: number; retryMs?: number } = {},
): Promise<bigint> {
  const waitMs = opts.waitMs ?? 15_000;
  if (opts.minBlock !== undefined) {
    const until = Date.now() + waitMs;
    while ((await client.getBlockNumber()) < opts.minBlock && Date.now() < until) await sleep(500);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.call(req);
      const gas = await client.estimateGas(req);
      return (gas * 125n) / 100n + 50_000n;
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && opts.minBlock !== undefined) await sleep(opts.retryMs ?? 2_000);
      else break;
    }
  }
  const data = revertData(lastErr);
  const short = (lastErr as { shortMessage?: string })?.shortMessage ?? (lastErr as Error)?.message ?? "reverted";
  throw new SimulationRevert(label, decodeRevert(data), short);
}
