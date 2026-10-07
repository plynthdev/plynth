// The step recorder behind exercise.ts: every transaction is simulated first (so a revert has a decoded reason),
// sent, waited for, and its on-chain effect asserted; every expected revert is checked by name. Each step is
// recorded as {area, step, actor, tx hash, gas, status, assertion} for the report.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import type { LocalAccount } from "viem";
import { estimateGasAhead, withGasHeadroom } from "@/lib/gas";
import { clients, ROOT } from "../lib";
import type { KnownBug } from "./known-bugs";

// ---------------------------------------------------------------- artifacts

const OUT = join(ROOT, "contracts", "out");
type AbiError = Extract<Abi[number], { type: "error" }>;
const abis = new Map<string, Abi>();
let allErrors: AbiError[] | undefined;

/** ABI of a compiled contract by name (contracts/out/<Name>.sol/<Name>.json first, then any file that has it). */
export function abiOf(name: string): Abi {
  const hit = abis.get(name);
  if (hit) return hit;
  let file = join(OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) {
    const dir = readdirSync(OUT).find((d) => existsSync(join(OUT, d, `${name}.json`)));
    if (!dir) throw new Error(`no artifact for ${name} (forge build first)`);
    file = join(OUT, dir, `${name}.json`);
  }
  const abi = JSON.parse(readFileSync(file, "utf8")).abi as Abi;
  abis.set(name, abi);
  return abi;
}

export function bytecodeOf(name: string): Hex {
  const dir = existsSync(join(OUT, `${name}.sol`, `${name}.json`)) ? `${name}.sol` : readdirSync(OUT).find((d) => existsSync(join(OUT, d, `${name}.json`)))!;
  return JSON.parse(readFileSync(join(OUT, dir, `${name}.json`), "utf8")).bytecode.object as Hex;
}

/** Every custom error of every compiled contract, so a revert bubbling up from a nested call still decodes. */
export function errorAbi(): AbiError[] {
  if (allErrors) return allErrors;
  const seen = new Map<string, AbiError>();
  for (const d of readdirSync(OUT)) {
    if (!d.endsWith(".sol")) continue;
    for (const f of readdirSync(join(OUT, d))) {
      if (!f.endsWith(".json")) continue;
      try {
        for (const item of JSON.parse(readFileSync(join(OUT, d, f), "utf8")).abi as Abi) {
          if (item.type !== "error") continue;
          const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
          if (!seen.has(sig)) seen.set(sig, item);
        }
      } catch {}
    }
  }
  allErrors = [...seen.values()];
  return allErrors;
}

const fmtArg = (v: unknown): string => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? `[${v.map(fmtArg).join(",")}]` : String(v));

/** "ErrorName(arg, ...)" for a revert, decoding custom errors from any contract; the message otherwise. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) return `${rev.data.errorName}(${(rev.data.args ?? []).map(fmtArg).join(",")})`;
    const raw = rev?.raw ?? (err.walk((e) => typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-f]{8}/i.test((e as { data: string }).data)) as { data?: Hex } | null)?.data;
    if (raw && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: errorAbi(), data: raw });
        return `${d.errorName}(${(d.args ?? []).map(fmtArg).join(",")})`;
      } catch {
        return `revert ${raw.slice(0, 10)}`;
      }
    }
    if (rev?.reason) return rev.reason;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

// ---------------------------------------------------------------- recorder

export type Status = "pass" | "fail" | "known";
export type Step = {
  area: string;
  step: string;
  actor: string;
  tx?: Hex | undefined;
  gas?: string | undefined;
  status: Status;
  assertion: string;
  detail?: string | undefined;
  bug?: string | undefined;
  ms: number;
};

export type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

export class AssertionFailed extends Error {}

/** A JSON-RPC hiccup of a load-balanced public node (not a revert): worth one more try. */
export function transientRpcError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  if (/revert/i.test(m)) return false;
  return /Missing or invalid parameters|header not found|unknown block|timed? ?out|ECONNRESET|socket hang up|502|503|504|429|rate limit/i.test(m);
}

