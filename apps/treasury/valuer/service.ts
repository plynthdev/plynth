// The valuer service (todo 30, spec §3): every 60 s, one NAV mark per treasury into `nav_marks`. Each mark is
// read from one pinned block (PolicyGuard.snapshot, the same figure the guard and PeriodClose use): NAV, the
// cash / equity / basis band weights, the per-asset weights and whether a held Stock Token's feed is on hold.
// `nav.history` in the API reads these rows. The service holds no key and writes only nav_marks.
import { navMarks, type Db } from "@plynth/db";
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { accountAbi, guardAbi } from "../desks/abi";

const BPS = 10_000n;
const factoryAbi = parseAbi(["function treasuryCount() view returns (uint256)", "function treasuryAt(uint256 index) view returns (address)"]);

export type Mark = typeof navMarks.$inferInsert;

const bps = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * BPS) / whole));

/** Reads one mark for `account` at the latest block (does not write). */
export async function readMark(pub: PublicClient, chainId: number, account: Address, now: Date = new Date()): Promise<Mark> {
  const block = await pub.getBlock({ blockTag: "latest" });
  const blockNumber = block.number!;
  const guard = await pub.readContract({ address: account, abi: accountAbi, functionName: "guard", blockNumber });
  const snap = await pub.readContract({ address: guard, abi: guardAbi, functionName: "snapshot", args: [account], blockNumber });
  return {
    chainId,
    account: account.toLowerCase(),
    ts: now,
    blockNumber,
    blockTime: new Date(Number(block.timestamp) * 1000),
    navUsd: snap.nav.toString(),
    cashBps: bps(snap.cashUsd, snap.nav),
    equityBps: bps(snap.equityUsd, snap.nav),
    basisBps: bps(snap.basisUsd, snap.nav),
    hold: snap.equityHold,
    weights: snap.assets.map((a, i) => ({ asset: a.toLowerCase(), usd: snap.usd[i]!.toString(), bps: bps(snap.usd[i]!, snap.nav) })),
  };
}

/** One pass: a mark per account. A treasury that fails to read is skipped (and reported), never blocks others. */
export async function markOnce(ctx: { pub: PublicClient; db: Db; chainId: number; accounts: Address[]; now?: () => Date; say?: (m: string) => void }) {
  const marks: Mark[] = [];
  const errors: { account: Address; error: string }[] = [];
  for (const account of ctx.accounts) {
    try {
      marks.push(await readMark(ctx.pub, ctx.chainId, account, ctx.now?.() ?? new Date()));
    } catch (e) {
      const error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      errors.push({ account, error });
      ctx.say?.(`${account}: ${error}`);
    }
  }
  if (marks.length) await ctx.db.insert(navMarks).values(marks);
  return { marks, errors };
}

/** Every treasury TreasuryFactory has created (no log scan: the factory keeps the list). */
export async function factoryTreasuries(pub: PublicClient, factory: Address): Promise<Address[]> {
  const n = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "treasuryCount" });
  const out: Address[] = [];
  for (let i = 0n; i < n; i++) out.push(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "treasuryAt", args: [i] }));
  return out;
}

/** TREASURY_ACCOUNTS (comma-separated) plus, if TREASURY_FACTORY is set, every treasury the factory made. */
export async function treasuriesFromEnv(pub: PublicClient, env: Record<string, string | undefined> = process.env): Promise<Address[]> {
  const set = new Map<string, Address>();
  for (const a of (env.TREASURY_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) set.set(a.toLowerCase(), getAddress(a));
  if (env.TREASURY_FACTORY) for (const a of await factoryTreasuries(pub, getAddress(env.TREASURY_FACTORY))) set.set(a.toLowerCase(), a);
  if (!set.size) throw new Error("set TREASURY_ACCOUNTS or TREASURY_FACTORY");
  return [...set.values()];
}
