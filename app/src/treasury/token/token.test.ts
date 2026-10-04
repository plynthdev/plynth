// Token API: hand-written ABI subsets match the forge artifacts, and the read-only handler shapes chain reads.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector, type Abi, type AbiFunction } from "viem";
import { feeRouterAbi, insuranceAbi, stakingAbi } from "@/abi/treasury-token";
import { tokenApi } from "./api";

const OUT = join(import.meta.dir, "..", "..", "..", "..", "contracts", "out");
const art = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).abi as Abi;
const fnSels = (abi: Abi) => new Set(abi.filter((i) => i.type === "function").map((i) => toFunctionSelector(i as AbiFunction)));

let ready = false;
beforeAll(() => {
  if (!existsSync(join(OUT, "FeeRouter.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(OUT, "..")], { stdout: "ignore", stderr: "ignore" });
  }
  ready = existsSync(join(OUT, "FeeRouter.sol"));
});

describe("token ABIs", () => {
  test("every function in the subsets exists with the same selector", () => {
    if (!ready) return;
    for (const [mine, file, name] of [
      [stakingAbi, "PlinthStaking.sol", "PlinthStaking"],
      [feeRouterAbi, "FeeRouter.sol", "FeeRouter"],
      [insuranceAbi, "ExceptionInsurancePool.sol", "ExceptionInsurancePool"],
    ] as const) {
      const theirs = fnSels(art(file, name));
      for (const i of mine as Abi) {
        if (i.type !== "function") continue;
        expect(theirs.has(toFunctionSelector(i as AbiFunction)), `${name}.${(i as AbiFunction).name}`).toBe(true);
      }
    }
  });
});

const A = {
  staking: "0x00000000000000000000000000000000000000a1",
  feeRouter: "0x00000000000000000000000000000000000000a2",
  insurancePool: "0x00000000000000000000000000000000000000a3",
} as const;
const ALICE = "0x00000000000000000000000000000000000000b0";

function fakeClient(values: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      const k = `${address}.${functionName}`;
      calls.push(k);
      if (!(k in values)) throw new Error(`unexpected read ${k}`);
      return values[k];
    },
  };
}

describe("token api", () => {
  const values = {
    [`${A.staking}.stakedOf`]: 10_000n * 10n ** 18n,
    [`${A.staking}.stakerOf`]: [10_000n * 10n ** 18n, 0n, 5n, 1_800_604_800n],
    [`${A.staking}.tierIndexOf`]: 1n,
    [`${A.staking}.tierOf`]: { maxDesks: 4, weeklyClose: true, privateSleeve: false, templatePriority: 1 },
    [`${A.staking}.earned`]: [1500_000000n, 3972n * 10n ** 18n],
    [`${A.feeRouter}.lastPush`]: 1_800_000_000n,
    [`${A.feeRouter}.buyCarry`]: 1300_000000n,
    [`${A.feeRouter}.perPushCap`]: 200_000000n,
    [`${A.feeRouter}.maxSlippageBps`]: 100,
    [`${A.feeRouter}.authorBps`]: 0,
    [`${A.feeRouter}.spotSqrtPriceX96`]: 354319114228591420592203432321452013n,
    [`${A.insurancePool}.freeAssets`]: 600_000000n,
    [`${A.insurancePool}.queuedOwed`]: 0n,
    [`${A.insurancePool}.totalShares`]: 100_000000n,
    [`${A.insurancePool}.queueLength`]: 0n,
    [`${A.insurancePool}.claimCount`]: 1n,
    [`${A.insurancePool}.claim`]: {
      treasury: "0x00000000000000000000000000000000000000c0",
      board: "0x00000000000000000000000000000000000000c1",
      amount: 1000_000000n,
      paid: 300_000000n,
      evidenceHash: `0x${"11".repeat(32)}`,
      filedAt: 1_800_000_100n,
      committeeApproved: true,
      policyBugAttested: true,
      status: 2,
    },
  };
  const api = tokenApi(fakeClient(values) as unknown as Parameters<typeof tokenApi>[0], A);
  const get = async (p: string) => {
    const r = await api(new Request(`http://x${p}`));
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  test("staker: tier and claimable rewards, bigints as strings", async () => {
    const { status, body } = await get(`/token/stakers/${ALICE}`);
    expect(status).toBe(200);
    expect(body.staked).toBe("10000000000000000000000");
    expect(body.tierIndex).toBe(1);
    expect(body.tier.weeklyClose).toBe(true);
    expect(body.earned).toEqual({ usdg: "1500000000", plth: "3972000000000000000000" });
    expect(body.releaseAt).toBe(1_800_604_800);
  });

  test("router: next push is an hour after the last", async () => {
    const { body } = await get("/token/router");
    expect(body.nextPushAt).toBe(1_800_003_600);
    expect(body.buyCarry).toBe("1300000000");
  });

  test("insurance totals and one claim", async () => {
    expect((await get("/token/insurance")).body.hasDepositors).toBe(true);
    const c = await get("/token/insurance/claims/0");
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("queued");
    expect(c.body.paid).toBe("300000000");
    expect((await get("/token/insurance/claims/1")).status).toBe(404);
    expect((await get("/token/insurance/claims/x")).status).toBe(400);
  });

  test("bad input and unknown routes", async () => {
    expect((await get("/token/stakers/0x123")).status).toBe(400);
    expect((await get("/token/nope")).status).toBe(404);
    expect((await get("/other")).status).toBe(404);
    expect((await api(new Request("http://x/token/router", { method: "POST" }))).status).toBe(405);
  });
});
