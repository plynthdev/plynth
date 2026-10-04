// Shared plumbing for app/scripts/e2e.sh: anvil forks, throwaway Postgres databases, service processes, and a
// check list that turns any mismatch into a non-zero exit. Nothing here broadcasts to a real network: every
// RPC the scenarios write to is a local anvil fork.
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http } from "viem";

export const ROOT = join(import.meta.dir, "..", "..", "..");

/** Anvil's public dev keys (#0, #1, #9). Only ever used against a local anvil fork. */
export const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // test-key (anvil #0)
  keeper: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // test-key (anvil #1)
  equity: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // test-key (anvil #2)
  relayer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // test-key (anvil #9)
} as const;

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Collects named checks. `finish()` prints the tally and returns the exit code (1 on any mismatch). */
export class Checks {
  failed: string[] = [];
  passed = 0;
  constructor(readonly scenario: string) {}
  step(msg: string) {
    console.log(`[e2e ${this.scenario} ${elapsed()}] ${msg}`);
  }
  ok(name: string, cond: boolean, detail = "") {
    if (cond) {
      this.passed++;
      console.log(`  ok   ${name}`);
    } else {
      this.failed.push(name);
      console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
    }
    return cond;
  }
  eq(name: string, got: unknown, want: unknown) {
    const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    return this.ok(name, s(got) === s(want), `got ${s(got)}, want ${s(want)}`);
  }
  /** Throws (ends the scenario) when a precondition for the rest fails. */
  must(name: string, cond: boolean, detail = "") {
    if (!this.ok(name, cond, detail)) throw new Error(`precondition failed: ${name}`);
  }
  finish(): number {
    console.log(`[e2e ${this.scenario}] ${this.passed} checks passed, ${this.failed.length} failed${this.failed.length ? `: ${this.failed.join("; ")}` : ""}`);
    return this.failed.length ? 1 : 0;
  }
}

/** Cleanup hooks, run in reverse order on finish or on SIGINT/SIGTERM. */
const hooks: (() => unknown | Promise<unknown>)[] = [];
export function onCleanup(fn: () => unknown | Promise<unknown>) {
  hooks.push(fn);
}
export async function runCleanup() {
  while (hooks.length) {
    try {
      await hooks.pop()!();
    } catch (e) {
      console.error(`[e2e] cleanup: ${(e as Error).message}`);
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await runCleanup();
    process.exit(130);
  });
}

export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

/**
 * Starts `anvil --fork-url` on a free port and waits until it answers (forks fetch state lazily). Public RPCs sit
 * behind load balancers whose nodes lag by a block or two ("Failed to get block"), so a failed start is retried.
 */
export async function startFork(forkUrl: string, extra: string[] = []) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startForkOnce(forkUrl, extra);
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`[e2e] fork start failed (${(e as Error).message.split("\n")[0]}), retrying`);
      await Bun.sleep(2000 * attempt);
    }
  }
}

async function startForkOnce(forkUrl: string, extra: string[]) {
  const port = freePort();
  const proc = Bun.spawn(["anvil", "--fork-url", forkUrl, "--port", String(port), "--silent", "--gas-limit", "100000000", ...extra], { stdout: "ignore", stderr: "pipe" });
  const rpc = `http://127.0.0.1:${port}`;
  const stop = async () => {
    proc.kill();
    await proc.exited;
  };
  onCleanup(stop);
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited: ${await new Response(proc.stderr).text()}`);
    try {
      const chainId = await pub.getChainId();
      return { rpc, port, chainId, stop };
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`anvil fork of ${forkUrl} did not answer in 60 s`);
}

/**
 * Anvil's public dev accounts carry EIP-7702 delegations on Robinhood Chain mainnet and testnet (sweeper bots;
 * `cast code 0xf39F…2266` starts 0xef0100). On a fork that code comes along: OpenZeppelin's SignatureChecker then
 * takes the ERC-1271 path for those "EOAs" and every signature check fails. Strip it before using them.
 */
export async function clearDevAccountCode(rpc: string) {
  const pub = createPublicClient({ transport: http(rpc) });
  const accounts = (await pub.request({ method: "eth_accounts" as never })) as string[];
  for (const a of accounts) await pub.request({ method: "anvil_setCode" as never, params: [a, "0x"] as never });
}

/** Fresh migrated database plynth_e2e_<label>_*, dropped on cleanup. */
export async function e2eDb(label: string) {
  const name = `plynth_e2e_${label}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const url = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(url);
  await runMigrations(url);
  const conn = connect(url);
  onCleanup(async () => {
    await conn.close();
    await dropDatabase(url);
  });
  return { url, name, ...conn };
}

/** Runs a one-shot command; throws with its output on a non-zero exit. */
export function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}:\n${out.slice(-4000)}`);
  return out;
}

/**
 * Starts a long-running service (`bun <entry>`), logging to <logDir>/<name>.log, and waits for `health` to
 * answer 200. Killed on cleanup.
 */
export async function startService(name: string, entry: string, env: Record<string, string>, health: string, logDir: string) {
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, `${name}.log`), "a");
  const proc = Bun.spawn(["bun", entry], { cwd: ROOT, env: { ...process.env, ...env }, stdout: fd, stderr: fd });
  onCleanup(async () => {
    proc.kill();
    await proc.exited;
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error(`${name} exited ${proc.exitCode}; see ${join(logDir, `${name}.log`)}`);
    const r = await fetch(health).catch(() => undefined);
    if (r?.ok) return proc;
    await Bun.sleep(100);
  }
  throw new Error(`${name} did not become healthy at ${health}`);
}

/** 6-decimal fixed string, truncated (the API's display format), computed here independently. */
export function fixed6(x: bigint, decimals: number): string {
  const v = decimals >= 6 ? x / 10n ** BigInt(decimals - 6) : x * 10n ** BigInt(6 - decimals);
  const s = v.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}
