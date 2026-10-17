// Treasury (Plinth) read models and unsigned-tx builders for the dashboard (todo 14).
//
// The chain is the source of truth for everything a number is shown for: wiring (account -> policy, guard,
// PeriodClose, approvals), the policy in force, NAV and positions (PolicyGuard.snapshot, one pinned block), and
// committed closes (PeriodClose.closeAt). The database adds history the chain does not keep: desk decisions
// (desk_actions), reconciler breaks (exceptions), jury verdicts, and the close bundles the CFO pack renders
// (which are only served when their keccak256 matches the on-chain bundleHash).
//
// The API holds no keys: treasury.create and policy.propose return {to, data, value, chainId} for the board
// Safe to sign. Nothing here writes to the database.
import { closes, deskActions, exceptions, juryVerdicts, navMarks, treasuryExceptionRequests } from "@/db";
import {
  compileTemplate,
  diff as policyDiffText,
  loadTemplate,
  policyAbiParam,
  PolicyError,
  summary,
  type Compiled,
  type Policy,
  type Template,
} from "@/treasury/policy-compiler";
import { CfoPackRefused, loadStatement, toCsv, toHtml, toJson } from "@/treasury/cfo-pack";
import { CloseStore } from "@/treasury/close/store";
import { receiptProof, receiptRoot, ReceiptNotFound } from "@/treasury/receipts/proof";
import { ReceiptStore } from "@/treasury/receipts/store";
import { and, count, desc, eq, gte, lt, lte } from "drizzle-orm";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToString,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { chainNow, type Deps } from "@/api/service";
import { fixed, iso, usd } from "@/api/format";
import { TxInputError, type UnsignedTx } from "@/api/tx";

export const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "..", "templates");
const ZERO = "0x0000000000000000000000000000000000000000";
const BPS = 10_000n;

export class TreasuryNotFound extends Error {}

// ------------------------------------------------------------------ ABI subsets (checked against forge out in tests)

const POLICY_STRUCT =
  "struct Policy { Band cash; Band equity; Band basis; int16 netDeltaMinBps; int16 netDeltaMaxBps; uint16 maxLeverageX10; uint64 perOrderCapUsd; uint64 perDayCapUsd; uint16 perNameFloatCapBps; uint16 perVenueCapBps; bool noNewRiskOffHours; int16 pauseNewRiskAtDrawdownBps; int16 deriskAtDrawdownBps; uint64 approvalAboveUsd; uint32 periodSeconds; bytes32 instrumentAllowRoot; bytes32 venueAllowRoot; address controller; }";
const CLOSE_STRUCT =
  "struct Close { uint64 periodEnd; uint256 navUsd; uint16 cashBps; uint16 equityBps; bytes32 positionsHash; bytes32 bundleHash; bytes32 policyHash; uint32 policyVersion; }";

export const factoryAbi = parseAbi([
  "function deploy(bytes compiledPolicy, address boardSafe) returns (address account, address policy, address close)",
  "function deployFromTemplate(bytes compiledPolicy, address boardSafe, uint256 templateId) returns (address account, address policy, address close)",
  "function templateOf(address account) view returns (uint256)",
  "event TreasuryFromTemplate(address indexed account, uint256 indexed templateId, bytes32 templateHash)",
  "function predict(address creator, address boardSafe) view returns (address account, address policy, address close, address approvals)",
  "function isTreasury(address account) view returns (bool)",
  "event TreasuryCreated(address indexed board, address indexed account, address indexed creator, address policy, address close, address approvals, bytes32 policyHash)",
]);

export const tAccountAbi = parseAbi([
  "struct Desk { address key; bool active; address[] adapters; }",
  "function board() view returns (address)",
  "function policy() view returns (address)",
  "function guard() view returns (address)",
  "function approvals() view returns (address)",
  "function periodClose() view returns (address)",
  "function trackedAssets() view returns (address[] assets, uint8[] kinds, uint8[] bands)",
  "function desk(bytes32 deskId) view returns (Desk)",
  "event DeskRegistered(bytes32 indexed deskId, address indexed key, address[] adapters)",
  "event DeskRevoked(bytes32 indexed deskId)",
]);

export const tPolicyAbi = parseAbi([
  "function TIMELOCK() view returns (uint64)",
  "struct Band { uint16 minBps; uint16 maxBps; }",
  POLICY_STRUCT,
  "function current() view returns (Policy, bytes32 hash, uint32 version)",
  "function policyAt(uint32 version) view returns (Policy, bytes32 hash, uint64 activatedAt)",
  "function pending() view returns (Policy, bytes32 hash, uint64 eta)",
  "function propose(Policy p)",
]);

