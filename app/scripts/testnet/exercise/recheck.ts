// `exercise.ts --recheck`: re-verifies, read-only, the failed steps whose transaction went through but whose
// first check read a lagging node of the load-balanced public RPC (2026-10-07: a Deposited log and a perp
// position "missing" right after their receipts), or whose expectation depended on where in the window it ran.
// A step passes on re-check only if its own evidence (the receipt's logs, or a simulation) proves the assertion;
// the report keeps the original failure text next to the re-check. Nothing is sent.
import { decodeEventLog, getAddress, type Hex } from "viem";
import { abiOf, revertReason, errorAbi, type Step } from "../../fork/exercise/core";
import { timers, type TCtx } from "./ctx";

type Recheck = (x: TCtx, s: Step) => Promise<string>;

async function logsOf(x: TCtx, tx: Hex, contract: string, address: string) {
  const rc = await x.r.pub.getTransactionReceipt({ hash: tx });
  if (rc.status !== "success") throw new Error(`transaction ${tx} reverted`);
  const out: { eventName: string; args: Record<string, unknown> }[] = [];
  for (const l of rc.logs) {
    if (getAddress(l.address) !== getAddress(address)) continue;
    try {
      out.push(decodeEventLog({ abi: abiOf(contract), data: l.data, topics: l.topics as never }) as never);
    } catch {}
  }
  return out;
}

/** A step that failed before any transaction was sent (an RPC error) passes when its retry passed later. */
const retried = (x: TCtx, s: Step): string => {
  const r = x.st.steps.find((o) => o !== s && o.status === "pass" && o.step === `${s.step} (retry)` && o.tx);
  if (s.tx || !r) throw new Error(s.tx ? "the first attempt sent a transaction" : "no passing retry yet");
  return `no transaction was sent (RPC error on the gas estimate); the retry passed: ${r.tx}`;
};

export const RECHECKS: [prefix: string, fn: Recheck][] = [
  [
    "open claims the ",
    async (x, s) => {
      const sym = s.step.replace("open claims the ", "").replace(" allocation", "");
      const token = x.token(sym);
      const books = (x.data.books ?? {}) as Record<string, string>;
      const id = BigInt(books[token] ?? books[token.toLowerCase()] ?? Object.entries(books).find(([k]) => getAddress(k) === token)?.[1] ?? "0");
      const ev = (await logsOf(x, s.tx!, "CrowdBuy", x.addr("crowdBuy"))).find((e) => e.eventName === "Claimed");
      const alloc = await x.r.read<bigint>(x.addr("crowdBuy"), x.abi("CrowdBuy"), "allocationOf", [token, id, x.A.open.address]);
      if (!ev || getAddress(ev.args.user as string) !== x.A.open.address || BigInt(ev.args.raw as bigint) !== alloc || alloc === 0n) throw new Error("no Claimed(open, allocationOf) in the receipt");
      return `receipt has Claimed(open, ${alloc} raw ${sym}) = allocationOf(book ${id})`;
    },
  ],
  ["hidden deposits 100 mUSDG into the Hidden Vault (queued as pending)", async (x, s) => retried(x, s)],
  [
    "quiet: depositWithPermit2",
    async (x, s) => {
      const ev = (await logsOf(x, s.tx!, "SavingsVault", x.addr("savingsVault"))).find((e) => e.eventName === "Deposited");
      if (!ev || ev.args.viaPermit2 !== true || getAddress(ev.args.user as string) !== x.A.quiet.address) throw new Error("no Deposited(quiet, viaPermit2 = true) in the receipt");
      return `receipt has Deposited(quiet, ${Number(ev.args.amount) / 1e6} mUSDG, viaPermit2 = true)`;
    },
  ],
  [
    "trader opens a 1,000 mUSDG long mTSLA",
    async (x, s) => {
      const ev = (await logsOf(x, s.tx!, "PerpMarket", x.dep.perpMarkets.mTSLA!)).find((e) => e.eventName === "Opened");
      if (!ev || ev.args.isLong !== true || BigInt(ev.args.sizeUsd as bigint) !== 1_000n * 1_000_000n) throw new Error("no Opened(long, 1,000) in the receipt");
      return `receipt has Opened(open saver, long, size 1,000 mUSDG, collateral ${Number(ev.args.collateral) / 1e6})`;
    },
  ],
  [
    "a saver cannot execute a book",
    async (x) => {
      // Inside the keeper-only part of the current window (simulated at windowStart + 60 s), a saver is refused.
      const crowd = x.addr("crowdBuy");
      const C = x.abi("CrowdBuy");
      const now = BigInt(Number(await x.r.now()));
      const [start, end] = await x.r.read<[bigint, bigint]>(crowd, C, "windowOf", [now]);
      const at = start + 60n;
      if (at >= end - BigInt((await timers(x)).grace)) throw new Error("window too short to test");
      let got = "did not revert";
      try {
        await x.r.pub.simulateContract({ account: x.A.open.address, address: crowd, abi: [...C, ...errorAbi()], functionName: "execute", args: [x.token("mTSLA")], blockOverrides: { time: at } } as never);
      } catch (e) {
        got = revertReason(e);
      }
      if (got.split("(")[0] !== "NotKeeper") throw new Error(`got ${got}`);
      return "simulated at windowStart + 60 s: reverts NotKeeper (the first run fell in the window's last GRACE, where anyone may call and TooEarly applies)";
    },
  ],
];

export async function recheck(x: TCtx, log: (m: string) => void): Promise<number> {
  let fixed = 0;
  for (const s of x.st.steps) {
    if (s.status !== "fail") continue;
    const rc = RECHECKS.find(([p]) => s.step.startsWith(p));
    if (!rc) continue;
    try {
      const why = await rc[1](x, s);
      s.detail = `re-checked ${new Date().toISOString()}: ${why}; first check: ${s.detail ?? ""}`;
      s.status = "pass";
      fixed++;
      log(`re-check passed: ${s.step}`);
    } catch (e) {
      log(`re-check failed: ${s.step}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return fixed;
}
