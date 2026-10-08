// Unit tests for the mainnet closed-beta tooling (no chain needed): the chain-id guard, the deployment file
// rewrite, the cost model, the service env files (mainnet confirmations, keystore paths only) and the fork's
// beta-stack switches.
import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { assertMainnetChainId, botBudget, fmtEth, keystoreName, MIN_CONFIRMATIONS, normalizeDeployment, txCostWei, withMargin, WrongChainError } from "./lib";
import { envFiles, pendingAccepts } from "./setup";
import { forkStack } from "../fork/lib";
import { betaEnv } from "../fork/setup";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

describe("chain guard", () => {
  test("only 4663 passes", () => {
    expect(() => assertMainnetChainId(4663)).not.toThrow();
    expect(() => assertMainnetChainId("0x1237")).not.toThrow();
    for (const id of [46630, 31337, 1, 42161, "0xb626"]) expect(() => assertMainnetChainId(id)).toThrow(WrongChainError);
  });
});

describe("deployment file", () => {
  const raw = {
    chainId: 4663,
    fork: false,
    owner: A(1).toLowerCase(),
    savingsVault: A(2).toLowerCase(),
    treasuryFactory: A(3),
    policyGuard: A(4),
    receipts: A(5),
    templateRegistry: A(6),
    acceptOwnership: [A(7).toLowerCase(), A(8)],
    stocks: JSON.stringify({ TSLA: { token: A(9), feed: A(10), poolId: `0x${"ab".repeat(32)}` } }),
    perpMarkets: JSON.stringify({ TSLA: A(11) }),
  };

  test("rewrites the script output for the services", () => {
    const { main, treasury } = normalizeDeployment(raw, 123);
    expect(main.deployBlock).toBe(123);
    expect(main.treasuryFactoryBlock).toBe(123);
    expect(main.owner).toBe(A(1));
    expect(main.acceptOwnership).toEqual([A(7), A(8)]);
    expect(main.stocks.TSLA!.token).toBe(A(9));
    expect(main.perpMarkets.TSLA).toBe(A(11));
    expect(treasury).toEqual({ chainId: 4663, treasuryFactory: A(3), treasuryFactoryBlock: 123, policyGuard: A(4), receipts: A(5), templateRegistry: A(6) });
  });

  test("refuses another chain and a fork-mode file", () => {
    expect(() => normalizeDeployment({ ...raw, chainId: 31337 }, 1)).toThrow(WrongChainError);
    expect(() => normalizeDeployment({ ...raw, chainId: 46630 }, 1)).toThrow(WrongChainError);
    expect(() => normalizeDeployment({ ...raw, fork: true }, 1)).toThrow(WrongChainError);
  });
});

describe("cost model", () => {
  test("Orbit cost = (L2 gas + L1 data gas) x base fee", () => {
    expect(txCostWei({ gasUsed: 100n, l1Gas: 0n }, 21_588_000n)).toBe(2_158_800_000n);
    expect(txCostWei({ gasUsed: 100n, l1Gas: 50n }, 10n)).toBe(1_500n);
  });

  test("margin rounds up and is exact for whole numbers", () => {
    expect(withMargin(1_000n, 5_000n)).toBe(1_500n);
    expect(withMargin(1n, 5_000n)).toBe(2n);
    for (let i = 0; i < 1000; i++) {
      const w = BigInt(Math.floor(Math.random() * 1e15));
      const m = withMargin(w, 5_000n);
      expect(m * 10_000n >= w * 15_000n).toBe(true);
      expect((m - 1n) * 10_000n < w * 15_000n).toBe(true);
    }
  });

  test("bot budget: gas per crowd window x days, never rounding a day down", () => {
    const b = botBudget([{ role: "keeper", txs: 30, l2Gas: 3_000_001n, l1Gas: 0n }], 3, 30, 2n);
    expect(b[0]!.txsPerDay).toBe(10);
    expect(b[0]!.perDayWei).toBe(1_000_001n * 2n);
    expect(b[0]!.totalWei).toBe(1_000_001n * 2n * 30n);
    expect(() => botBudget([], 0, 30, 1n)).toThrow();
  });

  test("fmtEth", () => {
    expect(fmtEth(2_445_500_000_000_000n, 8)).toBe("0.0024455");
    expect(fmtEth(0n)).toBe("0");
  });
});

