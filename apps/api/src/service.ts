// Read models for the dashboard. Chain state (vault, books, valuer) is the source of truth; ev_logs (indexer)
// supplies history. Nothing here writes: the API never touches keeper or indexer tables.
import type { Db } from "@plynth/db";
import type { Address, PublicClient } from "viem";
import { beaconAbi, crowdAbi, erc20Abi, valuerAbi, vaultAbi } from "./abi";
import type { BlockTimes } from "./block-times";
import { stockOf, type ApiDeployment, type ApiStock } from "./deployment";
import { userEvents, type EvRow } from "./events";
import { day, fixed, iso, usd, usdg, usdgToUsd18 } from "./format";

export type Deps = { chainId: number; pub: PublicClient; db: Db; dep: ApiDeployment; blockTimes: BlockTimes };

export const MODES = ["open", "quiet", "hidden"] as const;
export type Mode = (typeof MODES)[number];
const WEEK = 604_800n;
const DAY = 86_400n;
const MAX_U64 = (1n << 64n) - 1n;

/** Chain time (latest block), not wall time: the dashboard must agree with what the contracts see. */
export async function chainNow(d: Pick<Deps, "pub">): Promise<bigint> {
  return (await d.pub.getBlock({ blockTag: "latest" })).timestamp;
}

const decimalsCache = new Map<string, number>();
async function decimalsOf(d: Deps, token: Address): Promise<number> {
  const k = `${d.chainId}:${token.toLowerCase()}`;
  let v = decimalsCache.get(k);
  if (v === undefined) {
    v = Number(await d.pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    decimalsCache.set(k, v);
  }
  return v;
}

const bookKey = (asset: string, bookId: string | bigint) => `${asset.toLowerCase()}:${bookId.toString()}`;

/** The user's crowd orders, from Joined/Cancelled/Claimed/Delivered logs. */
async function crowdPositions(d: Deps, user: Address) {
  const ev = await userEvents(d.db, { chainId: d.chainId, addresses: [d.dep.crowd], events: ["Joined", "Cancelled", "Claimed", "Delivered"], user });
  const pos = new Map<string, { asset: Address; bookId: bigint; joinedUsdg: bigint; cancelled: boolean; settled: boolean }>();
  for (const e of ev) {
    const k = bookKey(e.args.asset!, e.args.bookId!);
    const p = pos.get(k) ?? { asset: e.args.asset as Address, bookId: BigInt(e.args.bookId!), joinedUsdg: 0n, cancelled: false, settled: false };
    if (e.eventName === "Joined") {
      if (p.cancelled) {
        p.cancelled = false; // a cancel zeroes the whole order; a later join starts a new one
        p.joinedUsdg = 0n;
      }
      p.joinedUsdg += BigInt(e.args.usdg!);
    } else if (e.eventName === "Cancelled") p.cancelled = true;
    else p.settled = true;
    pos.set(k, p);
  }
  return pos;
}

type Book = { usdgTotal: bigint; accounts: number; openedAt: bigint; rawOut: bigint; executed: boolean };
async function books(d: Deps, keys: { asset: Address; bookId: bigint }[]): Promise<Map<string, Book>> {
  const out = new Map<string, Book>();
  const res = await Promise.all(keys.map((k) => d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "book", args: [k.asset, k.bookId] })));
  keys.forEach((k, i) => out.set(bookKey(k.asset, k.bookId), res[i] as Book));
  return out;
}

export async function overview(d: Deps, user: Address) {
  const [acct, settings, now, pos] = await Promise.all([
    d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "accountOf", args: [user] }),
    d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "settingsOf", args: [user] }),
    chainNow(d),
    crowdPositions(d, user),
  ]);
  const live = [...pos.values()].filter((p) => !p.cancelled && !p.settled);
  const bk = await books(d, live);

  // Unexecuted orders are still USDG (queued); executed, unclaimed ones are already the user's Stock Tokens.
  let queued = 0n;
  const claimable = new Map<string, bigint>();
  await Promise.all(
    live.map(async (p) => {
      const b = bk.get(bookKey(p.asset, p.bookId))!;
      if (!b.executed) {
        queued += p.joinedUsdg;
        return;
      }
      const raw = await d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "allocationOf", args: [p.asset, p.bookId, user] });
      claimable.set(p.asset.toLowerCase(), (claimable.get(p.asset.toLowerCase()) ?? 0n) + raw);
    }),
  );

  const holdings = (
    await Promise.all(
      d.dep.stocks.map(async (s) => {
        const walletRaw = await d.pub.readContract({ address: s.token, abi: erc20Abi, functionName: "balanceOf", args: [user] });
        const claimRaw = claimable.get(s.token.toLowerCase()) ?? 0n;
        const raw = walletRaw + claimRaw;
        if (raw === 0n) return null;
        return { ...(await value(d, s, raw)), walletRaw: walletRaw.toString(), claimableRaw: claimRaw.toString() };
      }),
    )
  ).filter((h): h is NonNullable<typeof h> => h !== null);

  const stock18 = holdings.reduce((a, h) => a + h.usd18, 0n);
  const park18 = 0n; // Private park (Hidden) is not built yet.
  const available = acct.available + acct.pending + queued;
  const total18 = stock18 + park18 + usdgToUsd18(available);
  const week = now / WEEK;
  return {
    totalHoldingsUsd: usd(total18),
    allocation: {
      stockTokensUsd: usd(stock18),
      parkUsd: usd(park18),
      availableUsdg: usdg(available),
      // Breakdown of availableUsdg: in the vault (available + pending sweep) and queued in open Crowd Buy books.
      vaultUsdg: usdg(acct.available + acct.pending),
      queuedUsdg: usdg(queued),
    },
    weekRoundups: usdg(acct.week === week ? acct.accruedThisWeek : 0n),
    weeklyCap: usdg(settings.weeklyCap),
    mode: MODES[settings.mode] ?? "open",
    holdings: holdings.map(({ usd18, ...h }) => h),
  };
}

