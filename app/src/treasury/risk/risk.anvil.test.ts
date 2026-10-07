// End to end on plain anvil: the desk kit treasury plus a PerpSleeve with an in-house venue and an off-chain
// venue mirrored by the risk service. The service signs and posts PositionMirror snapshots as the policy
// controller, the guard counts them in NAV and net delta, a drawdown moves the state machine and fires a signed
// `drawdown.state` webhook, and a mirror left alone for 10 minutes turns into a `venue.stale` alert.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, stringToHex, type Address } from "viem";
import { guardAbi } from "@/abi/treasury-desks";
import { MirrorPusher, positionMirrorAbi, RiskService, StaticVenueReader, valuerQuoteAbi, Webhooks } from "./";
import { Kit, ROOT } from "@/testing/treasury-kit";

const PORT = 9550 + Math.floor(Math.random() * 50);
const RPC = `http://127.0.0.1:${PORT}`;
const E18 = 10n ** 18n;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let kit: Kit;
let ready = false;
const hooks: { type: string; data: Record<string, unknown> }[] = [];
const a: Record<string, Address> = {};

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "PositionMirror.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "PositionMirror.sol"))) return;
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  kit = new Kit(RPC);
  for (let i = 0; i < 100; i++) {
    try {
      await kit.pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hooks.push(JSON.parse(await req.text()));
      return new Response("ok");
    },
  });
  await kit.setup(mkdtempSync(join(tmpdir(), "plynth-risk-")), 100_000n * 10n ** 6n);
  const d = kit.deployer.address;
  const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
  a.tsla = tsla.token;
  a.mirror = await kit.deploy("PositionMirror.sol", "PositionMirror", [kit.a.policy]);
  a.sleeve = await kit.deploy("PerpSleeve.sol", "PerpSleeve", [kit.a.account, kit.a.usdg, 0]);
  a.pool = await kit.deploy("PerpPool.sol", "PerpPool", [kit.a.usdg, d, 86_400n]);
  a.market = await kit.deploy("PerpMarket.sol", "PerpMarket", [a.pool, kit.a.valuer, tsla.token, d]);
  await kit.send(a.pool, "PerpPool.sol", "PerpPool", "addMarket", [a.market]);
  a.inHouse = await kit.deploy("InHousePerpVenue.sol", "InHousePerpVenue", [a.sleeve, a.pool, [a.market]]);
  a.off = await kit.deploy("MirroredPerpVenue.sol", "MirroredPerpVenue", [a.sleeve, kit.a.usdg, a.mirror, getAddress("0x00000000000000000000000000000000000c0570")]);
  await kit.send(a.sleeve, "PerpSleeve.sol", "PerpSleeve", "addVenue", [a.inHouse]);
  await kit.send(a.sleeve, "PerpSleeve.sol", "PerpSleeve", "addVenue", [a.off]);
  await kit.send(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("hedge", { size: 32 }), kit.cashKey.address, [a.sleeve]]);
  for (const k of Object.keys(a)) a[k] = getAddress(a[k]!);
  ready = true;
}, 120_000);

afterAll(async () => {
  server?.stop(true);
  anvil?.kill();
  await anvil?.exited;
});