export const tGuardAbi = parseAbi([
  "struct Pos { address underlying; uint256 notional; uint256 margin; }",
  "struct Venue { address venue; uint256 equity; uint256 gross; bool stale; Pos[] positions; }",
  "struct Snapshot { address[] assets; uint256[] raw; uint256[] usd; uint256 nav; uint256 cashUsd; uint256 equityUsd; uint256 eth; bool equityHold; uint256 basisUsd; uint256 stockUsd; int256 perpDeltaUsd; Venue[] venues; uint256 privateUsd; bool privateStale; }",
  "function snapshot(address account) view returns (Snapshot)",
]);

export const tCloseAbi = parseAbi([
  CLOSE_STRUCT,
  "function closeCount() view returns (uint256)",
  "function closeAt(uint256 index) view returns (Close)",
  "function nextPeriodEnd() view returns (uint64)",
  "function periodStartNav() view returns (uint256)",
  "function feeOwed() view returns (uint256)",
]);

export const templateRegistryAbi = parseAbi([
  "struct Template { address author; bytes32 policyHash; string metadataURI; bool listed; uint64 submittedAt; }",
  "function listedIds() view returns (uint256[])",
  "function get(uint256 id) view returns (Template)",
  "function isListed(uint256 id) view returns (bool)",
  "function priorityOf(uint256 id) view returns (uint8)",
  "function policyHashOf(uint256 id) view returns (bytes32)",
  "function submit(bytes32 policyHash, string metadataURI) returns (uint256 id)",
]);

const tokenAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

// ------------------------------------------------------------------ helpers

const KIND_NAMES = ["cash", "cash_vault", "stock_token"] as const;
const BAND_NAMES = ["cash", "equity", "basis"] as const;
const bps = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * BPS) / whole));
const lc = (a: string) => a.toLowerCase();

/** Policy struct as JSON (bigints as decimal strings). */
export function policyJson(p: Policy) {
  return {
    ...p,
    perOrderCapUsd: p.perOrderCapUsd.toString(),
    perDayCapUsd: p.perDayCapUsd.toString(),
    approvalAboveUsd: p.approvalAboveUsd.toString(),
    controller: getAddress(p.controller),
  };
}

function normPolicy(p: any): Policy {
  return {
    cash: { minBps: Number(p.cash.minBps), maxBps: Number(p.cash.maxBps) },
    equity: { minBps: Number(p.equity.minBps), maxBps: Number(p.equity.maxBps) },
    basis: { minBps: Number(p.basis.minBps), maxBps: Number(p.basis.maxBps) },
    netDeltaMinBps: Number(p.netDeltaMinBps),
    netDeltaMaxBps: Number(p.netDeltaMaxBps),
    maxLeverageX10: Number(p.maxLeverageX10),
    perOrderCapUsd: BigInt(p.perOrderCapUsd),
    perDayCapUsd: BigInt(p.perDayCapUsd),
    perNameFloatCapBps: Number(p.perNameFloatCapBps),
    perVenueCapBps: Number(p.perVenueCapBps),
    noNewRiskOffHours: Boolean(p.noNewRiskOffHours),
    pauseNewRiskAtDrawdownBps: Number(p.pauseNewRiskAtDrawdownBps),
    deriskAtDrawdownBps: Number(p.deriskAtDrawdownBps),
    approvalAboveUsd: BigInt(p.approvalAboveUsd),
    periodSeconds: Number(p.periodSeconds),
    instrumentAllowRoot: p.instrumentAllowRoot as Hex,
    venueAllowRoot: p.venueAllowRoot as Hex,
    controller: getAddress(p.controller),
  };
}

/** abi.encode(Policy): the bytes TreasuryFactory.deploy takes. */
export const encodePolicy = (p: Policy): Hex => encodeAbiParameters([policyAbiParam], [p]);

function networkOf(chainId: number, asked?: "mainnet" | "testnet"): "mainnet" | "testnet" {
  if (chainId === 4663) return "mainnet";
  if (chainId === 46630) return "testnet";
  return asked ?? "testnet";
}

export type TemplateInput = { templateName?: string; template?: unknown; controller: string; network?: "mainnet" | "testnet" };

