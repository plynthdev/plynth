// Pure decision rules of each job, without a chain or a database.
import { describe, expect, test } from "bun:test";
import { linkIntervals, linkedUserAt, type LinkEvent } from "@/indexer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import { beaconAbi, crowdAbi, stealthClaimsAbi, vaultAbi } from "@/abi/keeper";
import { shieldedPoolAbi } from "@plynth/sdk/vault";
import { keeperDeployment } from "./context";
import { beaconKey, commitmentOf, revealOpen, windowAt, windowsToCommit } from "./jobs/beacon";
import { executeBlocker } from "./jobs/execute";
import { classifySpend } from "./jobs/roundups";
import { chunks } from "./jobs/sweep";
import { MAX_UINT160, permit2Live, topUpDue, TOP_UP_SPACING } from "./jobs/topups";
import { ROOT } from "@/testing/keeper-helpers";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const DAY = 86_400n;

const skipReason = (d: ReturnType<typeof classifySpend>) => (d.kind === "skip" ? d.reason : `accrue:${d.user}`);
const link = (kind: LinkEvent["kind"], user: string, wallet: string, blockNumber: bigint, logIndex = 0): LinkEvent => ({ kind, user, wallet, blockNumber, logIndex });

describe("roundups: which transfers are round-up sources", () => {
  const W = A(0xaa), U1 = A(1), U2 = A(2), VAULT = A(0x99);
  const intervals = linkIntervals([link("WalletLinked", U1, W, 10n), link("WalletUnlinked", U1, W, 20n), link("WalletLinked", U2, W, 30n)]);
  const spend = (blockNumber: bigint, to = A(0x77), value = 1_234_567n) => ({ txHash: "0x01" as Hex, logIndex: 0, blockNumber, from: W, to, value });

  test("credited to whoever the wallet was linked to at that block", () => {
    expect(classifySpend(spend(10n), intervals, new Set())).toEqual({ kind: "accrue", user: U1 });
    expect(classifySpend(spend(19n), intervals, new Set())).toEqual({ kind: "accrue", user: U1 });
    expect(classifySpend(spend(35n), intervals, new Set())).toEqual({ kind: "accrue", user: U2 });
  });

  test("not linked (before link, after unlink) -> skipped", () => {
    expect(skipReason(classifySpend(spend(9n), intervals, new Set()))).toMatch(/not linked/);
    expect(skipReason(classifySpend(spend(20n), intervals, new Set()))).toMatch(/not linked/);
    expect(skipReason(classifySpend(spend(25n), intervals, new Set()))).toMatch(/not linked/);
  });

  test("transfers into Plynth contracts are skipped (case-insensitive); zero-value too", () => {
    expect(skipReason(classifySpend(spend(12n, VAULT.toUpperCase().replace("0X", "0x")), intervals, new Set([VAULT])))).toMatch(/Plynth contract/);
    expect(skipReason(classifySpend(spend(12n, A(0x77), 0n), intervals, new Set()))).toMatch(/zero/);
  });

  test("re-link to another user closes the old interval; same-block link+unlink attributes nothing", () => {
    const iv = linkIntervals([link("WalletLinked", U1, W, 5n), link("WalletLinked", U2, W, 8n), link("WalletLinked", U1, A(0xbb), 3n, 0), link("WalletUnlinked", U1, A(0xbb), 3n, 1)]);
    expect(linkedUserAt(iv, W, 7n)).toBe(U1);
    expect(linkedUserAt(iv, W, 8n)).toBe(U2);
    expect(linkedUserAt(iv, A(0xbb), 3n)).toBeUndefined();
  });
});

describe("topups: weekly pull through a live Permit2 allowance", () => {
  const now = 1_800_000_000n;
  test("Permit2 allowance must be unexpired and cover the amount (max = unlimited)", () => {
    expect(permit2Live({ amount: 25n, expiration: now }, 25n, now)).toBe(true);
    expect(permit2Live({ amount: 24n, expiration: now + 1n }, 25n, now)).toBe(false);
    expect(permit2Live({ amount: 100n, expiration: now - 1n }, 25n, now)).toBe(false);
    expect(permit2Live({ amount: MAX_UINT160, expiration: now }, 10n ** 40n, now)).toBe(true);
  });
  test("due when never pulled or 7 days after the last pull", () => {
    expect(topUpDue(0n, now)).toBe(true);
    expect(topUpDue(now - TOP_UP_SPACING + 1n, now)).toBe(false);
    expect(topUpDue(now - TOP_UP_SPACING, now)).toBe(true);
  });
});

describe("sweep batching", () => {
  test("chunks of at most N, order kept", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 50)).toEqual([]);
    expect(() => chunks([1], 0)).toThrow();
  });
});