/** Valuer math on-chain: raw x multiplier x price (the Valuer applies the multiplier exactly once). */
async function value(d: Deps, s: ApiStock, raw: bigint) {
  const base = { token: s.token, symbol: s.symbol, raw: raw.toString() };
  try {
    const [q, v] = await Promise.all([
      d.pub.readContract({ address: d.dep.valuer, abi: valuerAbi, functionName: "quote", args: [s.token] }),
      d.pub.readContract({ address: d.dep.valuer, abi: valuerAbi, functionName: "value", args: [s.token, raw] }),
    ]);
    return { ...base, multiplier: fixed(q.multiplier, 18), usd: usd(v[0]), hold: v[1], usd18: v[0] };
  } catch {
    // Delisted or a broken feed: no price we can stand behind. Show it, value it at 0, flag hold.
    return { ...base, multiplier: null as string | null, usd: usd(0n), hold: true, usd18: 0n };
  }
}

export const RANGES = { "1W": 7, "1M": 30, "3M": 90, ALL: null } as const;
export type Range = keyof typeof RANGES;

/**
 * Daily series (UTC days) of cumulative saved USDG: deposits + round-ups + fixed top-ups - withdrawals.
 * USDG moved into Crowd Buy books is still saved (it became Stock Tokens), so sweeps do not reduce it.
 */
export async function habit(d: Deps, user: Address, range: Range) {
  const [ev, now] = await Promise.all([
    userEvents(d.db, { chainId: d.chainId, addresses: [d.dep.vault], events: ["Deposited", "Withdrawn", "Accrued", "TopUpPulled"], user }),
    chainNow(d),
  ]);
  const times = await d.blockTimes.get(ev.map((e) => e.blockNumber));
  const delta = (e: EvRow) =>
    e.eventName === "Withdrawn" ? -BigInt(e.args.amount!) : e.eventName === "Accrued" ? BigInt(e.args.added!) : BigInt(e.args.amount!);
  const today = now / DAY;
  const days = RANGES[range];
  const firstDay = ev.length ? times.get(ev[0]!.blockNumber)! / DAY : today;
  const start = days === null ? (firstDay < today ? firstDay : today) : today - BigInt(days - 1);

  const points: { date: string; savedUsdg: string }[] = [];
  let cum = 0n;
  let i = 0;
  for (let dd = start; dd <= today; dd++) {
    while (i < ev.length && times.get(ev[i]!.blockNumber)! / DAY <= dd) cum += delta(ev[i++]!);
    points.push({ date: day(dd * DAY), savedUsdg: usdg(cum) });
  }
  return { range, unit: "USDG", points };
}

export type ActivityKind = "roundup" | "topup" | "crowd_allocation" | "delivery" | "statement";
export type ActivityRow = {
  id: string;
  kind: ActivityKind;
  label: string;
  at: string;
  amount: string;
  unit: string;
  status: "Saved" | "Added" | "Queued" | "Ready" | "Delivered" | "Cancelled";
  /** Extra context for the row (the Stock Token symbol for crowd rows), null otherwise. */
  detail: string | null;
  txHash: string;
};

/** Cursor = "<block>-<logIndex>" of the last row of the previous page (rows are newest first). */
export function parseCursor(c: string | undefined) {
  if (!c) return undefined;
  const m = /^(\d{1,20})-(\d{1,9})$/.exec(c);
  if (!m) throw new Error("bad cursor");
  return { block: BigInt(m[1]!), logIndex: Number(m[2]) };
}