describe("service env files", () => {
  const dep = { treasuryFactory: A(3), eligibilityRegistry: A(12) };
  const s = { keeperSecretKey: `0x${"11".repeat(32)}` as const, mcpTokenSecret: "22".repeat(32) };

  test("mainnet: every service on chain mainnet, confirmations >= 2, keystore paths only", () => {
    const f = envFiles(dep, s, "postgres://x/plynth_mainnet");
    expect(f.keeper!.KEEPER_CHAIN).toBe("mainnet");
    expect(f.keeper!.KEEPER_CONFIRMATIONS).toBeGreaterThanOrEqual(MIN_CONFIRMATIONS);
    expect(f.indexer!.INDEXER_CONFIRMATIONS).toBeGreaterThanOrEqual(MIN_CONFIRMATIONS);
    expect(String(f.keeper!.KEEPER_KEYSTORE)).toEndWith(`/${keystoreName("keeper")}`);
    expect(String(f.relayer!.RELAYER_KEYSTORE)).toEndWith("/plynth-main-relayer");
    expect(String(f.eligibility!.ELIGIBILITY_KEYSTORE)).toEndWith("/plynth-main-attester");
    expect(String(f.keeper!.KEEPER_KEYSTORE_PASSWORD_FILE)).toEndWith("/keeper.password");
    for (const vars of Object.values(f)) {
      expect(Object.keys(vars).some((k) => k.endsWith("_PRIVATE_KEY") || k === "ELIGIBILITY_ATTESTER_KEY")).toBe(false);
      expect(vars.ELIGIBILITY_ALLOW_UNKNOWN_IP).toBeUndefined();
      for (const k of ["INDEXER_CHAIN", "KEEPER_CHAIN", "RELAYER_CHAIN", "API_CHAIN", "ELIGIBILITY_CHAIN"]) if (k in vars) expect(vars[k]).toBe("mainnet");
    }
  });

  test("fewer than 2 confirmations is refused", () => {
    expect(() => envFiles(dep, s, "postgres://x/y", 1)).toThrow();
    expect(() => envFiles(dep, s, "postgres://x/y", 0)).toThrow();
  });
});

describe("ownership hand-over check", () => {
  test("lists only the contracts OWNER does not own yet", async () => {
    const owner = A(1);
    const owners: Record<string, Address> = { [A(7)]: owner, [A(8)]: A(99) };
    const left = await pendingAccepts(owner, [A(7), A(8)], async (a) => owners[a]!);
    expect(left).toEqual([A(8)]);
  });
});

describe("fork beta stack", () => {
  test("FORK_STACK picks the stack; a remembered choice wins", () => {
    expect(forkStack({}, "")).toBe("full");
    expect(forkStack({ FORK_STACK: "beta" }, "")).toBe("beta");
    expect(forkStack({ FORK_STACK: "full" }, "beta")).toBe("beta");
    expect(() => forkStack({ FORK_STACK: "mainnet" }, "")).toThrow();
  });

  test("beta env: fork mode, every role a distinct dev account", () => {
    const e = betaEnv(false);
    expect(e.BETA_FORK).toBe("true");
    expect(e.DEPLOY_TOKEN).toBe("false");
    expect(betaEnv(true).DEPLOY_TOKEN).toBe("true");
    const roles = ["OWNER", "KEEPER", "ATTESTER", "RELAYER", "CONTROLLER", "CASH_DESK", "EQUITY_DESK"].map((k) => e[k]!);
    expect(new Set(roles).size).toBe(roles.length);
  });
});
