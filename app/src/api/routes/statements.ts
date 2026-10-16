// Viewing-key statements. The server never sees a viewing key: statements.list says which monthly statements
// exist for an address (block ranges the client feeds to the SDK's statement()), and statements.verify
// checks a scoped-disclosure bundle against the chain. Both read public chain data only and keep no state.
import { logsChunked, monthlyPeriods, rootUpdatedEvent, verifyDisclosure, type DisclosureLookup, type DisclosureVerdict } from "@plynth/sdk/statements";
import { nullifierSpentEvent } from "@plynth/sdk/vault";
import type { AbiEvent, Address, Hex, PublicClient } from "viem";
import { vaultAbi } from "@/abi/api";
import { iso } from "@/api/format";
import type { Deps } from "@/api/service";

export const STATEMENT_TITLE = "Viewing-key statement";
const ZERO = `0x${"0".repeat(64)}`;

export class StatementsUnavailable extends Error {}

function poolOf(d: Deps): Address {
  if (!d.dep.shieldedPool) throw new StatementsUnavailable("no Hidden Vault on this deployment");
  return d.dep.shieldedPool;
}

/** Monthly statements (newest first) from the month the address registered Hidden keys. */
export async function listStatements(d: Deps, user: Address, max = 24) {
  const pool = poolOf(d);
  const keys = await d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "hiddenKeysOf", args: [user] });
  const base = { address: user, chainId: d.chainId, pool, deployBlock: d.dep.deployBlock.toString() };
  if (keys.ownerPk === ZERO) return { ...base, hidden: false, ownerPk: null, statements: [] };
  const head = await d.pub.getBlockNumber({ cacheTime: 0 });
  const event = vaultAbi.find((x) => x.type === "event" && x.name === "HiddenKeysSet") as AbiEvent;
  const logs = await d.pub.getLogs({ address: d.dep.vault, event, args: { user }, fromBlock: d.dep.deployBlock, toBlock: head } as any);
  const since = logs.length ? logs[0]!.blockNumber! : d.dep.deployBlock;
  const months = await monthlyPeriods(d.pub, { sinceBlock: since, headBlock: head, max });
  return {
    ...base,
    hidden: true,
    ownerPk: keys.ownerPk,
    statements: months.map((m) => ({
      id: m.id,
      title: STATEMENT_TITLE,
      status: m.complete ? "Ready" : "In progress",
      // Dashboard activity row text, e.g. "Viewing-key statement · Ready".
      label: `${STATEMENT_TITLE} · ${m.complete ? "Ready" : "In progress"}`,
      period: { start: iso(m.start), end: iso(m.end), fromBlock: m.fromBlock.toString(), toBlock: m.toBlock.toString() },
    })),
  };
}

/** Notes one POST /v1/statements/verify may disclose (the SDK allows 256 offline; audit L-15). */
export const API_MAX_DISCLOSED_NOTES = 32;
const SCAN_CHUNK = 50_000n;

/**
 * The pool's RootUpdated and NullifierSpent history, scanned once from the deploy block and then only for new blocks
 * (audit L-15). Before, one unauthenticated verify request turned into a full-history getLogs scan per disclosed
 * note: thousands of RPC calls. Now a request costs at most the blocks since the previous one, and concurrent
 * requests share one scan. Kept in memory per (chain, pool); the API restarts with a fresh backfill.
 */
export class PoolEventCache {
  private scannedTo: bigint;
  private readonly roots: { block: bigint; root: bigint }[] = [];
  private readonly spent = new Map<string, bigint>();
  private syncing: Promise<void> | undefined;
  /** getLogs calls made so far (for tests and logs). */
  calls = 0;

  constructor(
    private readonly pub: PublicClient,
    private readonly pool: Address,
    private readonly deployBlock: bigint,
  ) {
    this.scannedTo = deployBlock - 1n;
  }

  /** Scans (scannedTo, head]; one scan at a time, later callers wait for it. */
  async sync(head: bigint): Promise<void> {
    while (this.scannedTo < head) {
      if (!this.syncing) {
        const from = this.scannedTo + 1n;
        this.syncing = (async () => {
          const counted = { ...this.pub, getLogs: (q: any) => (this.calls++, this.pub.getLogs(q)) } as PublicClient;
          const [roots, spent] = await Promise.all([
            logsChunked(counted, { address: this.pool, event: rootUpdatedEvent as AbiEvent }, from, head, SCAN_CHUNK),
            logsChunked(counted, { address: this.pool, event: nullifierSpentEvent as AbiEvent }, from, head, SCAN_CHUNK),
          ]);
          for (const l of roots) this.roots.push({ block: l.blockNumber, root: BigInt(l.args.root as Hex) });
          for (const l of spent) {
            const k = String(l.args.nullifier).toLowerCase();
            if (!this.spent.has(k)) this.spent.set(k, l.blockNumber);
          }
          this.scannedTo = head;
        })().finally(() => (this.syncing = undefined));
      }
      await this.syncing;
    }
  }

  lookup(head: bigint): DisclosureLookup {
    return {
      rootAt: async (toBlock) => {
        await this.sync(head);
        let last: { block: bigint; root: bigint } | null = null;
        for (const r of this.roots) {
          if (r.block > toBlock) break;
          last = r;
        }
        return last;
      },
      spentBlocks: async (nullifiers, h) => {
        await this.sync(h);
        const out = new Map<string, bigint>();
        for (const n of nullifiers) {
          const b = this.spent.get(n.toLowerCase());
          if (b !== undefined && b <= h) out.set(n.toLowerCase(), b);
        }
        return out;
      },
    };
  }
}

// Per RPC client (one per API process; tests that start several chains get one each), then per pool.
const caches = new WeakMap<PublicClient, Map<string, PoolEventCache>>();
function cacheFor(d: Deps, pool: Address): PoolEventCache {
  let m = caches.get(d.pub);
  if (!m) caches.set(d.pub, (m = new Map()));
  const k = `${d.chainId}:${pool.toLowerCase()}:${d.dep.deployBlock}`;
  let c = m.get(k);
  if (!c) m.set(k, (c = new PoolEventCache(d.pub, pool, d.dep.deployBlock)));
  return c;
}

/** Checks a disclosure bundle against this deployment's pool: at most API_MAX_DISCLOSED_NOTES notes, cached history. */
export async function verifyStatementBundle(d: Deps, bundle: unknown, cache?: PoolEventCache): Promise<DisclosureVerdict> {
  const pool = poolOf(d);
  const head = await d.pub.getBlockNumber({ cacheTime: 0 });
  const c = cache ?? cacheFor(d, pool);
  return verifyDisclosure(d.pub, bundle, { pool, deployBlock: d.dep.deployBlock, maxNotes: API_MAX_DISCLOSED_NOTES, lookup: c.lookup(head) });
}
