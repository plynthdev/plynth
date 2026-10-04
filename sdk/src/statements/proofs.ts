// Threshold proofs for the Hidden Vault (circuits/threshold_holdings, circuits/threshold_savings).
//
//   proveHoldingsAtLeast: "I hold unspent notes of asset A worth >= X raw units" at a pool root.
//   proveSavingsAtLeast:  "my deposits of asset A between two deposit-tree roots add up to >= X raw units".
//   verifyHoldings / verifySavings: stateless checks through ThresholdVerifier's views (eth_call, no gas).
//
// Every proof is bound to one verifier request: verifierNonce(chainId, thresholdVerifier, verifier, requestId).
// What a verifier learns (and the linking risks) is written up in the SDK README, "Threshold proofs".
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseAbiItem,
  toBytes,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import holdingsArtifact from "../vault/artifacts/threshold_holdings.json" with { type: "json" };
import savingsArtifact from "../vault/artifacts/threshold_savings.json" with { type: "json" };
import type { VaultKeys } from "../vault/keys";
import { MAX_RAW, P, TREE_DEPTH, ZERO_LEAF, nullifierOf, toBytes32 } from "../vault/note";
import { proveCircuit, verifyCircuitProof } from "../vault/prover";
import type { OwnedNote } from "../vault/sync";
import { NoteTree } from "../vault/tree";
import { logsChunked } from "./scan";

/** Notes (holdings) or deposits (savings) one proof can count. */
export const MAX_THRESHOLD_NOTES = 8;
export const NONCE_DOMAIN = keccak256(toBytes("plynth.threshold.nonce.v1"));

export const thresholdVerifierAbi = parseAbi([
  "struct HoldingsClaim { bytes32 root; address asset; uint256 threshold; bytes32[8] nullifiers; }",
  "struct SavingsClaim { bytes32 rootFrom; bytes32 rootTo; address asset; uint256 threshold; }",
  "struct DepositRoot { uint64 seq; uint64 size; uint64 blockNumber; uint64 timestamp; }",
  "struct HoldingsResult { uint256 poolRootSeq; uint256 notes; }",
  "function pool() view returns (address)",
  "function syncDeposits(uint256 maxCount) returns (uint256 added)",
  "function unsyncedDeposits() view returns (uint256)",
  "function depositCount() view returns (uint256)",
  "function depositRoot() view returns (bytes32)",
  "function depositRootInfo(bytes32 root) view returns (DepositRoot)",
  "function nonceFor(address verifier, bytes32 requestId) view returns (bytes32)",
  "function checkHoldings(bytes proof, HoldingsClaim claim, address verifier, bytes32 requestId) view returns (HoldingsResult)",
  "function checkSavings(bytes proof, SavingsClaim claim, address verifier, bytes32 requestId) view returns (DepositRoot from, DepositRoot to)",
  "function verifyHoldings(bytes proof, HoldingsClaim claim, address verifier, bytes32 requestId) view returns (bool)",
  "function verifySavings(bytes proof, SavingsClaim claim, address verifier, bytes32 requestId) view returns (bool)",
  "event DepositLeaf(uint256 indexed depositIndex, uint256 indexed pendingId, bytes32 commitment)",
  "event DepositRootUpdated(bytes32 root, uint256 size)",
  "error ZeroAddress()",
  "error NothingToSync()",
  "error TreeFull()",
  "error UnknownRoot(bytes32 root)",
  "error UnknownDepositRoot(bytes32 root)",
  "error BadWindow()",
  "error BadThreshold()",
  "error NotAFieldElement()",
  "error NullifierSpent(bytes32 nullifier)",
  "error DuplicateNullifier(bytes32 nullifier)",
  "error InvalidProof()",
]);
const depositLeafEvent = parseAbiItem("event DepositLeaf(uint256 indexed depositIndex, uint256 indexed pendingId, bytes32 commitment)");
const depositRootEvent = parseAbiItem("event DepositRootUpdated(bytes32 root, uint256 size)");

export type HoldingsClaim = { root: Hex; asset: Address; threshold: string; nullifiers: Hex[] };
export type SavingsClaim = { rootFrom: Hex; rootTo: Hex; asset: Address; threshold: string };
type Binding = { version: 1; chainId: number; thresholdVerifier: Address; proof: Hex };
export type HoldingsProof = Binding & { kind: "plynth.threshold.holdings"; claim: HoldingsClaim };
export type SavingsProof = Binding & { kind: "plynth.threshold.savings"; claim: SavingsClaim };
export type ThresholdProof = HoldingsProof | SavingsProof;