/** A named template from templates/ or an inline template object, compiled for this chain. Bad input -> TxInputError. */
export function compileInput(chainId: number, i: TemplateInput): Compiled {
  let t: Template;
  if (i.templateName !== undefined) {
    if (!/^[a-z0-9-]{1,40}$/.test(i.templateName)) throw new TxInputError("templateName must be lower-case letters, digits or dashes");
    if (!templateNames().includes(i.templateName)) throw new TxInputError(`unknown template ${i.templateName}`);
    t = loadTemplate(join(TEMPLATES_DIR, `${i.templateName}.yaml`));
  } else if (i.template && typeof i.template === "object") {
    t = i.template as Template;
    if (t.extends) throw new TxInputError("inline templates cannot use extends");
  } else throw new TxInputError("pass templateName or template");
  try {
    return compileTemplate(t, { controller: i.controller, network: networkOf(chainId, i.network) });
  } catch (e) {
    if (e instanceof PolicyError) throw new TxInputError(`${e.code}: ${e.message}`);
    throw new TxInputError(e instanceof Error ? e.message : String(e));
  }
}

export function templateNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function templates() {
  return templateNames().map((name) => {
    const t = loadTemplate(join(TEMPLATES_DIR, `${name}.yaml`));
    return {
      name,
      description: t.description ?? "",
      network: t.network ?? "mainnet",
      tier: (t.hedge?.maxLeverageX10 ?? 0) > 0 ? "T2" : "T1",
      bands: t.bands,
      limits: t.limits,
      risk: t.risk,
      periodDays: t.periodDays,
      instruments: t.instruments,
    };
  });
}

export type Wiring = { account: Address; board: Address; policy: Address; guard: Address; approvals: Address; periodClose: Address | null };

/** Reads the account's wiring; anything that is not a TreasuryAccount is a 404. */
export async function wiring(d: Pick<Deps, "pub">, account: Address): Promise<Wiring> {
  const r = (fn: "board" | "policy" | "guard" | "approvals" | "periodClose") => d.pub.readContract({ address: account, abi: tAccountAbi, functionName: fn });
  try {
    const [board, policy, guard, approvals, pc] = await Promise.all([r("board"), r("policy"), r("guard"), r("approvals"), r("periodClose")]);
    if (lc(board) === ZERO || lc(policy) === ZERO) throw new Error("uninitialized");
    return { account, board, policy, guard, approvals, periodClose: lc(pc) === ZERO ? null : pc };
  } catch {
    throw new TreasuryNotFound(`${account} is not a treasury account`);
  }
}

function needClose(w: Wiring): Address {
  if (!w.periodClose) throw new TreasuryNotFound(`${w.account} has no PeriodClose`);
  return w.periodClose;
}

/** First block to scan for an account's logs: the factory's deploy block if known, else the deployment's. */
const scanFrom = (d: Deps) => d.dep.treasuryFactoryBlock ?? d.dep.deployBlock ?? 0n;

async function logsChunked<T>(pub: PublicClient, from: bigint, get: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, chunk = 50_000n): Promise<T[]> {
  const head = await pub.getBlockNumber();
  const out: T[] = [];
  for (let s = from; s <= head; s += chunk) out.push(...(await get(s, s + chunk - 1n < head ? s + chunk - 1n : head)));
  return out;
}

// ------------------------------------------------------------------ treasury.create

/** Marketplace hash of a compiled policy: abi.encode(policy) with the controller zeroed (TreasuryFactory.templateHash). */
export const templateHashOf = (p: Policy): Hex => keccak256(encodePolicy({ ...p, controller: zeroAddress }));

export async function treasuryCreate(d: Deps, i: TemplateInput & { board: Address; templateId?: number }) {
  const factory = d.dep.treasuryFactory;
  if (!factory) throw new TreasuryNotFound("no TreasuryFactory on this deployment");
  if (lc(i.board) === ZERO) throw new TxInputError("board must not be the zero address");
  const c = compileInput(d.chainId, i);
  let data: Hex;
  if (i.templateId !== undefined) {
    // Marketplace template: the compiled policy must be the listed template with only the controller filled in.
    const reg = d.dep.templateRegistry;
    if (!reg) throw new TreasuryNotFound("no TemplateRegistry on this deployment");
    const id = BigInt(i.templateId);
    if (!(await d.pub.readContract({ address: reg, abi: templateRegistryAbi, functionName: "isListed", args: [id] }))) throw new TxInputError(`template ${i.templateId} is not listed`);
    const want = await d.pub.readContract({ address: reg, abi: templateRegistryAbi, functionName: "policyHashOf", args: [id] });
    const got = templateHashOf(c.policy);
    if (lc(want) !== lc(got)) throw new TxInputError(`policy does not match template ${i.templateId} (template ${want}, got ${got})`);
    data = encodeFunctionData({ abi: factoryAbi, functionName: "deployFromTemplate", args: [encodePolicy(c.policy), i.board, id] });
  } else {
    data = encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [encodePolicy(c.policy), i.board] });
  }
  const [account, policy, close, approvals] = await d.pub.readContract({ address: factory, abi: factoryAbi, functionName: "predict", args: [i.board, i.board] }); // the board's Safe sends this tx: it is the creator
  const tx: UnsignedTx = { to: factory, data, value: "0", chainId: d.chainId };
  return {
    tx,
    policyHash: c.hash,
    templateHash: templateHashOf(c.policy),
    templateId: i.templateId ?? null,
    policy: policyJson(c.policy),
    summary: summary(c),
    instruments: c.instruments.map((x) => ({ label: x.label, asset: x.asset, kind: x.kindName, proof: x.proof })),
    predicted: { account, policy, close, approvals },
  };
}