export async function activity(d: Deps, user: Address, cursor: string | undefined, limit: number) {
  const before = parseCursor(cursor);
  const page = await userEvents(d.db, {
    chainId: d.chainId,
    addresses: [d.dep.vault, d.dep.crowd],
    events: ["Accrued", "TopUpPulled", "Joined", "Claimed", "Delivered"],
    user,
    before,
    desc: true,
    limit: limit + 1,
  });
  const more = page.length > limit;
  const rows = page.slice(0, limit);
  const vault = d.dep.vault.toLowerCase();

  const joined = rows.filter((r) => r.eventName === "Joined");
  const pos = joined.length ? await crowdPositions(d, user) : new Map();
  const bk = await books(d, [...new Map(joined.map((r) => [bookKey(r.args.asset!, r.args.bookId!), { asset: r.args.asset as Address, bookId: BigInt(r.args.bookId!) }])).values()]);
  const times = await d.blockTimes.get(rows.map((r) => r.blockNumber));

  const out: ActivityRow[] = [];
  for (const r of rows) {
    const base = { id: `${r.txHash}:${r.logIndex}`, at: iso(times.get(r.blockNumber)!), detail: null as string | null, txHash: r.txHash };
    if (r.address === vault && r.eventName === "Accrued") {
      if (BigInt(r.args.added!) === 0n) continue; // an exact multiple rounds up by nothing
      out.push({ ...base, kind: "roundup", label: "Round-up", amount: usdg(BigInt(r.args.added!)), unit: "USDG", status: "Saved" });
    } else if (r.address === vault && r.eventName === "TopUpPulled") {
      out.push({ ...base, kind: "topup", label: "Fixed top-up", amount: usdg(BigInt(r.args.amount!)), unit: "USDG", status: "Added" });
    } else if (r.eventName === "Joined") {
      const k = bookKey(r.args.asset!, r.args.bookId!);
      const p = pos.get(k);
      const b = bk.get(k)!;
      const status = p?.cancelled ? "Cancelled" : !b.executed ? "Queued" : p?.settled ? "Delivered" : "Ready";
      const sym = stockOf(d.dep, r.args.asset!)?.symbol ?? r.args.asset!;
      out.push({ ...base, detail: sym, kind: "crowd_allocation", label: "Crowd Buy allocation", amount: usdg(BigInt(r.args.usdg!)), unit: "USDG", status });
    } else {
      const s = stockOf(d.dep, r.args.asset!);
      const dec = s ? await decimalsOf(d, s.token) : 18;
      out.push({
        ...base,
        detail: s?.symbol ?? null,
        kind: "delivery",
        label: r.eventName === "Claimed" ? "Open delivery" : "Delivery",
        amount: fixed(BigInt(r.args.raw!), dec, dec),
        unit: s?.symbol ?? r.args.asset!,
        status: "Delivered",
      });
    }
  }
  const last = rows.at(-1);
  return { rows: out, nextCursor: more && last ? `${last.blockNumber}-${last.logIndex}` : null };
}

export async function settings(d: Deps, user: Address) {
  const [s, mix] = await Promise.all([
    d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "settingsOf", args: [user] }),
    d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "mixOf", args: [user] }),
  ]);
  return {
    configured: s.roundTo !== 0,
    roundTo: s.roundTo,
    multiplier: s.multiplier,
    weeklyCap: usdg(s.weeklyCap),
    fixedTopUp: usdg(s.fixedTopUp),
    mode: MODES[s.mode] ?? "open",
    mix: mix.map((m) => ({ token: m.stockToken, symbol: stockOf(d.dep, m.stockToken)?.symbol ?? null, weightBps: m.weightBps })),
  };
}

export async function crowdBooks(d: Deps, assets: ApiStock[]) {
  const [now, minCrowd] = await Promise.all([chainNow(d), d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "MIN_CROWD" })]);
  let window: { start: bigint; end: bigint } | null = null;
  try {
    const [start, end] = await d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "windowOf", args: [now] });
    window = { start, end };
  } catch {
    window = null; // before GENESIS
  }
  const result = await Promise.all(
    assets.map(async (s) => {
      const [[bookId, b], lastWin, executedEv] = await Promise.all([
        d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "openBook", args: [s.token] }),
        d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "lastExecutedWindow", args: [s.token] }),
        userEvents(d.db, { chainId: d.chainId, addresses: [d.dep.crowd], events: ["Executed"], asset: s.token, desc: true, limit: 10 }),
      ]);
      let executeAfter: string | null = null;
      if (window) {
        const key = await d.pub.readContract({ address: d.dep.crowd, abi: crowdAbi, functionName: "beaconKey", args: [s.token, window.start] });
        const bc = await d.pub.readContract({ address: d.dep.beacon, abi: beaconAbi, functionName: "beacon", args: [key] });
        if (bc.executeAt !== 0n && bc.executeAt !== MAX_U64) executeAfter = iso(bc.executeAt); // only once revealed
      }
      const times = await d.blockTimes.get(executedEv.map((e) => e.blockNumber));
      return {
        asset: s.token,
        symbol: s.symbol,
        open: {
          bookId: bookId.toString(),
          accounts: b.accounts,
          minCrowd,
          usdgTotal: usdg(b.usdgTotal),
          openedAt: b.openedAt ? iso(b.openedAt) : null,
          executedThisWindow: window !== null && lastWin === window.start + 1n,
          executeAfter,
        },
        executed: executedEv.map((e) => ({
          bookId: e.args.bookId!,
          accounts: Number(e.args.accounts),
          usdgTotal: usdg(BigInt(e.args.usdgTotal!)),
          rawOut: e.args.rawOut!,
          at: iso(times.get(e.blockNumber)!),
          txHash: e.txHash,
        })),
      };
    }),
  );
  return {
    now: iso(now),
    window: window ? { start: iso(window.start), end: iso(window.end), next: iso(window.end) } : null,
    books: result,
  };
}