/** Who asks: the verifier's identity (an address it controls, or a gating contract) and its request id. */
export type VerifierRequest = { chainId: number | bigint; thresholdVerifier: Address; verifier: Address; requestId: Hex };

export class ThresholdNotMet extends Error {}

/** The verifier_nonce for one request; equals ThresholdVerifier.nonceFor(verifier, requestId) on that chain. */
export function verifierNonce(r: VerifierRequest): bigint {
  const h = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [NONCE_DOMAIN, BigInt(r.chainId), getAddress(r.thresholdVerifier), getAddress(r.verifier), r.requestId],
    ),
  );
  return BigInt(h) % P;
}

const f = (x: bigint) => toBytes32(x);
const padSlot = () => ({ is_real: false, amount: f(0n), blinding: f(0n), index: f(0n), path: Array(TREE_DEPTH).fill(f(0n)) });

/** Largest first, up to MAX_THRESHOLD_NOTES, stopping as soon as the sum reaches `threshold`. */
function pick<T extends { raw: bigint }>(items: T[], threshold: bigint, what: string): T[] {
  if (threshold < 0n || threshold > MAX_RAW) throw new Error("threshold must be 0..2^128-1");
  const sorted = [...items].sort((a, b) => (a.raw === b.raw ? 0 : a.raw > b.raw ? -1 : 1));
  const out: T[] = [];
  let sum = 0n;
  for (const it of sorted) {
    if (sum >= threshold && out.length > 0) break;
    if (out.length === MAX_THRESHOLD_NOTES) break;
    out.push(it);
    sum += it.raw;
  }
  if (sum < threshold) {
    throw new ThresholdNotMet(`${what}: the ${MAX_THRESHOLD_NOTES} largest add up to less than the threshold`);
  }
  return out;
}

/**
 * Holdings proof at the root of `tree` (a ShieldedPool tree synced to a block boundary, so its root is one the
 * pool published). Uses the fewest unspent notes of `asset` that reach `threshold`: every counted note's
 * nullifier is public (see README), so fewer notes means less to link.
 */
export async function proveHoldingsAtLeast(p: VerifierRequest & {
  keys: VaultKeys;
  tree: NoteTree;
  notes: OwnedNote[];
  asset: Address;
  threshold: bigint;
}): Promise<HoldingsProof> {
  const asset = getAddress(p.asset);
  const usable = p.notes.filter((n) => getAddress(n.asset) === asset && n.leafIndex !== null && !n.spent && p.tree.leaf(n.leafIndex) === n.commitment);
  const chosen = pick(usable, p.threshold, "unspent notes");
  const nonce = verifierNonce(p);
  const nullifiers = chosen.map((n) => nullifierOf(n.commitment, p.keys.spendingSecret, BigInt(n.leafIndex!)));
  while (nullifiers.length < MAX_THRESHOLD_NOTES) nullifiers.push(0n);
  const root = p.tree.root();
  const notes = chosen.map((n) => ({ is_real: true, amount: f(n.raw), blinding: f(n.blinding), index: f(BigInt(n.leafIndex!)), path: p.tree.path(n.leafIndex!).map(f) }));
  while (notes.length < MAX_THRESHOLD_NOTES) notes.push(padSlot());
  const { proof } = await proveCircuit(holdingsArtifact, {
    root: f(root),
    asset_id: f(BigInt(asset)),
    threshold: f(p.threshold),
    verifier_nonce: f(nonce),
    nullifier_hashes: nullifiers.map(f),
    secret: f(p.keys.spendingSecret),
    notes,
  });
  return {
    version: 1,
    kind: "plynth.threshold.holdings",
    chainId: Number(p.chainId),
    thresholdVerifier: getAddress(p.thresholdVerifier),
    proof,
    claim: { root: f(root), asset, threshold: p.threshold.toString(), nullifiers: nullifiers.map(f) },
  };
}

// ---------------------------------------------------------------- deposit tree (ThresholdVerifier)

export type DepositRootRecord = { root: bigint; size: number; block: bigint };
export type DepositTreeState = { leaves: bigint[]; roots: DepositRootRecord[]; toBlock: bigint };