// ------------------------------------------------------------------ marketplace (todo 30)

/** Listed marketplace templates, highest staking-tier priority first (then oldest first). */
export async function marketplaceList(d: Deps) {
  const reg = d.dep.templateRegistry;
  if (!reg) throw new TreasuryNotFound("no TemplateRegistry on this deployment");
  const ids = await d.pub.readContract({ address: reg, abi: templateRegistryAbi, functionName: "listedIds" });
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [t, priority] = await Promise.all([
        d.pub.readContract({ address: reg, abi: templateRegistryAbi, functionName: "get", args: [id] }),
        d.pub.readContract({ address: reg, abi: templateRegistryAbi, functionName: "priorityOf", args: [id] }),
      ]);
      return { id: Number(id), author: t.author, policyHash: t.policyHash, metadataURI: t.metadataURI, priority: Number(priority), submittedAt: iso(t.submittedAt) };
    }),
  );
  rows.sort((a, b) => b.priority - a.priority || a.id - b.id);
  return { registry: reg, templates: rows };
}

// ------------------------------------------------------------------ policy.*

/** TreasuryPolicy.TIMELOCK: a deploy-time value (48h on mainnet, 15 min on testnet), never assumed. */
async function policyTimelock(d: Deps, w: Wiring): Promise<bigint> {
  return BigInt(await d.pub.readContract({ address: w.policy, abi: tPolicyAbi, functionName: "TIMELOCK" }));
}

async function currentPolicy(d: Deps, w: Wiring) {
  const [p, hash, version] = await d.pub.readContract({ address: w.policy, abi: tPolicyAbi, functionName: "current" });
  const [, , activatedAt] = await d.pub.readContract({ address: w.policy, abi: tPolicyAbi, functionName: "policyAt", args: [version] });
  return { policy: normPolicy(p), hash, version: Number(version), activatedAt };
}

export async function policyCurrent(d: Deps, account: Address) {
  const w = await wiring(d, account);
  const cur = await currentPolicy(d, w);
  const [[pp, pendingHash, eta], timelock] = await Promise.all([
    d.pub.readContract({ address: w.policy, abi: tPolicyAbi, functionName: "pending" }),
    policyTimelock(d, w),
  ]);
  return {
    account,
    policyContract: w.policy,
    board: w.board,
    version: cur.version,
    hash: cur.hash,
    activatedAt: iso(cur.activatedAt),
    policy: policyJson(cur.policy),
    tier: cur.policy.maxLeverageX10 > 0 ? "T2" : "T1",
    timelockSeconds: Number(timelock),
    pending: eta === 0n ? null : { hash: pendingHash, eta: iso(eta), etaUnix: eta.toString(), policy: policyJson(normPolicy(pp)) },
  };
}

/** The on-chain policy as a Compiled (instrument list unknown: only its root is on-chain). */
function onchainCompiled(chainId: number, cur: { policy: Policy; hash: Hex }, instruments: Compiled["instruments"]): Compiled {
  return { name: "current", description: "", network: networkOf(chainId), policy: cur.policy, hash: cur.hash, instruments, venues: [] };
}

