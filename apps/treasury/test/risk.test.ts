// Unit tests for the risk service parts: drawdown state machine, exposure, funding-sign watch, webhooks,
// mirror typed data, and the hand-written ABIs against contracts/out.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverTypedDataAddress, toFunctionSelector, type Abi, type AbiFunction, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  classify,
  computeExposure,
  DrawdownMachine,
  drawdownBps,
  FundingWatch,
  mirrorDomain,
  perpMarketAbi,
  perpSleeveAbi,
  perpVenueAbi,
  positionMirrorAbi,
  rawState,
  riskAccountAbi,
  riskGuardAbi,
  riskPolicyAbi,
  sign,
  signedRate,
  signSnapshot,
  SNAPSHOT_TYPES,
  valuerQuoteAbi,
  Webhooks,
} from "../risk";
import { GUARD_CODES } from "../desks/errors";

const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("drawdown state machine", () => {
  const P = -400;
  const D = -800;
  const step = (m: DrawdownMachine, navPct: number, start = usd(1_000_000)) =>
    m.step({ nav: (start * BigInt(Math.round(navPct * 100))) / 10_000n, periodStartNav: start, pauseBps: P, deriskBps: D });

  test("same arithmetic and thresholds as PolicyGuard rule 8", () => {
    expect(drawdownBps(usd(950_000), usd(1_000_000))).toBe(-500);
    expect(drawdownBps(usd(1), 0n)).toBeNull();
    expect(rawState(-400, P, D)).toBe("paused"); // <= is inclusive, like the guard
    expect(rawState(-399, P, D)).toBe("normal");
    expect(rawState(-800, P, D)).toBe("derisk");
    expect(rawState(null, P, D)).toBe("normal");
  });

  test("worsening applies at once, improving needs the hysteresis", () => {
    const m = new DrawdownMachine(50);
    expect(step(m, 100)).toMatchObject({ state: "normal", changed: true, from: null });
    expect(step(m, 99)).toMatchObject({ state: "normal", changed: false });
    expect(step(m, 96)).toMatchObject({ state: "paused", changed: true, from: "normal", ddBps: -400 });
    expect(step(m, 96.2)).toMatchObject({ state: "paused", changed: false }); // -380 > -400 but not by 50
    expect(step(m, 91.9)).toMatchObject({ state: "derisk", changed: true, from: "paused" });
    expect(step(m, 92.3)).toMatchObject({ state: "derisk", changed: false }); // -770: inside the hysteresis
    expect(step(m, 92.6)).toMatchObject({ state: "paused", changed: true, from: "derisk" }); // -740
    expect(step(m, 95.6)).toMatchObject({ state: "paused", changed: false }); // -440
    expect(step(m, 96.6)).toMatchObject({ state: "normal", changed: true, from: "paused" }); // -340
    // From derisk straight to normal when the NAV jumps back.
    step(m, 90);
    expect(step(m, 99)).toMatchObject({ state: "normal", from: "derisk" });
  });

  test("a new period re-evaluates without hysteresis", () => {
    const m = new DrawdownMachine(50);
    step(m, 96);
    expect(m.state).toBe("paused");
    expect(step(m, 100, usd(960_000))).toMatchObject({ state: "normal", changed: true });
  });
});