export function emptyDepositTree(): DepositTreeState {
  return { leaves: [], roots: [], toBlock: -1n };
}

const order = (l: { blockNumber: bigint; logIndex: number }) => l.blockNumber * 1_000_000n + BigInt(l.logIndex);

/** Applies ThresholdVerifier's DepositLeaf / DepositRootUpdated events in (state.toBlock, toBlock]. */
export async function syncDepositTree(
  pub: PublicClient,
  thresholdVerifier: Address,
  state: DepositTreeState = emptyDepositTree(),
  opts: { fromBlock?: bigint; toBlock?: bigint; chunk?: bigint } = {},
): Promise<DepositTreeState> {
  const from = state.toBlock >= 0n ? state.toBlock + 1n : (opts.fromBlock ?? 0n);
  const to = opts.toBlock ?? (await pub.getBlockNumber({ cacheTime: 0 }));
  if (from > to) return state;
  const chunk = opts.chunk ?? 50_000n;
  const [leaves, roots] = await Promise.all([
    logsChunked(pub, { address: thresholdVerifier, event: depositLeafEvent as AbiEvent }, from, to, chunk),
    logsChunked(pub, { address: thresholdVerifier, event: depositRootEvent as AbiEvent }, from, to, chunk),
  ]);
  for (const l of [...leaves].sort((x: any, y: any) => (order(x) < order(y) ? -1 : 1)) as any[]) {
    const idx = Number(l.args.depositIndex);
    if (idx !== state.leaves.length) throw new Error(`deposit leaf ${idx} out of order (have ${state.leaves.length})`);
    state.leaves.push(BigInt(l.args.commitment));
  }
  for (const l of [...roots].sort((x: any, y: any) => (order(x) < order(y) ? -1 : 1)) as any[]) {
    state.roots.push({ root: BigInt(l.args.root), size: Number(l.args.size), block: l.blockNumber });
  }
  state.toBlock = to;
  return state;
}

/** The last deposit-tree root published at or before `block` (null before the contract existed). */
export function depositRootAt(state: DepositTreeState, block: bigint): DepositRootRecord | null {
  let out: DepositRootRecord | null = null;
  for (const r of state.roots) if (r.block <= block) out = r;
  return out;
}

function treeOf(leaves: bigint[]): NoteTree {
  const t = new NoteTree();
  for (const l of leaves) t.insert(l);
  return t;
}

/**
 * Savings proof: deposits to `keys` of `asset` appended to the deposit tree after `from` and up to `to`
 * (records from depositRootAt / state.roots). `notes` are the owner's notes (myNotes): they give each deposit's
 * amount and blinding; a deposit counts when its commitment is one of them.
 */
export async function proveSavingsAtLeast(p: VerifierRequest & {
  keys: VaultKeys;
  deposits: DepositTreeState;
  notes: OwnedNote[];
  asset: Address;
  threshold: bigint;
  from: DepositRootRecord;
  to: DepositRootRecord;
}): Promise<SavingsProof> {
  const asset = getAddress(p.asset);
  const { from, to } = p;
  if (from.size > to.size || to.size > p.deposits.leaves.length) throw new Error("bad window (sync the deposit tree first)");
  const toTree = treeOf(p.deposits.leaves.slice(0, to.size));
  if (toTree.root() !== to.root) throw new Error("deposit tree does not match rootTo");
  const fromTree = treeOf(p.deposits.leaves.slice(0, from.size));
  if (fromTree.root() !== from.root) throw new Error("deposit tree does not match rootFrom");
  fromTree.insert(ZERO_LEAF); // the path of an empty slot does not depend on what is in it
  const fromPath = fromTree.path(from.size);

  const mine = new Map<bigint, OwnedNote>();
  for (const n of p.notes) if (getAddress(n.asset) === asset) mine.set(n.commitment, n);
  const window: { raw: bigint; blinding: bigint; index: number }[] = [];
  for (let i = from.size; i < to.size; i++) {
    const n = mine.get(p.deposits.leaves[i]!);
    if (n) window.push({ raw: n.raw, blinding: n.blinding, index: i });
  }
  const chosen = pick(window, p.threshold, "deposits in the window");
  const slots = chosen.map((d) => ({ is_real: true, amount: f(d.raw), blinding: f(d.blinding), index: f(BigInt(d.index)), path: toTree.path(d.index).map(f) }));
  while (slots.length < MAX_THRESHOLD_NOTES) slots.push(padSlot());
  const { proof } = await proveCircuit(savingsArtifact, {
    root_from: f(from.root),
    root_to: f(to.root),
    asset_id: f(BigInt(asset)),
    threshold: f(p.threshold),
    verifier_nonce: f(verifierNonce(p)),
    secret: f(p.keys.spendingSecret),
    from_index: f(BigInt(from.size)),
    from_path: fromPath.map(f),
    deposits: slots,
  });
  return {
    version: 1,
    kind: "plynth.threshold.savings",
    chainId: Number(p.chainId),
    thresholdVerifier: getAddress(p.thresholdVerifier),
    proof,
    claim: { rootFrom: f(from.root), rootTo: f(to.root), asset, threshold: p.threshold.toString() },
  };
}