export async function policyDiff(d: Deps, account: Address, i: TemplateInput) {
  const w = await wiring(d, account);
  const cur = await currentPolicy(d, w);
  const next = compileInput(d.chainId, i);
  const sameRoot = lc(cur.policy.instrumentAllowRoot) === lc(next.policy.instrumentAllowRoot);
  // Same root: same instrument set. Otherwise only the root is comparable, so say so instead of guessing.
  let text = policyDiffText(onchainCompiled(d.chainId, cur, sameRoot ? next.instruments : []), next);
  if (!sameRoot) {
    text = text
      .split("\n")
      .filter((l) => !l.startsWith("+ instrument") && l !== "No changes.")
      .concat([`~ Instrument root: ${cur.policy.instrumentAllowRoot} -> ${next.policy.instrumentAllowRoot}`])
      .join("\n");
  }
  return { account, currentHash: cur.hash, currentVersion: cur.version, nextHash: next.hash, changed: lc(cur.hash) !== lc(next.hash), diff: text, next: policyJson(next.policy) };
}

export async function policyPropose(d: Deps, account: Address, i: TemplateInput) {
  const df = await policyDiff(d, account, i);
  if (!df.changed) throw new TxInputError("proposed policy is identical to the current one");
  const w = await wiring(d, account);
  const next = compileInput(d.chainId, i);
  const tx: UnsignedTx = { to: w.policy, data: encodeFunctionData({ abi: tPolicyAbi, functionName: "propose", args: [next.policy] }), value: "0", chainId: d.chainId };
  const [now, timelock] = await Promise.all([chainNow(d), policyTimelock(d, w)]);
  return { tx, hash: next.hash, diff: df.diff, activatableAfter: iso(now + timelock), from: w.board };
}

// ------------------------------------------------------------------ desk.list

const deskName = (id: Hex) => hexToString(id).replace(/\0+$/, "");

export async function deskList(d: Deps, account: Address) {
  await wiring(d, account);
  const regs = await logsChunked(d.pub, scanFrom(d), (fromBlock, toBlock) =>
    d.pub.getContractEvents({ address: account, abi: tAccountAbi, eventName: "DeskRegistered", fromBlock, toBlock, strict: true }),
  );
  const ids = [...new Set(regs.map((l) => (l.args as { deskId: Hex }).deskId))];
  const out = [];
  for (const id of ids) {
    const desk = await d.pub.readContract({ address: account, abi: tAccountAbi, functionName: "desk", args: [id] });
    const name = deskName(id);
    const [last] = await d.db
      .select()
      .from(deskActions)
      .where(and(eq(deskActions.chainId, d.chainId), eq(deskActions.account, lc(account)), eq(deskActions.desk, name)))
      .orderBy(desc(deskActions.id))
      .limit(1);
    out.push({
      deskId: id,
      name,
      key: desk.key,
      active: desk.active,
      adapters: [...desk.adapters],
      lastAction: last ? { id: last.id, action: last.action, status: last.status, reasonCode: last.reasonCode, at: last.createdAt.toISOString() } : null,
    });
  }
  return { account, desks: out };
}

// ------------------------------------------------------------------ nav / positions (one pinned block)

async function pinnedSnapshot(d: Deps, w: Wiring) {
  const block = await d.pub.getBlock({ blockTag: "latest" });
  const blockNumber = block.number!;
  const [snap, tracked] = await Promise.all([
    d.pub.readContract({ address: w.guard, abi: tGuardAbi, functionName: "snapshot", args: [w.account], blockNumber }),
    d.pub.readContract({ address: w.account, abi: tAccountAbi, functionName: "trackedAssets", blockNumber }),
  ]);
  return { block, blockNumber, snap, tracked };
}

export async function navLatest(d: Deps, account: Address) {
  const w = await wiring(d, account);
  const { block, blockNumber, snap } = await pinnedSnapshot(d, w);
  let periodStartNav: bigint | null = null;
  if (w.periodClose) periodStartNav = await d.pub.readContract({ address: w.periodClose, abi: tCloseAbi, functionName: "periodStartNav", blockNumber });
  const dd = periodStartNav ? Number(((snap.nav - periodStartNav) * BPS) / periodStartNav) : null;
  return {
    account,
    blockNumber: blockNumber.toString(),
    at: iso(block.timestamp),
    navUsd: usd(snap.nav),
    navUsdRaw: snap.nav.toString(),
    hold: snap.equityHold,
    bands: {
      cash: { usd: usd(snap.cashUsd), bps: bps(snap.cashUsd, snap.nav) },
      equity: { usd: usd(snap.equityUsd), bps: bps(snap.equityUsd, snap.nav) },
      basis: { usd: usd(snap.basisUsd), bps: bps(snap.basisUsd, snap.nav) },
    },
    periodStartNav: periodStartNav === null ? null : usd(periodStartNav),
    drawdownBps: dd,
  };
}

