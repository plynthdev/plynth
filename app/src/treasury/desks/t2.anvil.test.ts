// End to end on plain anvil (todo 29): the desk-kit treasury moved to a T2 policy through the 48h timelock,
// a BasisSleeve and a PerpSleeve each with their own in-house perp venue (mTSLA market with skew funding).
//   - basis lifecycle with time warps: funding positive but streak short -> hold; 8h later -> open a pair;
//     carry accrues; the crowd flips funding -> the desk closes; the period report counts it as NAV, no rate;
//   - hedge order through the in-house client (guard-checked execute), recorded in the fill ledger;
//   - reconciler over both on-chain venues: clean, then an injected break (a fill the ledger never saw) opens
//     an exceptions row + a signed webhook and the PeriodClose gate refuses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePacked, getAddress, keccak256, encodeAbiParameters, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { basisPeriodReport, BasisSleeveDesk, decideBasis, FundingStreaks } from "./basis";
import { hedgeOnce } from "./hedge";
import { breakGate, MemoryExceptionStore, MemoryLedger, Reconciler } from "@/treasury/reconciler";
import { DrawdownMachine } from "@/treasury/risk/drawdown";
import { Webhooks } from "@/treasury/risk/webhooks";
import { AccountExecutor, basisSleeveAbi, InHouseClient, venueValuerAbi } from "@/treasury/venues";
import { compileTemplate, loadTemplate } from "@/treasury/policy-compiler";
import { dirname } from "node:path";
import { spawnAnvil, type Anvil } from "@/testing/anvil";
import { Kit, ROOT } from "@/testing/treasury-kit";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const KEYS = {
  crowd: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // test-key (anvil #3)
  crowd2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // test-key (anvil #4)
  basis: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // test-key (anvil #5)
  hedge: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // test-key (anvil #6)
} as const;

const policyAbi = parseAbi([
  "struct Band { uint16 minBps; uint16 maxBps; }",
  "struct Policy { Band cash; Band equity; Band basis; int16 netDeltaMinBps; int16 netDeltaMaxBps; uint16 maxLeverageX10; uint64 perOrderCapUsd; uint64 perDayCapUsd; uint16 perNameFloatCapBps; uint16 perVenueCapBps; bool noNewRiskOffHours; int16 pauseNewRiskAtDrawdownBps; int16 deriskAtDrawdownBps; uint64 approvalAboveUsd; uint32 periodSeconds; bytes32 instrumentAllowRoot; bytes32 venueAllowRoot; address controller; }",
  "function current() view returns (Policy, bytes32 hash, uint32 version)",
  "function propose(Policy p)",
  "function activate()",
]);

let anvil: Anvil | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let kit: Kit;
let ready = false;
const a: Record<string, Address> = {};
const proof: Record<string, Hex[]> = {};
const hooks: { type: string; data: Record<string, unknown> }[] = [];

