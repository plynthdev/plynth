// Pure rules of the deliver-hidden job.
import { beforeAll, describe, expect, test } from "bun:test";
import { commitmentOf, decryptNote, deriveVaultKeys, initVault } from "@plynth/sdk/vault";
import { decodeAbiParameters, getAddress, type Hex } from "viem";
import { keeperDeployment } from "@/keeper/context";
import { hiddenRoute, MODE_HIDDEN, planHiddenNote } from "./hidden";
import { JOBS } from "@/keeper/keeper";

const ASSET = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");

beforeAll(async () => {
  await initVault();
});

describe("Hidden route", () => {
  test("abi.encode(uint8 2, bytes32 blinding, bytes note), the shape CrowdBuy.deliver decodes", () => {
    const r = hiddenRoute(0xb1n, "0xabcd");
    const [mode, blinding, note] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes" }], r);
    expect(mode).toBe(MODE_HIDDEN);
    expect(BigInt(blinding)).toBe(0xb1n);
    expect(note).toBe("0xabcd");
    expect(BigInt(r.slice(0, 66))).toBe(2n); // first word is the mode, as CrowdBuy reads it
  });

  test("planned note opens for the user and commits to the user's registered ownerPk", () => {
    const k = deriveVaultKeys(`0x${"77".repeat(65)}` as Hex);
    const plan = planHiddenNote(ASSET, 12345n, k.ownerPk, k.viewingPub);
    const [, blinding, note] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes" }], plan.route);
    const opened = decryptNote(note, k.viewingSecret)!;
    expect(opened).toEqual({ asset: ASSET, raw: 12345n, blinding: BigInt(blinding) });
    expect(plan.commitment).toBe(commitmentOf(BigInt(ASSET), 12345n, k.ownerPk, BigInt(blinding)));
    // a fresh blinding every time
    expect(planHiddenNote(ASSET, 12345n, k.ownerPk, k.viewingPub).commitment).not.toBe(plan.commitment);
  });
});

describe("wiring", () => {
  test("deliver-hidden runs after deliver-quiet", () => {
    const names = JOBS.map(([n]) => n);
    expect(names.indexOf("deliver-hidden")).toBe(names.length - 1);
    expect(names.indexOf("deliver-quiet")).toBe(names.length - 2);
  });

  test("shieldedPool is optional in the deployment", () => {
    const base = { savingsVault: "0x" + "1".repeat(40), crowdBuy: "0x" + "2".repeat(40), jitterBeacon: "0x" + "3".repeat(40), usdg: "0x" + "4".repeat(40) };
    expect(keeperDeployment(base as any, 31337).shieldedPool).toBeUndefined();
    expect(keeperDeployment({ ...base, shieldedPool: "0x" + "5".repeat(40) } as any, 31337).shieldedPool).toBe(getAddress("0x" + "5".repeat(40)));
  });
});
