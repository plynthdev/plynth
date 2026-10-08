// Rules of the steps added for the complete testnet run: the E1 replay's failing deliver touches only the target
// deliver's gas estimate, the liquidation collateral opens healthy and becomes liquidatable under the maximum
// borrow fee, and a timelock check that met an already-expired deploy-time proposal passes on re-check only when
// the same check later passed against a fresh proposal. No network.
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { crowdAbi } from "@/abi/keeper";
import { QUIET_ROUTE } from "@/keeper/jobs/quiet";
import type { SenderIO } from "@/keeper/sender";
import type { Step } from "../../fork/exercise/core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, failingDeliverIO, FAIL_EXEC_GAS, serviceEnv, serviceStartScript, startService } from "./e1";
import { liquidationCollateral, LIQ_HEADROOM_BPS, MAINTENANCE_BPS } from "./more-areas";
import { freshTimelock, keeperRestarted } from "./recheck";
import { emptyState } from "./state";

const CROWD = getAddress("0x6f13394F8199BEd29f009E139Ea887F68C3D4732");
const MSPY = getAddress("0x578113D68A8de344Eea34Cfc68Da17cc543f39F5");
const MTSLA = getAddress("0x3238c361664755F8352d4F4569AcC263EA846545");
const OPEN = getAddress("0x83A6d5A17E73987BA49fAc03F96FD5f10Dcf664C");
const QUIET = getAddress("0xDEe21B659E10d9B9D55b17Ae326123053bcec098");
const KEEPER = getAddress("0xfe041a3306dB4Dc8bF0771142DCeB31d67f49EBF");
const REAL_ESTIMATE = 180_000n;
const L1 = 9_000n;

function baseIO(): SenderIO {
  return {
    estimateGas: async () => REAL_ESTIMATE,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n }),
    getTransactionCount: async () => 7,
    signTransaction: async () => "0x02" as Hex,
    sendRawTransaction: async () => `0x${"ab".repeat(32)}` as Hex, // not-a-key (a fake tx hash)
    getTransactionReceipt: async () => null,
  };
}

const deliver = (asset: Address, bookId: bigint, user: Address) => encodeFunctionData({ abi: crowdAbi, functionName: "deliver", args: [asset, bookId, user, QUIET_ROUTE] });

describe("E1 replay: failingDeliverIO", () => {
  const target = { asset: MSPY, bookId: 1n, user: OPEN };
  const l1 = async () => L1;

  test("the target deliver gets an estimate whose +20% limit is its L1 gas plus FAIL_EXEC_GAS", async () => {
    const seen: { limit?: bigint } = {};
    const io = failingDeliverIO(baseIO(), CROWD, target, l1, seen);
    const est = await io.estimateGas({ account: KEEPER, to: CROWD, data: deliver(MSPY, 1n, OPEN) });
    expect(seen.limit).toBe(L1 + FAIL_EXEC_GAS);
    expect((est * 12_000n) / 10_000n).toBeLessThanOrEqual(L1 + FAIL_EXEC_GAS);
    expect((est * 12_000n) / 10_000n).toBeGreaterThan(L1 + FAIL_EXEC_GAS - 2n);
    expect(est).toBeLessThan(REAL_ESTIMATE);
  });

  test("other users' delivers, other books, other assets and other calls keep the real estimate", async () => {
    const seen: { limit?: bigint } = {};
    const io = failingDeliverIO(baseIO(), CROWD, target, l1, seen);
    for (const data of [deliver(MSPY, 1n, QUIET), deliver(MSPY, 2n, OPEN), deliver(MTSLA, 1n, OPEN), encodeFunctionData({ abi: crowdAbi, functionName: "claimOpen", args: [MSPY, 1n] })]) {
      expect(await io.estimateGas({ account: KEEPER, to: CROWD, data })).toBe(REAL_ESTIMATE);
    }
    // the same deliver calldata sent to another contract, and calldata that is not a CrowdBuy call
    expect(await io.estimateGas({ account: KEEPER, to: MSPY, data: deliver(MSPY, 1n, OPEN) })).toBe(REAL_ESTIMATE);
    expect(await io.estimateGas({ account: KEEPER, to: CROWD, data: "0xdeadbeef" })).toBe(REAL_ESTIMATE);
    expect(seen.limit).toBeUndefined();
  });

  test("everything else in the IO is the base IO", async () => {
    const base = baseIO();
    const io = failingDeliverIO(base, CROWD, target, l1);
    expect(io.signTransaction).toBe(base.signTransaction);
    expect(io.sendRawTransaction).toBe(base.sendRawTransaction);
    expect(io.getTransactionCount).toBe(base.getTransactionCount);
    expect(io.getTransactionReceipt).toBe(base.getTransactionReceipt);
  });
});

describe("liquidation set-up collateral", () => {
  // Equity at open ~ collateral - taker fee; liquidatable once equity < size * MAINTENANCE_BPS.
  const equityBps = (size: bigint, fee: bigint) => ((liquidationCollateral(size, fee) - (size * fee) / 10_000n) * 10_000n) / size;

  test("opens above maintenance by the headroom (no Liquidatable revert at open)", () => {
    for (const fee of [0n, 5n, 10n, 30n, 100n]) {
      expect(equityBps(1_000_000_000n, fee)).toBe(MAINTENANCE_BPS + LIQ_HEADROOM_BPS);
    }
  });

  test("stays under the 50x leverage cap and a 1%/h borrow reaches maintenance in under 2 h", () => {
    for (const fee of [0n, 10n, 100n]) {
      const size = 1_000_000_000n;
      const c = liquidationCollateral(size, fee);
      expect(size <= c * 50n).toBe(true);
      expect(Number(LIQ_HEADROOM_BPS) / 100).toBeLessThan(2); // hours at 100 bps/h
    }
  });

  test("fuzz: any size and fee keep the collateral exact to the bps formula", () => {
    for (let i = 0; i < 500; i++) {
      const size = BigInt(1 + Math.floor(Math.random() * 1e12));
      const fee = BigInt(Math.floor(Math.random() * 101));
      const c = liquidationCollateral(size, fee);
      expect(c).toBe((size * (MAINTENANCE_BPS + fee + LIQ_HEADROOM_BPS)) / 10_000n);
      expect(c * 10_000n <= size * (MAINTENANCE_BPS + fee + LIQ_HEADROOM_BPS)).toBe(true);
    }
  });
});

