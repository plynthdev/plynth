// review6 R6-SVC-1 regression (PoC: app/src/review6x/keeper-sweep-untrusted.test.ts on the review branch). The venue
// sweep used to read `sleeve()` from whatever position owner a Displaced event or a closed position named and send
// `sweepVenueIdle` to it at estimate + 20% with no cap. It now sweeps only a sleeve whose account is a treasury of a
// deployment TreasuryFactory, listed by that account, listing the venue, with the deployment's USDG, and caps the gas.
import { expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { sweepDisplaced, sweepVenueIdleOf, VENUE_SWEEP_MAX_GAS } from "@/keeper/jobs/venue-sweep";
import { treasuryFactoriesOf, type Ctx, type JobResult } from "@/keeper/context";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const USDG = A(0x05d), FACTORY = A(0xfac), TREASURY = A(0x7ea), SLEEVE = A(0x5e1), VENUE = A(0x7e1);

type World = { venueSleeve: Address; venueCash: Address; sleeveAccount: Address; treasuries: Address[]; sleevesOf: Address[]; venuesOf: Address[] };

function ctxWith(w: World, logs: Address[]) {
  const sent: { to: Address; fn: string; args: unknown[]; opts: unknown }[] = [];
  const pub = {
    getBlockNumber: async () => 1_000n,
    getLogs: async () => logs.map((account) => ({ args: { account } })),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
      if (functionName === "sleeve") return w.venueSleeve;
      if (functionName === "cash") return w.venueCash;
      if (functionName === "account") return w.sleeveAccount;
      if (functionName === "isTreasury") return address === FACTORY && w.treasuries.includes(args[0] as Address);
      if (functionName === "isSleeve") return address === TREASURY && w.sleevesOf.includes(args[0] as Address);
      if (functionName === "isVenue") return address === SLEEVE && w.venuesOf.includes(args[0] as Address);
      if (functionName === "balanceOf") return address === USDG ? 1_000_000n : 1n;
      throw new Error("execution reverted");
    },
    simulateContract: async () => ({ result: 0n }),
  };
  const sender = {
    sendCall: async (to: Address, _abi: unknown, fn: string, args: unknown[], _label: string, opts: unknown) => {
      sent.push({ to, fn, args, opts });
      return { transactionHash: "0x01" };
    },
  };
  const ctx = { account: A(0xbeef), pub, sender, dep: { perpMarkets: [A(0x901)], usdg: USDG, treasuryFactories: [FACTORY] }, log: () => {} } as unknown as Ctx;
  return { ctx, sent };
}

const legit: World = { venueSleeve: SLEEVE, venueCash: USDG, sleeveAccount: TREASURY, treasuries: [TREASURY], sleevesOf: [SLEEVE], venuesOf: [VENUE] };

test("R6-SVC-1: a displaced attacker contract naming its own sleeve gets no keeper transaction", async () => {
  const attacker = A(0xa77ac), evil = A(0xe0115);
  // the attacker's position answers like a venue, its sleeve claims a real treasury as its account
  const { ctx, sent } = ctxWith({ ...legit, venueSleeve: evil }, [attacker]);
  const res: JobResult = { job: "liquidate", ok: true, actions: 0, notes: [] };
  await sweepDisplaced(ctx, res);
  expect(await sweepVenueIdleOf(ctx, attacker)).toBe("none");
  expect(sent).toEqual([]);
});

test("R6-SVC-1: each link is checked (factory, account's sleeve list, sleeve's venue list, USDG)", async () => {
  for (const w of [
    { ...legit, treasuries: [] }, // not a factory treasury
    { ...legit, sleevesOf: [] }, // the account does not list the sleeve
    { ...legit, venuesOf: [] }, // the sleeve does not list the venue
    { ...legit, venueCash: A(0xbad) }, // the venue's cash is an attacker token
  ]) {
    const { ctx, sent } = ctxWith(w, []);
    expect(await sweepVenueIdleOf(ctx, VENUE)).toBe("none");
    expect(sent).toEqual([]);
  }
  const none = ctxWith(legit, []);
  (none.ctx.dep as any).treasuryFactories = [];
  expect(await sweepVenueIdleOf(none.ctx, VENUE)).toBe("none");
});

test("R6-SVC-1: a real treasury venue is swept, with the gas cap", async () => {
  const { ctx, sent } = ctxWith(legit, [VENUE]);
  const res: JobResult = { job: "liquidate", ok: true, actions: 0, notes: [] };
  await sweepDisplaced(ctx, res);
  expect(sent).toEqual([{ to: SLEEVE, fn: "sweepVenueIdle", args: [VENUE], opts: { maxGas: VENUE_SWEEP_MAX_GAS } }]);
  expect(res.actions).toBe(1);
});

test("treasuryFactoriesOf: current plus legacy, deduplicated, zero dropped", () => {
  const f2 = "0x" + "2".repeat(40);
  expect(treasuryFactoriesOf({ treasuryFactory: FACTORY, legacyTreasuryFactories: [f2, FACTORY, "0x" + "0".repeat(40)] } as any)).toEqual([FACTORY, getAddress(f2)]);
  expect(treasuryFactoriesOf({} as any)).toEqual([]);
});