/** NAV marks written every 60 s by the valuer service (todo 30), newest first. */
export async function navHistory(d: Deps, account: Address, q: { limit: number; from?: Date | undefined; to?: Date | undefined }) {
  await wiring(d, account);
  const conds = [eq(navMarks.chainId, d.chainId), eq(navMarks.account, lc(account))];
  if (q.from) conds.push(gte(navMarks.ts, q.from));
  if (q.to) conds.push(lte(navMarks.ts, q.to));
  const rows = await d.db.select().from(navMarks).where(and(...conds)).orderBy(desc(navMarks.ts), desc(navMarks.id)).limit(q.limit);
  return {
    account,
    points: rows.map((m) => ({
      at: m.ts.toISOString(),
      blockNumber: m.blockNumber.toString(),
      blockTime: m.blockTime.toISOString(),
      navUsd: usd(BigInt(m.navUsd)),
      navUsdRaw: m.navUsd,
      cashBps: m.cashBps,
      equityBps: m.equityBps,
      basisBps: m.basisBps,
      hold: m.hold,
      weights: m.weights,
    })),
  };
}

export async function positionsList(d: Deps, account: Address) {
  const w = await wiring(d, account);
  const { blockNumber, snap, tracked } = await pinnedSnapshot(d, w);
  const [assets, kinds, bands] = tracked;
  const meta = await Promise.all(
    snap.assets.map(async (a) => {
      try {
        const [symbol, decimals] = await Promise.all([
          d.pub.readContract({ address: a, abi: tokenAbi, functionName: "symbol" }),
          d.pub.readContract({ address: a, abi: tokenAbi, functionName: "decimals" }),
        ]);
        return { symbol, decimals: Number(decimals) };
      } catch {
        return { symbol: "?", decimals: 18 };
      }
    }),
  );
  const positions = snap.assets.map((a, i) => {
    const j = assets.findIndex((x) => lc(x) === lc(a));
    return {
      asset: a,
      symbol: meta[i]!.symbol,
      kind: KIND_NAMES[kinds[j] ?? 0] ?? "unknown",
      band: BAND_NAMES[bands[j] ?? 0] ?? "unknown",
      raw: snap.raw[i]!.toString(),
      amount: fixed(snap.raw[i]!, meta[i]!.decimals),
      usd: usd(snap.usd[i]!),
      usdRaw: snap.usd[i]!.toString(),
      weightBps: bps(snap.usd[i]!, snap.nav),
    };
  });
  return { account, blockNumber: blockNumber.toString(), navUsd: usd(snap.nav), navUsdRaw: snap.nav.toString(), positions };
}

// ------------------------------------------------------------------ actions / exceptions (database)

export async function actionsList(d: Deps, account: Address, q: { desk?: string | undefined; cursor?: number | undefined; limit: number }) {
  await wiring(d, account);
  const conds = [eq(deskActions.chainId, d.chainId), eq(deskActions.account, lc(account))];
  if (q.desk) conds.push(eq(deskActions.desk, q.desk));
  if (q.cursor !== undefined) conds.push(lt(deskActions.id, q.cursor));
  const rows = await d.db.select().from(deskActions).where(and(...conds)).orderBy(desc(deskActions.id)).limit(q.limit);
  return {
    account,
    actions: rows.map((r) => ({
      id: r.id,
      desk: r.desk,
      action: r.action,
      status: r.status,
      reasonCode: r.reasonCode,
      reason: r.reason,
      adapter: r.adapter,
      asset: r.asset,
      amount: r.amount,
      notionalUsd: r.notionalUsd === null ? null : usd(BigInt(r.notionalUsd)),
      txHash: r.txHash,
      blockNumber: r.blockNumber?.toString() ?? null,
      at: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null,
  };
}

export async function exceptionsList(d: Deps, account: Address, status?: string) {
  const w = await wiring(d, account);
  const ex = await d.db
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.chainId, d.chainId), eq(exceptions.account, lc(account)), ...(status ? [eq(exceptions.status, status)] : [])))
    .orderBy(desc(exceptions.id));
  const jv = await d.db
    .select()
    .from(juryVerdicts)
    .where(and(eq(juryVerdicts.chainId, d.chainId), eq(juryVerdicts.account, lc(account))))
    .orderBy(desc(juryVerdicts.id));
  const reqs = await d.db
    .select()
    .from(treasuryExceptionRequests)
    .where(and(eq(treasuryExceptionRequests.chainId, d.chainId), eq(treasuryExceptionRequests.account, lc(account))))
    .orderBy(desc(treasuryExceptionRequests.id));
  return {
    account,
    approvals: w.approvals,
    requests: reqs.map((r) => ({ id: r.id, desk: r.desk, action: r.action, asset: r.asset, amountUsd: r.amountUsd, reason: r.reason, status: r.status, tokenId: r.tokenId, at: r.createdAt.toISOString() })),
    reconcile: ex.map((e) => ({
      id: e.id,
      kind: e.kind,
      key: e.key,
      venue: e.venue,
      underlying: e.underlying,
      status: e.status,
      detail: e.detail,
      explanation: e.explanation,
      firstSeenAt: e.firstSeenAt.toISOString(),
      lastSeenAt: e.lastSeenAt.toISOString(),
      closedAt: e.closedAt?.toISOString() ?? null,
    })),
    boardTickets: jv.map((v) => ({
      id: v.id,
      desk: v.desk,
      opHash: v.opHash,
      ticket: v.ticket,
      recommendation: v.recommendation,
      ruleRecommendation: v.ruleRecommendation,
      mode: v.mode,
      status: v.status,
      bundleHash: v.bundleHash,
      at: v.createdAt.toISOString(),
    })),
  };
}