// ---------------------------------------------------------------- verification

const isB32 = (x: unknown): x is Hex => typeof x === "string" && isHex(x) && x.length === 66;
const isUint = (x: unknown): x is string => typeof x === "string" && /^[0-9]{1,39}$/.test(x) && BigInt(x) <= MAX_RAW;

/** Shape errors of an untrusted bundle (empty when it is well formed). */
export function checkThresholdShape(b: unknown): string[] {
  const e: string[] = [];
  const x = b as any;
  if (!x || typeof x !== "object") return ["bundle must be an object"];
  if (x.version !== 1) e.push("version must be 1");
  if (x.kind !== "plynth.threshold.holdings" && x.kind !== "plynth.threshold.savings") e.push("unknown kind");
  if (!Number.isInteger(x.chainId)) e.push("chainId must be an integer");
  if (typeof x.thresholdVerifier !== "string" || !isAddress(x.thresholdVerifier, { strict: false })) e.push("thresholdVerifier must be an address");
  if (typeof x.proof !== "string" || !isHex(x.proof) || x.proof.length < 4 || x.proof.length > 2 + 2 * 32_768) e.push("proof must be hex");
  const c = x.claim;
  if (!c || typeof c !== "object") return [...e, "claim must be an object"];
  if (typeof c.asset !== "string" || !isAddress(c.asset, { strict: false })) e.push("claim.asset must be an address");
  if (!isUint(c.threshold)) e.push("claim.threshold must be a decimal string below 2^128");
  if (x.kind === "plynth.threshold.holdings") {
    if (!isB32(c.root)) e.push("claim.root must be bytes32");
    if (!Array.isArray(c.nullifiers) || c.nullifiers.length !== MAX_THRESHOLD_NOTES || !c.nullifiers.every(isB32)) {
      e.push(`claim.nullifiers must be ${MAX_THRESHOLD_NOTES} bytes32`);
    }
  } else if (x.kind === "plynth.threshold.savings") {
    if (!isB32(c.rootFrom) || !isB32(c.rootTo)) e.push("claim.rootFrom and claim.rootTo must be bytes32");
  }
  return e;
}

export type ThresholdVerdict =
  | {
      ok: true;
      kind: ThresholdProof["kind"];
      asset: Address;
      threshold: string;
      /** holdings: notes counted and padding slots; savings: the window */
      holdings?: { root: Hex; poolRootSeq: string; notes: number; padding: number };
      savings?: { fromBlock: string; toBlock: string; fromTime: string; toTime: string; depositsInWindow: number };
    }
  | { ok: false; reason: string; errors?: string[] };

/**
 * The custom error a contract call reverted with. Matched by error name along the cause chain, not instanceof: the
 * caller's PublicClient can come from a different copy of viem than the SDK's own (an app with its own viem).
 */
function revertName(err: unknown): string {
  for (let e = err as { name?: unknown; cause?: unknown; data?: { errorName?: unknown } } | undefined, depth = 0; e && depth < 16; e = e.cause as typeof e, depth++) {
    if (e.name === "ContractFunctionRevertedError" && typeof e.data?.errorName === "string") return e.data.errorName;
  }
  throw err; // RPC trouble is not a verdict
}

/**
 * Stateless check of a threshold proof for the verifier's own request. `expect` pins the deployment
 * (chainId + ThresholdVerifier) the verifier trusts; a bundle naming another is refused before any call.
 */