describe("re-check of a timelock check that met an expired deploy-time proposal", () => {
  const step = (over: Partial<Step>): Step => ({ area: "timelocks", step: "Hidden Vault cap cannot apply before its 15 min timelock", actor: "deployer", status: "fail", assertion: "reverts with TooEarly", detail: "got did not revert", ms: 1, ...over }) as Step;

  test("passes only when the same check later passed against a fresh proposal", () => {
    const st = emptyState(46630, "0x0");
    const first = step({});
    st.steps.push(first);
    expect(() => freshTimelock({ st }, first)).toThrow("no passing check");
    st.steps.push({ ...step({ status: "pass", detail: undefined }), area: "timelocks", step: "deploy-time timelocks already over: owner proposes the mUSDG cap again (unchanged, new 15 min timelock)", tx: "0xabc" } as Step);
    st.steps.push(step({ status: "pass", detail: undefined }));
    expect(freshTimelock({ st }, first)).toContain("against a fresh proposal (0xabc)");
  });

  test("never excuses a different failure (a wrong revert reason)", () => {
    const st = emptyState(46630, "0x0");
    const wrong = step({ detail: "got NotOwner" });
    st.steps.push(wrong, step({ status: "pass", detail: undefined }));
    expect(() => freshTimelock({ st }, wrong)).toThrow("first failure was got NotOwner");
  });
});

describe("restarting a service from the exercise (E1 replay)", () => {
  test("only the service is backgrounded, off the caller's pipe", () => {
    const line = serviceStartScript({ dir: "/d", envFile: "/d/env/k.env", entry: "/a/k.ts", log: "/d/logs/k.log" });
    expect(line).not.toMatch(/&&[^;]*&\s*echo/); // an `a && b &` chain backgrounds a subshell holding the pipe
    expect(line).toContain('nohup bun "/a/k.ts" >>"/d/logs/k.log" 2>&1 </dev/null & echo $!');
  });

  test("the environment is a login's basics, never app/.env values", () => {
    const env = serviceEnv({ PATH: "/bin", HOME: "/h", USER: "alice", DATABASE_URL: "postgres://elsewhere/x", KEEPER_JOBS: "sweep" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", USER: "alice" });
  });

  test("startService returns once the service is healthy, the service keeps its USER and outlives the call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-svc-"));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    writeFileSync(join(dir, "svc.env"), `SVC_PORT=${port}\nSVC_OUT=${join(dir, "user.txt")}\n`);
    writeFileSync(join(dir, "svc.ts"), `require("node:fs").writeFileSync(process.env.SVC_OUT, String(process.env.USER ?? "")); Bun.serve({ port: Number(process.env.SVC_PORT), fetch: () => new Response("ok") });`);
    const pid = await startService({ dir, envFile: join(dir, "svc.env"), entry: join(dir, "svc.ts"), log: join(dir, "svc.log"), pidFile: join(dir, "svc.pid"), healthUrl: `http://127.0.0.1:${port}/health` }, 30_000);
    try {
      expect(alive(pid)).toBe(true);
      expect(Number(readFileSync(join(dir, "svc.pid"), "utf8"))).toBe(pid);
      expect(readFileSync(join(dir, "user.txt"), "utf8")).toBe(process.env.USER ?? "");
    } finally {
      process.kill(pid, "SIGTERM");
    }
  }, 40_000);
});

describe("re-check of the E1 replay's keeper restart step", () => {
  const base = { area: "quiet", actor: "operator", assertion: "check holds", ms: 1 };
  const failed = { ...base, step: "E1 replay: the keeper service starts again with the fixed code", status: "fail", detail: "keeper exited at start; see .testnet/logs/keeper.log" } as Step;
  const skipped = { ...base, step: "E1 replay: the keeper's next pass marks the plan skipped ('claimed openly') and releases nothing", status: "pass", assertion: "quiet-plan skipped: claimed openly (tx 0xabc)" } as Step;

  test("passes when the running keeper is healthy and the plan-skipped step passed after it", () => {
    const st = emptyState(46630, "0x0");
    st.steps.push(failed, skipped);
    expect(keeperRestarted({ st }, failed, { ok: true, chainId: 46630 })).toContain("claimed openly");
  });

  test("fails without the later plan-skipped step, or with an unhealthy keeper", () => {
    const st = emptyState(46630, "0x0");
    st.steps.push(failed);
    expect(() => keeperRestarted({ st }, failed, { ok: true, chainId: 46630 })).toThrow("no passing plan-skipped step");
    st.steps.push(skipped);
    expect(() => keeperRestarted({ st }, failed, { ok: false, chainId: 46630 })).toThrow("keeper not healthy");
    expect(() => keeperRestarted({ st }, failed, { ok: true, chainId: 4663 })).toThrow("keeper not healthy");
  });
});