/** Retries `fn` (a gas estimate) up to 4 times, 2 s apart, on transient RPC errors only. */
export async function retryTransient<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !transientRpcError(e)) throw e;
      await Bun.sleep(2000);
    }
  }
}
export function expect(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new AssertionFailed(msg);
}
export const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class Recorder {
  steps: Step[] = [];
  area = "setup";
  readonly pub: PublicClient;
  private readonly wallets = new Map<string, ReturnType<ReturnType<typeof clients>["wallet"]>>();

  /** `c`: the chain's clients; the fork's by default (the testnet exercise passes its chain-id guarded ones). */
  constructor(
    readonly names: Map<string, string>,
    readonly known: KnownBug[],
    readonly c: ReturnType<typeof clients> = clients(),
  ) {
    this.pub = this.c.pub;
  }

  who(a: Address | LocalAccount | string): string {
    const addr = typeof a === "string" ? a : a.address;
    return this.names.get(addr.toLowerCase()) ?? `${addr.slice(0, 8)}…`;
  }

  wallet(acct: LocalAccount) {
    let w = this.wallets.get(acct.address);
    if (!w) {
      w = this.c.wallet(acct);
      this.wallets.set(acct.address, w);
    }
    return w;
  }

  private push(s: Omit<Step, "area" | "status"> & { ok: boolean }) {
    const { ok, ...rest } = s;
    let status: Status = ok ? "pass" : "fail";
    let bug: string | undefined;
    if (!ok) {
      const k = this.known.find((b) => b.area === this.area && b.steps.some((p) => (typeof p === "string" ? p === s.step : p.test(s.step))));
      if (k) {
        status = "known";
        bug = k.id;
      }
    }
    const step: Step = { area: this.area, status, ...rest, ...(bug ? { bug } : {}) };
    this.steps.push(step);
    const tag = status === "pass" ? "ok  " : status === "known" ? "KNWN" : "FAIL";
    console.log(`  ${tag} [${this.area}] ${s.step}${s.tx ? ` ${s.tx.slice(0, 12)}… gas ${s.gas}` : ""}${ok ? "" : `: ${s.detail ?? s.assertion}`}`);
    return step;
  }

  /**
   * Sends a transaction (simulated first: a revert is recorded with its decoded reason) and runs `assert` on the
   * receipt. Returns the receipt, or undefined when the step failed.
   */
  async send(step: string, from: LocalAccount, call: Call, assert?: (r: TransactionReceipt) => Promise<string | void> | string | void): Promise<TransactionReceipt | undefined> {
    const t0 = Date.now();
    const actor = this.who(from);
    let hash: Hex | undefined;
    let r: TransactionReceipt | undefined;
    try {
      const abi = [...call.abi, ...errorAbi()] as Abi;
      const base = { account: from, address: call.address, abi, functionName: call.functionName, args: call.args ?? [], ...(call.value ? { value: call.value } : {}) } as const;
      // lib/gas.ts: priced now and one second ahead, plus the standard headroom (what the desk services use).
      const gas = withGasHeadroom(await retryTransient(() => estimateGasAhead(this.pub as never, base as never)));
      hash = await this.wallet(from).writeContract({ ...base, gas } as never);
      r = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error("reverted on chain");
      const what = (assert ? await assert(r) : undefined) ?? "receipt status success";
      this.push({ step, actor, tx: hash, gas: r.gasUsed.toString(), ok: true, assertion: what, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.push({ step, actor, tx: hash, gas: r?.gasUsed.toString(), ok: false, assertion: "transaction succeeds and its effect holds", detail: e instanceof AssertionFailed ? e.message : revertReason(e), ms: Date.now() - t0 });
      return undefined;
    }
  }

  /** A raw transaction (deploys, ETH transfers). */
  async sendRaw(step: string, from: LocalAccount, tx: { to?: Address; data?: Hex; value?: bigint }, assert?: (r: TransactionReceipt) => Promise<string | void> | string | void) {
    const t0 = Date.now();
    let hash: Hex | undefined;
    let r: TransactionReceipt | undefined;
    try {
      const gas = withGasHeadroom(await retryTransient(() => this.pub.estimateGas({ account: from, ...tx } as never)));
      hash = await this.wallet(from).sendTransaction({ ...tx, gas } as never);
      r = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error("reverted on chain");
      const what = (assert ? await assert(r) : undefined) ?? "receipt status success";
      this.push({ step, actor: this.who(from), tx: hash, gas: r.gasUsed.toString(), ok: true, assertion: what, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.push({ step, actor: this.who(from), tx: hash, gas: r?.gasUsed.toString(), ok: false, assertion: "transaction succeeds", detail: e instanceof AssertionFailed ? e.message : revertReason(e), ms: Date.now() - t0 });
      return undefined;
    }
  }

  async deploy(step: string, from: LocalAccount, name: string, args: unknown[] = []): Promise<Address | undefined> {
    const t0 = Date.now();
    let hash: Hex | undefined;
    try {
      hash = await this.wallet(from).deployContract({ abi: abiOf(name), bytecode: bytecodeOf(name), args } as never);
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success" || !r.contractAddress) throw new Error("deploy reverted");
      this.names.set(r.contractAddress.toLowerCase(), name);
      this.push({ step, actor: this.who(from), tx: hash, gas: r.gasUsed.toString(), ok: true, assertion: `${name} at ${r.contractAddress}`, ms: Date.now() - t0 });
      return r.contractAddress;
    } catch (e) {
      this.push({ step, actor: this.who(from), tx: hash, ok: false, assertion: `deploy ${name}`, detail: revertReason(e), ms: Date.now() - t0 });
      return undefined;
    }
  }

  /** Negative case: the call must revert with `expected` (an error name, optionally with its args). */
  async reverts(step: string, from: LocalAccount | Address, call: Call, expected: string, opts: { blockOverrides?: { time?: bigint } } = {}): Promise<boolean> {
    const t0 = Date.now();
    const account = typeof from === "string" ? from : from.address;
    let got = "did not revert";
    try {
      await this.pub.simulateContract({ account, address: call.address, abi: [...call.abi, ...errorAbi()] as Abi, functionName: call.functionName, args: call.args ?? [], ...(call.value ? { value: call.value } : {}), ...(opts.blockOverrides ? { blockOverrides: opts.blockOverrides } : {}) } as never);
    } catch (e) {
      got = revertReason(e);
    }
    const ok = got === expected || got.startsWith(`${expected}(`) || (expected.endsWith(")") ? false : got.split("(")[0] === expected);
    this.push({ step, actor: this.who(account), ok, assertion: `reverts with ${expected}`, detail: ok ? undefined : `got ${got}`, ms: Date.now() - t0 });
    return ok;
  }

  /** A check with no transaction of its own (a view, an API answer, a service's effect). */
  async check(step: string, fn: () => Promise<string> | string, actor = "-"): Promise<boolean> {
    const t0 = Date.now();
    try {
      const what = await fn();
      this.push({ step, actor, ok: true, assertion: what, ms: Date.now() - t0 });
      return true;
    } catch (e) {
      this.push({ step, actor, ok: false, assertion: "check holds", detail: e instanceof AssertionFailed ? e.message : revertReason(e), ms: Date.now() - t0 });
      return false;
    }
  }

  /** A transaction sent by a service (relayer, keeper, desk runner): recorded with its hash and gas. */
  async external(step: string, actor: string, fn: () => Promise<{ tx?: Hex | undefined; assertion: string }>): Promise<boolean> {
    const t0 = Date.now();
    try {
      const r = await fn();
      let gas: string | undefined;
      if (r.tx) gas = (await this.pub.getTransactionReceipt({ hash: r.tx })).gasUsed.toString();
      this.push({ step, actor, tx: r.tx, gas, ok: true, assertion: r.assertion, ms: Date.now() - t0 });
      return true;
    } catch (e) {
      this.push({ step, actor, ok: false, assertion: "service action happened", detail: e instanceof AssertionFailed ? e.message : revertReason(e), ms: Date.now() - t0 });
      return false;
    }
  }

  /** Records a failure that ended an area early (an exception outside any step). */
  abort(e: unknown) {
    this.push({ step: "area aborted", actor: "-", ok: false, assertion: "area runs to the end", detail: e instanceof Error ? (e.stack ?? e.message).split("\n").slice(0, 4).join(" | ") : String(e), ms: 0 });
  }

  // ---- reads and chain control

  read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }

  async now(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** Moves chain time forward to `ts` (never back) and mines a block. */
  async warpTo(ts: bigint) {
    const now = await this.now();
    if (ts > now) await this.c.rpc("evm_increaseTime", [Number(ts - now)]);
    await this.c.rpc("evm_mine");
  }

  async warp(seconds: bigint) {
    await this.warpTo((await this.now()) + seconds);
  }

  /** Polls `fn` until it returns a value (not undefined) or the timeout passes. */
  async until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 90_000, everyMs = 1000): Promise<T> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        const v = await fn();
        if (v !== undefined) return v;
      } catch (e) {
        last = e;
      }
      if (Date.now() > end) throw new AssertionFailed(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? ` (last error: ${revertReason(last)})` : ""}`);
      await Bun.sleep(everyMs);
    }
  }
}