describe("risk service on anvil", () => {
  test("mirror push, NAV with venue equity, drawdown webhook, stale alert", async () => {
    if (!ready) return;
    const reader = new StaticVenueReader(a.off!, { positions: [{ underlying: a.tsla!, tokens: -10n * E18 }], equityUsd: 3_000n * E18, flowInSeen: 0n });
    const wallet = kit.wallet(kit.deployer); // the kit policy's controller is the deployer
    const pusher = new MirrorPusher(kit.pub, wallet, kit.deployer, a.mirror!);
    const webhooks = new Webhooks({ urls: [`http://127.0.0.1:${server!.port}/hook`], secret: "test", backoffMs: 5 });
    const svc = new RiskService(kit.pub, { account: kit.a.account!, readers: [reader] }, { pusher, webhooks });

    const navBefore = (await kit.pub.readContract({ address: kit.a.guard!, abi: guardAbi, functionName: "snapshot", args: [kit.a.account!] })).nav;
    const r1 = await svc.tick();
    expect(r1.pushes).toEqual([expect.objectContaining({ venue: a.off, posted: true })]);
    const [pos, eq, , ts] = await kit.pub.readContract({ address: a.mirror!, abi: positionMirrorAbi, functionName: "latest", args: [a.off!] });
    expect(pos).toEqual([{ underlying: a.tsla!, tokens: -10n * E18 }]);
    expect(eq).toBe(3_000n * E18);
    expect(ts).toBe(r1.pushes[0]!.ts!);

    // NAV includes the mirrored venue's equity; the short shows up in net delta and per name.
    expect(r1.navUsd).toBe(navBefore + 3_000n * E18);
    const [tenTsla] = await kit.pub.readContract({ address: kit.a.valuer!, abi: valuerQuoteAbi, functionName: "value", args: [a.tsla!, 10n * E18] });
    const snap = await kit.pub.readContract({ address: kit.a.guard!, abi: guardAbi, functionName: "snapshot", args: [kit.a.account!] });
    expect(snap.perpDeltaUsd).toBe(-tenTsla);
    expect(snap.venues.map((v) => v.venue)).toEqual([a.inHouse!, a.off!]);
    const off = r1.exposure.venues.find((v) => v.venue === a.off)!;
    expect(off).toMatchObject({ equityUsd: 3_000n * E18, grossUsd: tenTsla, stale: false });
    expect(r1.exposure.names.find((n) => n.underlying === a.tsla)!.perpUsd).toBe(-tenTsla);
    // The kit runs a T1 policy: any venue exposure is over its (zero) cap, and the service says so.
    expect(r1.newAlerts.map((x) => x.kind)).toContain("venue.overCap");
    expect(r1.drawdown).toMatchObject({ state: "normal", from: null, changed: true });

    // A period start 5% above NAV: paused (-4% threshold in the balanced template).
    const pc = await kit.deploy("TreasuryMocks.sol", "MockPeriodClose");
    await kit.send(pc, "TreasuryMocks.sol", "MockPeriodClose", "set", [(r1.navUsd * 105n) / 100n]);
    await kit.send(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "setPeriodClose", [pc]);
    const r2 = await svc.tick();
    expect(r2.pushes[0]).toMatchObject({ posted: false, reason: "fresh" });
    expect(r2.drawdown).toMatchObject({ state: "paused", from: "normal", changed: true, ddBps: -476 });
    const dd = hooks.filter((h) => h.type === "drawdown.state");
    expect(dd.map((h) => h.data.to)).toEqual(["normal", "paused"]);
    expect(dd[1]!.data.ddBps).toBe(-476);

    // Nobody refreshes the mirror for 10 minutes: the venue goes stale and the alert fires once.
    const quiet = new RiskService(kit.pub, { account: kit.a.account! }, { webhooks });
    await quiet.tick();
    await kit.warpTo((await kit.now()) + 601n);
    await kit.refreshFeeds();
    const r3 = await quiet.tick();
    expect(r3.exposure.venues.find((v) => v.venue === a.off)!.stale).toBe(true);
    expect(r3.newAlerts.map((x) => x.kind)).toContain("venue.stale");
    const r4 = await quiet.tick();
    expect(r4.newAlerts.map((x) => x.kind)).not.toContain("venue.stale");
    expect(hooks.filter((h) => h.type === "risk.alert" && h.data.kind === "venue.stale").length).toBe(1);

    // The pushing service brings it back.
    const r5 = await svc.tick();
    expect(r5.pushes[0]).toMatchObject({ posted: true });
    expect(r5.exposure.venues.find((v) => v.venue === a.off)!.stale).toBe(false);
  }, 120_000);
});
