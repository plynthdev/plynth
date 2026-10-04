// The reconciler (spec §3): every hour, for every venue, three sources must agree:
//   1. the venue's own statement (its API, or the chain for the in-house venue),
//   2. the on-chain PositionMirror snapshot the PolicyGuard trusts (off-chain venues),
//   3. the internal ledger of desk fills (venue_fills).
// Any disagreement is a break: one `exceptions` row (open until a human explains it) and a `reconcile.break`
// webhook the first hour it appears. PeriodClose refuses to commit while an unexplained break is open.
import { getAddress, type Address, type PublicClient } from "viem";
import { positionMirrorAbi } from "../risk/abi";
import type { Webhooks } from "../risk/webhooks";
import type { PerpVenueClient, VenueStatement } from "../venues/types";
import type { Break, BreakKind, ExceptionStore, FillLedger } from "./store";

export type VenueSource = {
  /** Ledger key for the venue: the name desks record fills under (client.name). */
  client: PerpVenueClient;
  /** "mirrored": an off-chain venue whose numbers reach the chain through PositionMirror at `adapter`;
   *  "onchain": the statement already is the chain (in-house venue). */
  mode: "mirrored" | "onchain";
  adapter?: Address;
};

export type ReconcileConfig = {
  chainId: number;
  account: Address;
  mirror?: Address;
  venues: VenueSource[];
  /** Allowed |statement - mirror| equity gap, bps of the statement (default 100: the mirror lags by <= 1 push). */
  equityTolBps?: number;
  /** Allowed position gap in token base units (default 1e10: venue share rounding through the multiplier). */
  tokenTol?: bigint;
  /** Kinds that close themselves when the sources agree again (default: stale mirror, venue errors). */
  autoResolve?: BreakKind[];
};

export type ReconcileResult = { breaks: Break[]; newBreaks: Break[]; resolved: number[] };

const lc = (s: string) => s.toLowerCase();
const abs = (x: bigint) => (x < 0n ? -x : x);

export class Reconciler {
  constructor(
    readonly pub: PublicClient | null,
    readonly cfg: ReconcileConfig,
    readonly deps: { store: ExceptionStore; ledger: FillLedger; webhooks?: Webhooks; log?: (m: string, extra?: unknown) => void },
  ) {}

  private brk(kind: BreakKind, venue: string, underlying: Address | null, detail: Record<string, unknown>): Break {
    return { kind, key: `${kind}:${lc(venue)}:${underlying ? lc(underlying) : "-"}`, venue, underlying, detail };
  }

  /** Breaks for one venue (pure apart from the reads). */
  async checkVenue(src: VenueSource): Promise<Break[]> {
    const name = src.client.name;
    const out: Break[] = [];
    let st: VenueStatement;
    try {
      st = await src.client.statement();
    } catch (e) {
      return [this.brk("reconcile.venue_error", name, null, { error: e instanceof Error ? e.message : String(e) })];
    }
    for (const sym of st.unmapped ?? []) out.push(this.brk("reconcile.position", name, null, { unmappedMarket: sym }));

    const venuePos = new Map(st.positions.map((p) => [lc(p.underlying), p.tokens]));
    const ledger = await this.deps.ledger.positions(this.cfg.chainId, this.cfg.account, name);
    let mirrorPos: Map<string, bigint> | null = null;

    if (src.mode === "mirrored") {
      if (!this.pub || !this.cfg.mirror || !src.adapter) throw new Error(`${name}: a mirrored venue needs pub, mirror and adapter`);
      const [positions, equityUsd, , ts] = await this.pub.readContract({ address: this.cfg.mirror, abi: positionMirrorAbi, functionName: "latest", args: [src.adapter] });
      const stale = await this.pub.readContract({ address: this.cfg.mirror, abi: positionMirrorAbi, functionName: "isStale", args: [src.adapter] });
      if (stale) out.push(this.brk("reconcile.stale_mirror", name, null, { mirrorTs: ts }));
      mirrorPos = new Map(positions.map((p) => [lc(p.underlying), p.tokens]));
      const gap = abs(equityUsd - st.equityUsd);
      if (gap * 10_000n > st.equityUsd * BigInt(this.cfg.equityTolBps ?? 100)) {
        out.push(this.brk("reconcile.equity", name, null, { statementUsd: st.equityUsd, mirrorUsd: equityUsd, gapUsd: gap }));
      }
    }

    const tol = this.cfg.tokenTol ?? 10n ** 10n;
    const keys = new Set([...venuePos.keys(), ...ledger.keys(), ...(mirrorPos?.keys() ?? [])]);
    for (const k of [...keys].sort()) {
      const v = venuePos.get(k) ?? 0n;
      const l = ledger.get(k) ?? 0n;
      const m = mirrorPos ? (mirrorPos.get(k) ?? 0n) : null;
      const bad = abs(v - l) > tol || (m !== null && abs(v - m) > tol);
      if (bad) {
        const detail: Record<string, unknown> = { statement: v, ledger: l };
        if (m !== null) detail.mirror = m;
        out.push(this.brk("reconcile.position", name, getAddress(k), detail));
      }
    }
    return out;
  }

  async run(): Promise<ReconcileResult> {
    const { store } = this.deps;
    const breaks: Break[] = [];
    for (const v of this.cfg.venues) breaks.push(...(await this.checkVenue(v)));

    const newBreaks: Break[] = [];
    for (const b of breaks) {
      const { isNew } = await store.upsertOpen(this.cfg.chainId, this.cfg.account, b);
      if (!isNew) continue;
      newBreaks.push(b);
      this.deps.log?.("reconcile.break", b);
      await this.deps.webhooks?.emit({ type: "reconcile.break", data: { account: this.cfg.account, chainId: this.cfg.chainId, ...b } });
    }

    const auto = new Set(this.cfg.autoResolve ?? ["reconcile.stale_mirror", "reconcile.venue_error"]);
    const now = new Set(breaks.map((b) => b.key));
    const resolved: number[] = [];
    for (const r of await store.open(this.cfg.chainId, this.cfg.account)) {
      if (!now.has(r.key) && auto.has(r.kind)) {
        await store.resolve(r.id);
        resolved.push(r.id);
      }
    }
    return { breaks, newBreaks, resolved };
  }
}

/** The PeriodClose gate: how many breaks of the account are still open (unexplained). */
export function breakGate(store: ExceptionStore, chainId: number, account: Address) {
  return { count: async () => (await store.open(chainId, account)).length };
}
