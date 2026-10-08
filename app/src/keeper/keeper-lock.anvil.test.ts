// Two keeper processes for one chain + deployment: exactly one runs. The real bin/keeper.ts against anvil and a real
// Postgres database: the second daemon and a --once pass both exit 75 with a clear error while the first runs; when
// the first is killed (SIGKILL, no cleanup at all) its database session ends and the next keeper starts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, type Address } from "viem";
import { ANVIL_KEY_1, ROOT, keeperTestDb, startAnvil } from "@/testing/keeper-helpers";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dir: string;
const procs: ReturnType<typeof Bun.spawn>[] = [];
const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

function env(port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DATABASE_URL: t.url,
    LOCAL_RPC_URL: anvil.rpc,
    KEEPER_CHAIN: "local",
    KEEPER_DEPLOYMENTS_DIR: dir,
    KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
    KEEPER_SECRET_KEY: secretKey,
    KEEPER_PORT: String(port),
    KEEPER_INTERVAL_MS: "200",
    KEEPER_JOBS: "deliver-quiet", // no StealthClaims in this deployment: a pass that touches no contract and succeeds
  };
}

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
};

function daemon(port: number) {
  const p = Bun.spawn(["bun", "app/src/bin/keeper.ts"], { cwd: ROOT, env: env(port), stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  return p;
}

function once() {
  const r = Bun.spawnSync(["bun", "app/src/bin/keeper.ts", "--once"], { cwd: ROOT, env: env(freePort()), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

async function healthy(port: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await Bun.sleep(100);
  }
  return false;
}

beforeAll(async () => {
  anvil = await startAnvil();
  t = await keeperTestDb("lockcli");
  dir = mkdtempSync(join(tmpdir(), "plynth-keeper-lock-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify({ savingsVault: A(0xa1), crowdBuy: A(0xa2), jitterBeacon: A(0xa3), usdg: A(0xa4), stocks: {} }));
}, 60_000);

afterAll(async () => {
  for (const p of procs) {
    p.kill(9);
    await p.exited;
  }
  await anvil?.stop();
  await t?.drop();
});

describe("single keeper per chain + deployment", () => {
  test("two keepers -> one runs; the second (daemon or --once) exits 75; after the first is killed the next one runs", async () => {
    const p1 = freePort();
    const first = daemon(p1);
    expect(await healthy(p1)).toBe(true);

    const p2 = freePort();
    const second = daemon(p2);
    const code = await Promise.race([second.exited, Bun.sleep(30_000).then(() => "still running")]);
    const err = await new Response(second.stderr).text();
    expect(code).toBe(75);
    expect(err).toContain("refusing to start: another keeper already runs for this chain and deployment");
    expect(await fetch(`http://127.0.0.1:${p2}/health`).then(() => "up").catch(() => "down")).toBe("down");

    const o = once();
    expect(o.code).toBe(75);
    expect(o.out).toContain("another keeper already runs");
    expect(o.out).not.toContain("deliver-quiet: ok"); // it never ran a job

    expect(await healthy(p1)).toBe(true); // the first keeps passing
    first.kill(9); // a crash: no cleanup, no unlock
    await first.exited;

    let r = once();
    for (let i = 0; i < 30 && r.code === 75; i++) {
      await Bun.sleep(200); // the server ends the dead session as soon as it sees the socket close
      r = once();
    }
    expect(r.code).toBe(0);
    expect(r.out).toContain("holding the keeper lock");
    expect(r.out).toContain("deliver-quiet: ok");
    expect(r.out.toLowerCase()).not.toContain(ANVIL_KEY_1.slice(2));
  }, 120_000);
});