export async function verifyThresholdProof(
  pub: PublicClient,
  bundle: unknown,
  req: { verifier: Address; requestId: Hex },
  expect: { chainId: number; thresholdVerifier: Address },
): Promise<ThresholdVerdict> {
  const errors = checkThresholdShape(bundle);
  if (!isAddress(req.verifier, { strict: false }) || !isB32(req.requestId)) errors.push("verifier must be an address and requestId bytes32");
  if (errors.length) return { ok: false, reason: "malformed", errors };
  const b = bundle as ThresholdProof;
  if (b.chainId !== expect.chainId || getAddress(b.thresholdVerifier) !== getAddress(expect.thresholdVerifier)) {
    return { ok: false, reason: "WrongDeployment" };
  }
  const address = getAddress(expect.thresholdVerifier);
  const verifier = getAddress(req.verifier);
  const threshold = BigInt(b.claim.threshold);
  try {
    if (b.kind === "plynth.threshold.holdings") {
      const c = b.claim;
      const r = (await pub.readContract({
        address,
        abi: thresholdVerifierAbi,
        functionName: "checkHoldings",
        args: [b.proof, { root: c.root, asset: getAddress(c.asset), threshold, nullifiers: c.nullifiers as any }, verifier, req.requestId],
      })) as { poolRootSeq: bigint; notes: bigint };
      return {
        ok: true,
        kind: b.kind,
        asset: getAddress(c.asset),
        threshold: c.threshold,
        holdings: { root: c.root, poolRootSeq: r.poolRootSeq.toString(), notes: Number(r.notes), padding: MAX_THRESHOLD_NOTES - Number(r.notes) },
      };
    }
    const c = b.claim;
    const [from, to] = (await pub.readContract({
      address,
      abi: thresholdVerifierAbi,
      functionName: "checkSavings",
      args: [b.proof, { rootFrom: c.rootFrom, rootTo: c.rootTo, asset: getAddress(c.asset), threshold }, verifier, req.requestId],
    })) as unknown as [{ size: bigint; blockNumber: bigint; timestamp: bigint }, { size: bigint; blockNumber: bigint; timestamp: bigint }];
    return {
      ok: true,
      kind: b.kind,
      asset: getAddress(c.asset),
      threshold: c.threshold,
      savings: {
        fromBlock: from.blockNumber.toString(),
        toBlock: to.blockNumber.toString(),
        fromTime: new Date(Number(from.timestamp) * 1000).toISOString(),
        toTime: new Date(Number(to.timestamp) * 1000).toISOString(),
        depositsInWindow: Number(to.size - from.size),
      },
    };
  } catch (err) {
    return { ok: false, reason: revertName(err) };
  }
}

export async function verifyHoldings(pub: PublicClient, bundle: unknown, req: { verifier: Address; requestId: Hex }, expect: { chainId: number; thresholdVerifier: Address }) {
  if ((bundle as any)?.kind !== "plynth.threshold.holdings") return { ok: false, reason: "not a holdings proof" } as ThresholdVerdict;
  return verifyThresholdProof(pub, bundle, req, expect);
}

export async function verifySavings(pub: PublicClient, bundle: unknown, req: { verifier: Address; requestId: Hex }, expect: { chainId: number; thresholdVerifier: Address }) {
  if ((bundle as any)?.kind !== "plynth.threshold.savings") return { ok: false, reason: "not a savings proof" } as ThresholdVerdict;
  return verifyThresholdProof(pub, bundle, req, expect);
}

/** The circuit's public inputs for a bundle and request, in circuit order. */
export function thresholdPublicInputs(b: ThresholdProof, req: VerifierRequest): bigint[] {
  const nonce = verifierNonce(req);
  if (b.kind === "plynth.threshold.holdings") {
    return [BigInt(b.claim.root), BigInt(b.claim.asset), BigInt(b.claim.threshold), nonce, ...b.claim.nullifiers.map((n) => BigInt(n))];
  }
  return [BigInt(b.claim.rootFrom), BigInt(b.claim.rootTo), BigInt(b.claim.asset), BigInt(b.claim.threshold), nonce];
}

/**
 * Proof-only check against the shipped verification key: no chain, so no root, spent or window check.
 * For tests and for a client that wants to check its own proof before sending it.
 */
export async function verifyProofOnly(b: ThresholdProof, req: VerifierRequest): Promise<boolean> {
  const program = b.kind === "plynth.threshold.holdings" ? holdingsArtifact : savingsArtifact;
  return verifyCircuitProof(program, b.proof, thresholdPublicInputs(b, req));
}