const crowd = privateKeyToAccount(KEYS.crowd);
const crowd2 = privateKeyToAccount(KEYS.crowd2);
const basisKey = privateKeyToAccount(KEYS.basis);
const hedgeKey = privateKeyToAccount(KEYS.hedge);

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "BasisSleeve.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "BasisSleeve.sol"))) return;
  // An OS-assigned port: a random one in a shared range could be another run's anvil (testing/anvil.ts).
  anvil = await spawnAnvil();
  kit = new Kit(anvil.rpc);
  await kit.pub.getChainId();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hooks.push(JSON.parse(await req.text()));
      return new Response("ok");
    },
  });
  const cfgPath = await kit.setup(mkdtempSync(join(tmpdir(), "plynth-t2-")), 100_000n * E6);
  const compiled = compileTemplate(loadTemplate(join(dirname(cfgPath), "policy.yaml")) as never, { controller: kit.deployer.address });
  proof.usdg = compiled.instruments.find((x) => getAddress(x.asset) === getAddress(kit.a.usdg!))!.proof;
  const d = kit.deployer.address;
  const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
  a.tsla = tsla.token;
  // 200 mTSLA of spot ($50k) on the account: NAV $150k, cash 67%, equity 33%.
  await kit.send(tsla.token, "MockStockToken.sol", "MockStockToken", "mint", [kit.a.account, 200n * E18]);

  a.pool = await kit.deploy("PerpPool.sol", "PerpPool", [kit.a.usdg, d, 86_400n]);
  a.market = await kit.deploy("PerpMarket.sol", "PerpMarket", [a.pool, kit.a.valuer, tsla.token, d]);
  await kit.send(a.pool, "PerpPool.sol", "PerpPool", "addMarket", [a.market]);
  await kit.send(a.market, "PerpMarket.sol", "PerpMarket", "setParams", [10n, 0n, 1000n, 0n, 10n ** 13n, 2000n, 10_000n, 5n * E6]);
  await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "mint", [d, 10_000_000n * E6]);
  await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "approve", [a.pool, 2n ** 255n]);
  await kit.send(a.pool, "PerpPool.sol", "PerpPool", "deposit", [10_000_000n * E6, d]);
  for (const c of [crowd, crowd2]) {
    await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "mint", [c.address, 1_000_000n * E6]);
    await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "approve", [a.pool, 2n ** 255n], c);
  }

  a.basis = await kit.deploy("BasisSleeve.sol", "BasisSleeve", [kit.a.account, kit.a.usdg, kit.a.valuer]);
  a.basisVenue = await kit.deploy("InHousePerpVenue.sol", "InHousePerpVenue", [a.basis, a.pool, [a.market]]);
  a.perp = await kit.deploy("PerpSleeve.sol", "PerpSleeve", [kit.a.account, kit.a.usdg, 0]);
  a.hedgeVenue = await kit.deploy("InHousePerpVenue.sol", "InHousePerpVenue", [a.perp, a.pool, [a.market]]);
  await kit.send(a.basis, "BasisSleeve.sol", "BasisSleeve", "addVenue", [a.basisVenue]);
  await kit.send(a.perp, "PerpSleeve.sol", "PerpSleeve", "addVenue", [a.hedgeVenue]);
  await kit.send(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("basis", { size: 32 }), basisKey.address, [a.basis]]);
  await kit.send(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("hedge", { size: 32 }), hedgeKey.address, [a.perp]]);
  for (const k of [basisKey, hedgeKey]) {
    const tx = await kit.wallet(kit.deployer).sendTransaction({ to: k.address, value: E18 });
    await kit.pub.waitForTransactionReceipt({ hash: tx });
  }
  for (const k of Object.keys(a)) a[k] = getAddress(a[k]!);

  // T2 through the timelock: both venues allowed (two-leaf tree), basis band 0..20%, leverage <= 3x.
  const leafB = keccak256(encodeAbiParameters([{ type: "address" }], [a.basisVenue!]));
  const leafH = keccak256(encodeAbiParameters([{ type: "address" }], [a.hedgeVenue!]));
  const root = keccak256(BigInt(leafB) < BigInt(leafH) ? encodePacked(["bytes32", "bytes32"], [leafB, leafH]) : encodePacked(["bytes32", "bytes32"], [leafH, leafB]));
  proof.basis = [leafH];
  proof.hedge = [leafB];
  const [p] = await kit.pub.readContract({ address: kit.a.policy!, abi: policyAbi, functionName: "current" });
  const t2 = { ...p, basis: { minBps: 0, maxBps: 2000 }, netDeltaMinBps: -2000, netDeltaMaxBps: 6000, maxLeverageX10: 30, perOrderCapUsd: 1_000_000n, perDayCapUsd: 5_000_000n, perVenueCapBps: 2000, approvalAboveUsd: 1_000_000n, venueAllowRoot: root };
  const w = kit.wallet(kit.deployer);
  await kit.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: kit.a.policy!, abi: policyAbi, functionName: "propose", args: [t2] }) });
  await kit.warpTo((await kit.now()) + 48n * 3600n + 1n);
  await kit.refreshFeeds();
  await kit.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: kit.a.policy!, abi: policyAbi, functionName: "activate" }) });
  ready = true;
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  await anvil?.stop();
});