describe("beacon: windows, keys, commitments", () => {
  const G = 1_799_971_200n;
  test("windowAt mirrors CrowdBuy.windowOf (fuzz)", () => {
    expect(() => windowAt(G - 1n, G, DAY)).toThrow();
    for (let i = 0; i < 2_000; i++) {
      const t = G + BigInt(Math.floor(Math.random() * 400 * 86_400));
      const { start, end } = windowAt(t, G, DAY);
      expect(start <= t && t < end).toBe(true);
      expect((start - G) % DAY).toBe(0n);
      expect(end - start).toBe(DAY);
    }
  });
  test("beaconKey = keccak256(abi.encode(asset, uint64 windowStart)); commitment = keccak256(abi.encode(secret, key))", () => {
    const asset = A(0x1234) as Address;
    expect(beaconKey(asset, 77n)).toBe(keccak256(`0x${asset.slice(2).padStart(64, "0")}${(77).toString(16).padStart(64, "0")}` as Hex));
    const secret = keccak256("0x01"); // derived, not a key
    const key = beaconKey(asset, 77n);
    expect(commitmentOf(secret, key)).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [secret, key])));
  });
  test("commit the next `lookahead` windows; reveal only in [start, end - GRACE)", () => {
    expect(windowsToCommit(G, DAY, 2)).toEqual([G + DAY, G + 2n * DAY]);
    expect(revealOpen(G - 1n, G, G + DAY, 3_600n)).toBe(false);
    expect(revealOpen(G, G, G + DAY, 3_600n)).toBe(true);
    expect(revealOpen(G + DAY - 3_601n, G, G + DAY, 3_600n)).toBe(true);
    expect(revealOpen(G + DAY - 3_600n, G, G + DAY, 3_600n)).toBe(false);
  });
});

describe("execute gate mirrors CrowdBuy.execute", () => {
  const ok = { accounts: 3, minCrowd: 3, executedThisWindow: false, executeAfter: 100n, now: 100n, hold: false };
  test("ready exactly at executeAfter with crowd = MIN_CROWD", () => expect(executeBlocker(ok)).toBeNull());
  test("each precondition blocks", () => {
    expect(executeBlocker({ ...ok, accounts: 2 })).toMatch(/crowd/);
    expect(executeBlocker({ ...ok, executedThisWindow: true })).toMatch(/already/);
    expect(executeBlocker({ ...ok, now: 99n })).toMatch(/too early/);
    expect(executeBlocker({ ...ok, hold: true })).toMatch(/hold/);
  });
});

describe("deployment config", () => {
  test("needs vault/crowd/beacon/usdg; Plynth set holds every contract address but not the deployer", () => {
    const dep = { chainId: 31337, deployer: A(1), usdg: A(2), savingsVault: A(3), crowdBuy: A(4), jitterBeacon: A(5), stocks: { mTSLA: { token: A(6) } } };
    const k = keeperDeployment(dep, 31337);
    expect(k.stocks.map((s) => s.toLowerCase())).toEqual([A(6)]);
    expect(k.plynth.has(A(3))).toBe(true);
    expect(k.plynth.has(A(1))).toBe(false);
    expect(k.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(k.multicall3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(() => keeperDeployment({ chainId: 1 }, 1)).toThrow(/savingsVault/);
    expect(() => keeperDeployment(undefined, 1)).toThrow(/no deployments/);
  });
});

describe("ABI matches the compiled contracts (skips if contracts/out is not built)", () => {
  const out = join(ROOT, "contracts", "out");
  const check = (contract: string, abi: readonly any[]) => {
    const f = join(out, `${contract}.sol`, `${contract}.json`);
    if (!existsSync(f)) return console.warn(`skip: ${f} not built`);
    const compiled = JSON.parse(readFileSync(f, "utf8")).abi as any[];
    const fns = new Set(compiled.filter((x) => x.type === "function").map((x) => toFunctionSelector(x)));
    const evs = new Set(compiled.filter((x) => x.type === "event").map((x) => toEventSelector(x)));
    const errs = new Set(compiled.filter((x) => x.type === "error").map((x) => toFunctionSelector(x)));
    for (const x of abi) {
      if (x.type === "function") expect(fns.has(toFunctionSelector(x))).toBe(true);
      if (x.type === "event") expect(evs.has(toEventSelector(x))).toBe(true);
      if (x.type === "error" && !["NoMix"].includes(x.name)) expect(errs.has(toFunctionSelector(x))).toBe(true);
    }
  };
  test("SavingsVault, CrowdBuy, JitterBeacon, StealthClaims, ShieldedPool", () => {
    check("SavingsVault", vaultAbi);
    check("CrowdBuy", crowdAbi);
    check("JitterBeacon", beaconAbi);
    check("StealthClaims", stealthClaimsAbi);
    check("ShieldedPool", shieldedPoolAbi);
  });
});