// ------------------------------------------------------------------ close.* / cfo.pack

const closeJson = (index: number, c: { periodEnd: bigint; navUsd: bigint; cashBps: number; equityBps: number; positionsHash: Hex; bundleHash: Hex; policyHash: Hex; policyVersion: number }) => ({
  index,
  periodEnd: iso(c.periodEnd),
  periodEndUnix: c.periodEnd.toString(),
  navUsd: usd(c.navUsd),
  navUsdRaw: c.navUsd.toString(),
  cashBps: c.cashBps,
  equityBps: c.equityBps,
  positionsHash: c.positionsHash,
  bundleHash: c.bundleHash,
  policyHash: c.policyHash,
  policyVersion: c.policyVersion,
});

export async function closeList(d: Deps, account: Address) {
  const w = await wiring(d, account);
  const pc = needClose(w);
  const [n, next, owed] = await Promise.all([
    d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "closeCount" }),
    d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "nextPeriodEnd" }),
    d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "feeOwed" }),
  ]);
  const onchain = await Promise.all(Array.from({ length: Number(n) }, (_, i) => d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "closeAt", args: [BigInt(i)] })));
  const rows = await d.db
    .select()
    .from(closes)
    .where(and(eq(closes.chainId, d.chainId), eq(closes.periodClose, lc(pc))))
    .orderBy(desc(closes.id));
  const byHash = new Map(rows.map((r) => [lc(r.bundleHash), r]));
  const committedHashes = new Set(onchain.map((c) => lc(c.bundleHash)));
  return {
    account,
    periodClose: pc,
    nextPeriodEnd: iso(next),
    feeOwedUsdg: fixed(owed, 6),
    closes: onchain
      .map((c, i) => {
        const r = byHash.get(lc(c.bundleHash));
        return { ...closeJson(i, c), txHash: r?.txHash ?? null, bundleStored: r !== undefined };
      })
      .reverse(),
    pending: rows
      .filter((r) => !committedHashes.has(lc(r.bundleHash)))
      .map((r) => ({ id: r.id, status: r.status, periodEndUnix: r.periodEnd.toString(), navUsd: usd(BigInt(r.navUsd)), bundleHash: r.bundleHash, error: r.error, at: r.createdAt.toISOString() })),
  };
}

export async function closeGet(d: Deps, account: Address, index: number) {
  const w = await wiring(d, account);
  const pc = needClose(w);
  const n = Number(await d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "closeCount" }));
  if (index >= n) throw new TreasuryNotFound(`no close #${index} (${n} committed)`);
  const store = new CloseStore(d.db);
  const c = await d.pub.readContract({ address: pc, abi: tCloseAbi, functionName: "closeAt", args: [BigInt(index)] });
  const row = await store.byBundleHash(d.chainId, pc, c.bundleHash);
  const hint = row?.blockNumber ?? undefined;
  let verified: { bundle: unknown; fee: { feeRaw: string; feePaid: string; feeOwed: string }; txHash: Hex; blockNumber: string } | null = null;
  let refused: string | null = null;
  try {
    const s = await loadStatement(d.pub, pc, { index, fromBlock: hint ?? scanFrom(d), toBlock: hint }, async (cid, addr, h) => (await store.byBundleHash(cid, addr, h))?.bundleJson);
    verified = {
      bundle: s.bundle,
      fee: { feeRaw: fixed(s.event.feeRaw, 6), feePaid: fixed(s.event.feePaid, 6), feeOwed: fixed(s.event.feeOwed, 6) },
      txHash: s.event.txHash,
      blockNumber: s.event.blockNumber.toString(),
    };
  } catch (e) {
    if (!(e instanceof CfoPackRefused)) throw e;
    refused = e.message;
  }
  return { account, periodClose: pc, close: closeJson(index, c), ...(verified ?? { bundle: null, fee: null, txHash: row?.txHash ?? null, blockNumber: null }), bundleVerified: verified !== null, refused };
}