describe("exposure", () => {
  const limits = { netDeltaMinBps: 1000, netDeltaMaxBps: 4500, maxLeverageX10: 30, perVenueCapBps: 2000 };
  const aapl = A(0xaa);
  const tsla = A(0x75);

  test("per-venue and per-name numbers", () => {
    const nav = usd(1_000_000);
    const x = computeExposure(
      nav,
      [{ asset: aapl, usd: usd(400_000) }, { asset: tsla, usd: 0n }],
      [
        { venue: A(1), equityUsd: usd(100_000), grossUsd: usd(250_000), stale: false, positions: [{ underlying: aapl, tokens: -1250n * E18, usd: -usd(250_000) }] },
        { venue: A(2), equityUsd: usd(250_000), grossUsd: usd(1_000_000), stale: true, positions: [{ underlying: tsla, tokens: 100n * E18, usd: usd(1_000_000) }] },
      ],
      limits,
    );
    expect(x.venues[0]).toMatchObject({ weightBps: 1000, leverageX10: 25, overCap: false, overLeverage: false });
    expect(x.venues[1]).toMatchObject({ weightBps: 2500, leverageX10: 40, overCap: true, overLeverage: true, stale: true });
    const byName = Object.fromEntries(x.names.map((n) => [n.underlying, n]));
    expect(byName[aapl]).toMatchObject({ spotUsd: usd(400_000), perpUsd: -usd(250_000), netUsd: usd(150_000), weightBps: 1500 });
    expect(byName[tsla]).toMatchObject({ netUsd: usd(1_000_000), weightBps: 10_000 });
    expect(x.netDeltaBps).toBe(11_500);
    expect(x.netDeltaInBand).toBe(false);
  });

  test("T1 policy: no overlay band", () => {
    const x = computeExposure(usd(100), [{ asset: aapl, usd: usd(40) }], [], { ...limits, maxLeverageX10: 0 });
    expect(x.netDeltaBps).toBe(4000);
    expect(x.netDeltaInBand).toBeNull();
  });
});

describe("funding-sign watch", () => {
  const v = A(1);
  const u = A(0xaa);
  test("classify: who pays", () => {
    expect(classify({ venue: v, underlying: u, ourSide: "short", ratePerSecond: -(10n ** 12n) }).wePay).toBe(true); // shorts pay
    expect(classify({ venue: v, underlying: u, ourSide: "short", ratePerSecond: 10n ** 12n }).wePay).toBe(false);
    expect(classify({ venue: v, underlying: u, ourSide: "long", ratePerSecond: 10n ** 12n }).wePay).toBe(true);
    expect(classify({ venue: v, underlying: u, ourSide: "long", ratePerSecond: 0n }).wePay).toBe(false);
    // 2.78e11/s ~ 0.1%/h = 10 bps/h
    expect(classify({ venue: v, underlying: u, ourSide: "long", ratePerSecond: 278_000_000_000n }).ratePerHourBps).toBe(10);
    expect(signedRate(5n, true)).toBe(5n);
    expect(signedRate(5n, false)).toBe(-5n);
  });

  test("adverse and flip events fire once on the transition", () => {
    const w = new FundingWatch();
    const r = (rate: bigint) => [{ venue: v, underlying: u, ourSide: "short" as const, ratePerSecond: rate }];
    expect(w.update(r(10n)).events).toEqual([]); // longs pay: we receive
    const flip = w.update(r(-10n)).events.map((e) => e.kind).sort();
    expect(flip).toEqual(["adverse", "flip"]);
    expect(w.update(r(-12n)).events).toEqual([]); // still paying: no repeat
    expect(w.update(r(0n)).events).toEqual([]);
    expect(w.update(r(-1n)).events.map((e) => e.kind)).toEqual(["adverse"]); // from zero: adverse, not a flip
    w.update([]); // position closed: forgotten
    expect(w.update(r(-1n)).events.map((e) => e.kind)).toEqual(["adverse"]);
  });
});