const ledger = new MemoryLedger();
const store = new MemoryExceptionStore();

async function crowdTrade(who: typeof crowd, isLong: boolean, sizeUsd: bigint) {
  const pos = await kit.read<{ size: bigint }>(a.market!, "PerpMarket.sol", "PerpMarket", "position", [who.address]);
  if (pos.size !== 0n) await kit.send(a.market!, "PerpMarket.sol", "PerpMarket", "close", [], who);
  await kit.send(a.market!, "PerpMarket.sol", "PerpMarket", "open", [isLong, sizeUsd, sizeUsd / 5n, 100n], who);
}

describe("T2 desks on anvil", () => {
  test("basis lifecycle: streak -> open -> carry -> flip -> close -> period report; hedge; reconciler break blocks the close", async () => {
    if (!ready) return;
    const execB = new AccountExecutor(kit.pub, kit.wallet(basisKey), basisKey, kit.chain, kit.a.account!, "basis");
    const desk = new BasisSleeveDesk(kit.pub, execB, a.basis!, kit.a.usdg!, proof.basis, proof.usdg);
    const basisClient = new InHouseClient(kit.pub, { venue: a.basisVenue!, valuer: kit.a.valuer!, usdg: kit.a.usdg! });
    const streaks = new FundingStreaks();
    const dd = new DrawdownMachine();
    const key = `${a.basisVenue}:${a.tsla}`;
    const t0 = await kit.now();

    // The crowd is long: longs pay (needs both sides open, so crowd2 holds a small short to start).
    await crowdTrade(crowd2, false, 20_000n * E6);
    await crowdTrade(crowd, true, 500_000n * E6);

    const inputs = async () => {
      const [rate] = (await basisClient.funding()).map((f) => f.ratePerSecond);
      const now = Number(await kit.now());
      const streakSec = streaks.observe(key, now, rate!);
      const q = await kit.pub.readContract({ address: kit.a.valuer!, abi: venueValuerAbi, functionName: "quote", args: [a.tsla!] });
      const [notional, nav] = await kit.pub.readContract({ address: a.basis!, abi: basisSleeveAbi, functionName: "venueNotional", args: [0n] });
      const size = 10_000n * E18;
      return {
        fundingRate: rate!,
        streakSec,
        openPairId: await desk.openPairId(0, a.tsla!),
        drawdown: dd.step({ nav, periodStartNav: 0n, pauseBps: -400, deriskBps: -800 }).state,
        offHours: q.hold,
        depthOk: true, // the kit's mock pool has no quoter; depthOk() is unit-tested, quoteSpotSell runs on a fork
        floatRoom: true,
        venueRoom: (notional + size) * 10_000n <= nav * 2000n,
        capBreached: false,
      };
    };

    let i = await inputs();
    expect(i.fundingRate > 0n).toBe(true);
    expect(decideBasis(i, {})).toEqual({ action: "hold", reason: "funding_streak_short" });

    await kit.warpTo(t0 + 8n * 3600n + 60n);
    await kit.refreshFeeds();
    i = await inputs();
    expect(decideBasis(i, {})).toEqual({ action: "open", reason: "funding_positive" });
    const opened = await desk.open(0, a.tsla!, 10_000n * E6, 5_000n * E6, 100);
    expect(opened.ok, JSON.stringify(opened, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
    const pair0 = (await desk.pairs())[0]!;
    expect(pair0.perpTokens).toBe(40n * E18); // $10k at $250
    await ledger.record(31337, kit.a.account!, { venue: basisClient.name, underlying: a.tsla!, desk: "basis", tokens: -pair0.perpTokens });
    expect(await kit.pub.readContract({ address: a.basis!, abi: basisSleeveAbi, functionName: "pairDelta", args: [0n] })).toBe(0n);

    // A guard-rejected open is a rejection, not a revert: a second pair on the same name is refused.
    const dup = await desk.open(0, a.tsla!, 10_000n * E6, 5_000n * E6, 100);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.rejection.reason).toBe("PairExists");

    // 6 more hours of positive funding: carry is positive and the desk keeps carrying.
    await kit.warpTo((await kit.now()) + 6n * 3600n);
    await kit.refreshFeeds();
    const carry = await kit.pub.readContract({ address: a.basis!, abi: basisSleeveAbi, functionName: "pairCarry", args: [0n] });
    expect(carry > 0n).toBe(true);
    i = await inputs();
    expect(decideBasis(i, {})).toEqual({ action: "hold", reason: "carrying" });

    // The crowd flips: shorts pay now. The desk closes.
    await crowdTrade(crowd, false, 300_000n * E6);
    await crowdTrade(crowd2, true, 20_000n * E6);
    i = await inputs();
    expect(i.fundingRate < 0n).toBe(true);
    expect(decideBasis(i, {})).toEqual({ action: "close", reason: "funding_flip" });
    const closed = await desk.close(i.openPairId!);
    expect(closed.ok, JSON.stringify(closed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
    await ledger.record(31337, kit.a.account!, { venue: basisClient.name, underlying: a.tsla!, desk: "basis", tokens: pair0.perpTokens });
    const pair = (await desk.pairs())[0]!;
    expect(pair.closedAt > 0n).toBe(true);
    const report = basisPeriodReport(await desk.pairs(), t0, (await kit.now()) + 1n);
    expect(report.pairsClosed).toBe(1);
    expect(report.navContributionUsd).toBe(pair.cumulativeFundingUsd);
    expect(report.navContributionUsd > 0n).toBe(true); // 6h+ of funding beat the two 10 bps fees

    // Hedge desk: net delta 33% is above a 0..25% band here, so it shorts through the in-house client.
    const execH = new AccountExecutor(kit.pub, kit.wallet(hedgeKey), hedgeKey, kit.chain, kit.a.account!, "hedge");
    const hedgeClient = new InHouseClient(kit.pub, { venue: a.hedgeVenue!, valuer: kit.a.valuer!, usdg: kit.a.usdg!, sleeve: a.perp!, venueIdx: 0, venueProof: proof.hedge!, executor: execH });
    const q = await kit.pub.readContract({ address: kit.a.valuer!, abi: venueValuerAbi, functionName: "quote", args: [a.tsla!] });
    const [nav] = await kit.read<[bigint, boolean]>(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "navUsd");
    const h = await hedgeOnce(
      { navUsd: nav, stockUsd: (200n * q.priceUsdPerToken), perpDeltaUsd: 0n, band: { minBps: 0, maxBps: 2500 }, offHours: false, shortTokens: 0n, priceUsd: q.priceUsdPerToken },
      { underlying: a.tsla! },
      hedgeClient,
      (f) => ledger.record(31337, kit.a.account!, f),
    );
    expect(h.decision.action).toBe("short_more");
    const hs = await hedgeClient.statement();
    expect(hs.positions).toEqual([{ underlying: a.tsla!, tokens: -h.order!.tokens }]);

    // Reconciler over both on-chain venues: clean.
    const webhooks = new Webhooks({ urls: [`http://127.0.0.1:${server!.port}/hook`], secret: "test", backoffMs: 5 });
    const rec = new Reconciler(kit.pub, { chainId: 31337, account: kit.a.account!, venues: [{ client: basisClient, mode: "onchain" }, { client: hedgeClient, mode: "onchain" }] }, { store, ledger, webhooks });
    const r1 = await rec.run();
    expect(r1.breaks).toEqual([]);

    // Injected break: a second hedge order whose fill never reaches the ledger.
    await hedgeClient.placeOrder({ underlying: a.tsla!, side: "sell", tokens: 2n * E18, reduceOnly: false, maxSlippageBps: 100 });
    const r2 = await rec.run();
    expect(r2.newBreaks).toHaveLength(1);
    expect(r2.newBreaks[0]).toMatchObject({ kind: "reconcile.position", venue: a.hedgeVenue, underlying: a.tsla });
    expect(hooks.filter((x) => x.type === "reconcile.break")).toHaveLength(1);
    expect(await breakGate(store, 31337, kit.a.account!).count()).toBe(1);
  }, 180_000);
});