export const CFO_FORMATS = ["json", "csv", "html"] as const;
export type CfoFormat = (typeof CFO_FORMATS)[number];

export async function cfoPack(d: Deps, account: Address, periodEnd: bigint, format: CfoFormat) {
  const w = await wiring(d, account);
  const pc = needClose(w);
  const store = new CloseStore(d.db);
  const hint = await store.committedAt(d.chainId, pc, periodEnd);
  const s = await loadStatement(
    d.pub,
    pc,
    { periodEnd, fromBlock: hint?.blockNumber ?? scanFrom(d), toBlock: hint?.blockNumber ?? undefined },
    async (cid, addr, h) => (await store.byBundleHash(cid, addr, h))?.bundleJson,
  );
  const base = `plinth-statement-${s.event.index}`;
  if (format === "json") return { format, contentType: "application/json", filename: `${base}.json`, body: JSON.stringify(toJson(s), null, 2) };
  if (format === "csv") return { format, contentType: "text/csv; charset=utf-8", filename: `${base}.csv`, body: toCsv(s) };
  return { format, contentType: "text/html; charset=utf-8", filename: `${base}.html`, body: toHtml(s) };
}

export { CfoPackRefused, ReceiptNotFound };

// ------------------------------------------------------------------ receipts (todo 30)

const receiptDeps = (d: Deps) => ({ pub: d.pub, store: new ReceiptStore(d.db), chainId: d.chainId, receipts: d.dep.receipts });

export async function receiptsRoot(d: Deps, account: Address, hour: bigint) {
  await wiring(d, account);
  return receiptRoot(receiptDeps(d), account, hour);
}

export async function receiptsProof(d: Deps, account: Address, actionId: number) {
  await wiring(d, account);
  return receiptProof(receiptDeps(d), account, actionId);
}

// ------------------------------------------------------------------ exception requests (MCP, todo 30)

/** Pending requests one MCP token may have open at once (a runaway agent cannot flood the board). */
export const MAX_PENDING_REQUESTS = 20;

export type ExceptionRequestInput = { action: string; desk?: string | undefined; asset?: Address | undefined; amountUsd?: string | undefined; reason: string };

/**
 * Files an exception request for the board. It changes nothing on-chain and grants nothing: the board still
 * decides (BoardApprovals); this only puts the ask in front of it (exceptions.list -> requests).
 */
export async function fileExceptionRequest(d: Deps, account: Address, tokenId: string, i: ExceptionRequestInput) {
  await wiring(d, account);
  if (!/^[a-z_]{1,32}$/.test(i.action)) throw new TxInputError("action: 1-32 lower-case letters or _");
  if (i.desk !== undefined && !/^[a-z0-9_-]{1,32}$/.test(i.desk)) throw new TxInputError("desk: 1-32 lower-case letters, digits, _ or -");
  if (i.amountUsd !== undefined && !/^\d{1,15}(\.\d{1,2})?$/.test(i.amountUsd)) throw new TxInputError("amountUsd: decimal USD, at most 2 decimals");
  const reason = i.reason.trim();
  if (reason.length < 10 || reason.length > 2000) throw new TxInputError("reason: 10-2000 characters");
  const [{ n }] = (await d.db
    .select({ n: count() })
    .from(treasuryExceptionRequests)
    .where(and(eq(treasuryExceptionRequests.tokenId, tokenId), eq(treasuryExceptionRequests.status, "pending")))) as [{ n: number }];
  if (n >= MAX_PENDING_REQUESTS) throw new TxInputError(`this token already has ${n} pending requests (max ${MAX_PENDING_REQUESTS})`);
  const [row] = await d.db
    .insert(treasuryExceptionRequests)
    .values({ chainId: d.chainId, account: lc(account), tokenId, desk: i.desk ?? null, action: i.action, asset: i.asset ? lc(i.asset) : null, amountUsd: i.amountUsd ?? null, reason, status: "pending" })
    .returning();
  return { id: row!.id, status: "pending" as const, needs: "board approval", at: row!.createdAt.toISOString() };
}