describe("webhooks", () => {
  test("signed JSON body, retries 5xx, stops on 4xx", async () => {
    const got: { body: string; sig: string | null }[] = [];
    let fail = 2;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/bad") return new Response("no", { status: 400 });
        const body = await req.text();
        got.push({ body, sig: req.headers.get("x-plinth-signature") });
        if (fail-- > 0) return new Response("later", { status: 503 });
        return new Response("ok");
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const wh = new Webhooks({ urls: [`${base}/hook`, `${base}/bad`], secret: "s3cret", retries: 3, backoffMs: 5 });
      const [ok, bad] = await wh.emit({ type: "drawdown.state", data: { to: "paused", navUsd: 5n * E18 } });
      expect(ok).toMatchObject({ ok: true, status: 200, attempts: 3 });
      expect(bad).toMatchObject({ ok: false, status: 400, attempts: 1 });
      const last = got[got.length - 1]!;
      const parsed = JSON.parse(last.body);
      expect(parsed.type).toBe("drawdown.state");
      expect(parsed.data).toEqual({ to: "paused", navUsd: "5000000000000000000" });
      expect(last.sig).toBe(`sha256=${createHmac("sha256", "s3cret").update(last.body).digest("hex")}`);
      expect(sign("s3cret", last.body)).toBe(last.sig!);
    } finally {
      server.stop(true);
    }
  });

  test("network errors are retried and reported", async () => {
    let calls = 0;
    const wh = new Webhooks({
      urls: ["http://127.0.0.1:9/x"],
      retries: 1,
      backoffMs: 1,
      fetchImpl: (async () => {
        calls++;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const [d] = await wh.emit({ type: "risk.alert", data: {} });
    expect(d).toMatchObject({ ok: false, status: null, attempts: 2, error: "ECONNREFUSED" });
    expect(calls).toBe(2);
  });
});

describe("mirror typed data", () => {
  test("the controller signature recovers to the controller", async () => {
    const ctrl = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // test-key (anvil #0)
    const mirror = A(0x1234);
    const s = await signSnapshot(ctrl, 31337, mirror, A(9), { positions: [{ underlying: A(0xaa), tokens: -5n * E18 }], equityUsd: usd(10), flowInSeen: 7n }, 1_800_000_000n);
    const who = await recoverTypedDataAddress({
      domain: mirrorDomain(31337, mirror),
      types: SNAPSHOT_TYPES,
      primaryType: "Snapshot",
      message: { venue: s.venue, positions: s.positions, equityUsd: s.equityUsd, flowInSeen: s.flowInSeen, ts: s.ts },
      signature: s.signature,
    });
    expect(who).toBe(ctrl.address);
  });
});

describe("guard reason codes", () => {
  test("rules 5-6 codes have names", () => {
    expect(GUARD_CODES[12]).toBe("R5_NET_DELTA");
    expect(GUARD_CODES[13]).toBe("R5_LEVERAGE");
    expect(GUARD_CODES[14]).toBe("R6_VENUE_NOT_ALLOWED");
    expect(GUARD_CODES[15]).toBe("R6_VENUE_CAP");
    expect(GUARD_CODES[16]).toBe("R6_STALE_VENUE");
  });
});

describe("risk ABIs match contracts/out", () => {
  const OUT = join(import.meta.dir, "..", "..", "..", "contracts", "out");
  let ready = false;
  beforeAll(() => {
    if (!existsSync(join(OUT, "PositionMirror.sol"))) {
      const forge = Bun.which("forge");
      if (forge) Bun.spawnSync([forge, "build", "--root", join(OUT, "..")], { stdout: "ignore", stderr: "ignore" });
    }
    ready = existsSync(join(OUT, "PositionMirror.sol"));
  });
  const art = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).abi as Abi;
  const sels = (abi: Abi) => new Set(abi.filter((i) => i.type === "function").map((i) => toFunctionSelector(i as AbiFunction)));
  const subset = (mine: Abi, theirs: Abi[]) => {
    const all = new Set<string>();
    for (const t of theirs) for (const s of sels(t)) all.add(s);
    for (const i of mine) if (i.type === "function") expect(all.has(toFunctionSelector(i as AbiFunction)), (i as AbiFunction).name).toBe(true);
  };

  test("every selector exists", () => {
    if (!ready) return;
    subset(positionMirrorAbi, [art("PositionMirror.sol", "PositionMirror")]);
    subset(perpSleeveAbi, [art("PerpSleeve.sol", "PerpSleeve")]);
    subset(
      perpVenueAbi.filter((i) => i.type === "function" && i.name !== "flowIn" && i.name !== "markets"),
      [art("IPerpVenue.sol", "IPerpVenue")],
    );
    subset(perpVenueAbi.filter((i) => i.type === "function" && i.name === "flowIn"), [art("MirroredPerpVenue.sol", "MirroredPerpVenue")]);
    subset(perpVenueAbi.filter((i) => i.type === "function" && i.name === "markets"), [art("InHousePerpVenue.sol", "InHousePerpVenue")]);
    subset(perpMarketAbi, [art("PerpMarket.sol", "PerpMarket")]);
    subset(riskAccountAbi, [art("TreasuryAccount.sol", "TreasuryAccount")]);
    subset(riskPolicyAbi, [art("TreasuryPolicy.sol", "TreasuryPolicy")]);
    subset(riskGuardAbi, [art("PolicyGuard.sol", "PolicyGuard")]);
    subset(valuerQuoteAbi, [art("Valuer.sol", "Valuer")]);
  });
});
