// Unit tests for the model jury (todo 26): the rule juror's guard arithmetic, model jurors over a mocked
// Ollama (msw), the tally, the verdict bundle hash, rules-only fallback and the board API handler.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { keccak256, toBytes, type Hex } from "viem";
import { canonicalJson } from "../close/bundle";
import { juryApi } from "../jury/api";
import { askJuror, MAX_ATTEMPTS, parseJurorAnswer, SYSTEM_PROMPT, userPrompt } from "../jury/ollama";
import { bandOk, drawdownBps, project, ruleJuror, WAD, weightWad } from "../jury/rules";
import { JuryService } from "../jury/service";
import type { JurorResult } from "../jury/types";
import { buildBundle, cidMatches, encodeBundle, tally } from "../jury/verdict";
import { exceptionReq, MemoryJuryStore, usd } from "./jury.fixtures";

const HOST = "http://127.0.0.1:9597"; // never listened on: msw answers in-process
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const answer = (o: unknown) => HttpResponse.json({ model: "m", message: { role: "assistant", content: typeof o === "string" ? o : JSON.stringify(o) }, done: true });
const up = () => http.get(`${HOST}/api/version`, () => HttpResponse.json({ version: "test" }));
const vote = (recommend: string, confidence = 0.8) => ({ recommend, confidence, reasons: [`${recommend} because`] });
/** Each model answers from its own queue of responses (one per call). */
function chat(byModel: Record<string, (Response | object | string)[]>, seen: { model: string; body: any }[] = []) {
  return http.post(`${HOST}/api/chat`, async ({ request }) => {
    const body = (await request.json()) as any;
    seen.push({ model: body.model, body });
    const next = byModel[body.model]?.shift();
    if (next === undefined) return HttpResponse.json({ error: "model not found" }, { status: 404 });
    return next instanceof Response ? next : answer(next);
  });
}
const svc = (log: string[] = [], models = ["a", "b", "c"]) => new JuryService({ ollama: { host: HOST }, models, log: (m) => log.push(m), now: () => new Date("2026-10-04T00:00:00Z") });

// ------------------------------------------------------------------------------------------- rule juror

describe("rule juror", () => {
  test("in-band buy above the board threshold: approve, only rule 9 blocks it", () => {
    const r = ruleJuror(exceptionReq());
    expect(r.recommend).toBe("approve");
    expect(r.confidence).toBe(1);
    expect(r.needsTicket).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.projected).toMatchObject({ cashBpsBefore: 10000, cashBpsAfter: 7000, equityBpsBefore: 0, equityBpsAfter: 3000 });
    expect(r.reasons[0]).toContain("only rule 9");
  });

  test("R3 order cap: a notional over perOrderCapUsd is rejected (a ticket would not help)", () => {
    const r = ruleJuror(exceptionReq({ intent: { notionalUsd: usd(100_001) }, weights: { navUsd: usd(400_000), cashUsd: usd(400_000) } }));
    expect(r.recommend).toBe("reject");
    expect(r.checks.find((c) => c.rule === "R3_ORDER_CAP")!.ok).toBe(false);
    expect(ruleJuror(exceptionReq({ intent: { notionalUsd: usd(100_000) }, weights: { navUsd: usd(400_000), cashUsd: usd(400_000) } })).checks.find((c) => c.rule === "R3_ORDER_CAP")!.ok).toBe(true);
  });

  test("R3 day cap: 24h used + notional over perDayCapUsd is rejected; exactly at the cap passes", () => {
    expect(ruleJuror(exceptionReq({ market: { dayUsedUsd: usd(440_001) } })).checks.find((c) => c.rule === "R3_DAY_CAP")!.ok).toBe(false);
    expect(ruleJuror(exceptionReq({ market: { dayUsedUsd: usd(440_000) } })).checks.find((c) => c.rule === "R3_DAY_CAP")!.ok).toBe(true);
  });

  test("R3 funds: selling more equity than is held is rejected", () => {
    const r = ruleJuror(exceptionReq({ intent: { action: "sell" } }));
    expect(r.recommend).toBe("reject");
    expect(r.checks.find((c) => c.rule === "R3_FUNDS")!.ok).toBe(false);
  });

  test("R4 bands: a buy that pushes cash under and equity over its band is rejected", () => {
    const r = ruleJuror(exceptionReq({ weights: { cashUsd: usd(80_000), equityUsd: usd(120_000) } }));
    expect(r.recommend).toBe("reject");
    expect(r.checks.filter((c) => !c.ok).map((c) => c.rule)).toEqual(["R4_BAND_CASH", "R4_BAND_EQUITY"]);
  });

  test("R4 bands: still out of band but moving strictly toward it passes (guard semantics)", () => {
    const band = { minBps: 4000, maxBps: 7000 };
    const pct = (p: number) => (BigInt(p) * WAD) / 100n;
    expect(bandOk(band, pct(100), pct(80))).toBe(true); // above, moving down
    expect(bandOk(band, pct(80), pct(90))).toBe(false); // above, moving away
    expect(bandOk(band, pct(80), pct(30))).toBe(false); // jumped across the band
    expect(bandOk(band, pct(10), pct(20))).toBe(true); // below, moving up
    expect(bandOk(band, pct(50), pct(50))).toBe(true);
    expect(bandOk(band, pct(70), pct(70))).toBe(true); // edges are in band
    expect(bandOk(band, pct(90), pct(90))).toBe(false); // out and not moving
  });

  test("R7 off-hours: while a held feed is on hold a buy is rejected, a sell is not", () => {
    const held = { weights: { cashUsd: usd(100_000), equityUsd: usd(100_000) }, market: { equityHold: true } };
    expect(ruleJuror(exceptionReq(held)).checks.find((c) => c.rule === "R7_OFF_HOURS")!.ok).toBe(false);
    expect(ruleJuror(exceptionReq({ ...held, intent: { action: "sell" } })).checks.find((c) => c.rule === "R7_OFF_HOURS")!.ok).toBe(true);
    expect(ruleJuror(exceptionReq({ ...held, policy: { noNewRiskOffHours: false } })).checks.find((c) => c.rule === "R7_OFF_HOURS")!.ok).toBe(true);
  });

  test("R8 pause: at -4.76% drawdown a buy is rejected, a sell passes", () => {
    const base = { weights: { cashUsd: usd(100_000), equityUsd: usd(100_000) }, market: { periodStartNavUsd: usd(210_000) } };
    const buy = ruleJuror(exceptionReq(base));
    expect(buy.projected.drawdownBps).toBe(-476);
    expect(buy.checks.find((c) => c.rule === "R8_DRAWDOWN")!.ok).toBe(false);
    expect(ruleJuror(exceptionReq({ ...base, intent: { action: "sell" } })).checks.find((c) => c.rule === "R8_DRAWDOWN")!.ok).toBe(true);
  });

  test("R8 derisk: at -9.09% only moves toward cash pass (sell yes, vault deposit no)", () => {
    const base = { weights: { cashUsd: usd(100_000), equityUsd: usd(100_000) }, market: { periodStartNavUsd: usd(220_000) } };
    expect(ruleJuror(exceptionReq({ ...base, intent: { action: "sell" } })).checks.find((c) => c.rule === "R8_DRAWDOWN")!.ok).toBe(true);
    expect(ruleJuror(exceptionReq({ ...base, intent: { action: "deposit" } })).checks.find((c) => c.rule === "R8_DRAWDOWN")!.ok).toBe(false);
  });

  test("R9 threshold: needsTicket only strictly above approvalAboveUsd", () => {
    expect(ruleJuror(exceptionReq({ intent: { notionalUsd: usd(50_000) } })).needsTicket).toBe(false);
    expect(ruleJuror(exceptionReq({ intent: { notionalUsd: (50_000n * WAD + 1n).toString() } })).needsTicket).toBe(true);
  });

  test("drawdown truncates toward zero like Solidity; no period-start NAV = no drawdown", () => {
    expect(drawdownBps(1n, 3n)).toBe(-6666n);
    expect(drawdownBps(5n, 3n)).toBe(6666n);
    expect(drawdownBps(5n, 0n)).toBeNull();
    expect(weightWad(1n, 0n)).toBe(0n);
  });

  test("unknown actions are refused rather than guessed", () => {
    expect(() => ruleJuror(exceptionReq({ intent: { action: "bridge" } }))).toThrow("unknown action");
  });

  test("fuzz: projections conserve cash + equity, and a weight that does not move is ok iff it is in band", () => {
    let seed = 26;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 2000; i++) {
      const n = BigInt(rnd(1_000_000)) * WAD + BigInt(rnd(1e9));
      for (const a of ["buy", "sell", "deposit", "redeem"]) {
        const d = project(a, n);
        expect(d.cash + d.equity).toBe(0n);
      }
      const lo = rnd(10_001), hi = lo + rnd(10_001 - lo);
      const w = BigInt(rnd(10_001)) * 10n ** 14n + BigInt(rnd(10 ** 14));
      const inBand = w >= (BigInt(lo) * WAD) / 10_000n && w <= (BigInt(hi) * WAD) / 10_000n;
      expect(bandOk({ minBps: lo, maxBps: hi }, w, w)).toBe(inBand);
    }
  });
});

// ------------------------------------------------------------------------------------------- model jurors

describe("model jurors over a mocked Ollama", () => {
  test("a valid answer is a vote; the request asks for JSON, no stream, temperature 0", async () => {
    const seen: { model: string; body: any }[] = [];
    server.use(chat({ llama: [vote("approve", 0.9)] }, seen));
    const r = await askJuror("llama", exceptionReq(), { host: HOST });
    expect(r).toEqual({ model: "llama", status: "vote", recommend: "approve", confidence: 0.9, reasons: ["approve because"], attempts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toMatchObject({ model: "llama", stream: false, format: "json", options: { temperature: 0 } });
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(seen[0]!.body.messages[1].content).toContain("notional $60000");
  });

  test("invalid JSON gets exactly one retry, then a valid answer counts", async () => {
    const seen: any[] = [];
    server.use(chat({ m: ["{not json", vote("reject")] }, seen));
    const r = await askJuror("m", exceptionReq(), { host: HOST });
    expect(r).toMatchObject({ status: "vote", recommend: "reject", attempts: 2 });
    expect(seen).toHaveLength(2);
  });

  test("invalid twice: the juror abstains after one retry (no third call)", async () => {
    const seen: any[] = [];
    server.use(chat({ m: ["nope", '{"recommend":"maybe","confidence":0.5,"reasons":["x"]}', vote("approve")] }, seen));
    const r = await askJuror("m", exceptionReq(), { host: HOST });
    expect(r).toEqual({ model: "m", status: "abstain", error: "recommend must be approve|reject", attempts: MAX_ATTEMPTS });
    expect(seen).toHaveLength(2);
  });

  test("HTTP errors and a missing model are retried once, then abstain", async () => {
    server.use(chat({ m: [HttpResponse.json({}, { status: 500 }), vote("approve")] }));
    expect(await askJuror("m", exceptionReq(), { host: HOST })).toMatchObject({ status: "vote", attempts: 2 });
    expect(await askJuror("absent", exceptionReq(), { host: HOST })).toMatchObject({ status: "abstain", error: "HTTP 404" });
  });

  test("answer shape is strict", () => {
    expect(parseJurorAnswer(JSON.stringify(vote("approve")))).toMatchObject({ ok: true });
    expect(parseJurorAnswer(JSON.stringify({ ...vote("approve"), recommend: " APPROVE " }))).toMatchObject({ ok: true, recommend: "approve" });
    for (const bad of [
      undefined,
      "[]",
      '"approve"',
      JSON.stringify({ ...vote("approve"), confidence: 1.5 }),
      JSON.stringify({ ...vote("approve"), confidence: -0.1 }),
      JSON.stringify({ ...vote("approve"), confidence: "0.8" }),
      JSON.stringify({ ...vote("approve"), reasons: [] }),
      JSON.stringify({ ...vote("approve"), reasons: [" "] }),
      JSON.stringify({ ...vote("approve"), reasons: "because" }),
      JSON.stringify({ recommend: "approve", confidence: 0.5 }),
    ]) {
      expect(parseJurorAnswer(bad).ok).toBe(false);
    }
    const long = parseJurorAnswer(JSON.stringify({ recommend: "reject", confidence: 0, reasons: Array(12).fill("x".repeat(900)) }));
    expect(long.ok && long.reasons.length === 8 && long.reasons.every((r) => r.length === 400)).toBe(true);
  });

  test("the prompt states the facts in whole dollars and percent", () => {
    const p = userPrompt(exceptionReq());
    expect(p).toContain("NAV $200000, cash 100.00%, equity 0.00%");
    expect(p).toContain("board sign-off above $50000");
    expect(p).toContain("R9_APPROVAL");
  });
});

// ------------------------------------------------------------------------------------------- verdict

describe("verdict", () => {
  const v = (r: "approve" | "reject"): JurorResult => ({ model: "m", status: "vote", recommend: r, confidence: 0.7, reasons: ["r"], attempts: 1 });
  const a: JurorResult = { model: "m", status: "abstain", error: "e", attempts: 2 };

  test("tally: majority of non-abstaining; tie or >= 2 abstentions = no recommendation (all 27 juries of 3)", () => {
    const opts = [v("approve"), v("reject"), a];
    for (const x of opts)
      for (const y of opts)
        for (const z of opts) {
          const js = [x, y, z];
          const ap = js.filter((j) => j.status === "vote" && j.recommend === "approve").length;
          const rj = js.filter((j) => j.status === "vote" && j.recommend === "reject").length;
          const ab = 3 - ap - rj;
          const expected = ab >= 2 || ap === rj ? "none" : ap > rj ? "approve" : "reject";
          expect(tally(js)).toMatchObject({ recommend: expected, approve: ap, reject: rj, abstain: ab });
        }
    expect(tally([]).recommend).toBe("none");
  });

  test("service: three models vote 2-1 -> majority; one abstains and the rest split -> none", async () => {
    server.use(up(), chat({ a: [vote("approve")], b: [vote("reject")], c: [vote("approve")] }));
    const d1 = await svc().deliberate(exceptionReq());
    expect(d1.bundle.mode).toBe("models+rules");
    expect(d1.bundle.verdict).toMatchObject({ recommend: "approve", approve: 2, reject: 1, abstain: 0 });
    server.resetHandlers(up(), chat({ a: [vote("approve")], b: [vote("reject")], c: ["x", "y"] }));
    const d2 = await svc().deliberate(exceptionReq());
    expect(d2.bundle.verdict).toMatchObject({ recommend: "none", abstain: 1, why: "tie 1-1" });
    server.resetHandlers(up(), chat({ a: [vote("reject")] }));
    const d3 = await svc().deliberate(exceptionReq());
    expect(d3.bundle.verdict).toMatchObject({ recommend: "none", abstain: 2 });
  });

  test("the rule juror always runs and is attached separately from the model verdict", async () => {
    server.use(up(), chat({ a: [vote("approve")], b: [vote("approve")], c: [vote("approve")] }));
    const d = await svc().deliberate(exceptionReq({ market: { dayUsedUsd: usd(499_000) } }));
    expect(d.bundle.verdict.recommend).toBe("approve");
    expect(d.bundle.rules).toMatchObject({ juror: "rules", recommend: "reject" });
    expect(d.bundle.jurors.map((j) => j.model)).toEqual(["a", "b", "c"]);
  });

  test("Ollama not running: rule juror only, logged, models never called", async () => {
    const seen: any[] = [];
    server.use(http.get(`${HOST}/api/version`, () => HttpResponse.error()), chat({ a: [vote("approve")] }, seen));
    const log: string[] = [];
    const d = await svc(log).deliberate(exceptionReq());
    expect(d.bundle.mode).toBe("rules-only");
    expect(d.bundle.jurors).toEqual([]);
    expect(d.bundle.verdict.recommend).toBe("none");
    expect(d.bundle.rules.recommend).toBe("approve");
    expect(seen).toHaveLength(0);
    expect(log.some((m) => m.includes("Ollama not reachable") && m.includes("rule juror only"))).toBe(true);
  });

  test("bundle hash is keccak256 of the exact canonical JSON; the cid check refuses any change", () => {
    const req = exceptionReq();
    const b = buildBundle({ request: req, models: ["a"], jurors: [], rules: ruleJuror(req), up: false, createdAt: new Date(0) });
    const { json, hash, cid } = encodeBundle(b);
    expect(json).toBe(canonicalJson(b));
    expect(hash).toBe(keccak256(toBytes(json)));
    expect(cid).toBe(hash);
    expect(cidMatches(json, hash)).toBe(true);
    expect(cidMatches(json.replace('"approve"', '"reject"'), hash)).toBe(false);
    expect(cidMatches(json, "0x1234")).toBe(false);
    expect(b.note).toContain("never approves");
  });

  test("fromEnv: host:port is accepted, models are comma separated", () => {
    const j = JuryService.fromEnv({ OLLAMA_HOST: "127.0.0.1:9598", TREASURY_JURY_MODELS: "x, y" });
    expect(j.ollama.host).toBe("http://127.0.0.1:9598");
    expect(j.models).toEqual(["x", "y"]);
    expect(JuryService.fromEnv({}).models).toEqual(["llama3.2:3b", "qwen2.5:3b", "phi3.5"]);
  });
});

// ------------------------------------------------------------------------------------------- board API

describe("board API (jury bundles)", () => {
  const APP = "0x00000000000000000000000000000000000000bb";
  async function stored() {
    const store = new MemoryJuryStore();
    const req = exceptionReq();
    const b = buildBundle({ request: req, models: [], jurors: [], rules: ruleJuror(req), up: false, createdAt: new Date(0) });
    const { json, hash } = encodeBundle(b);
    const id = await store.insert(b, json, hash);
    await store.markRequested(id, `0x${"0".repeat(63)}7`, `0x${"ab".repeat(32)}`);
    return { store, hash, api: juryApi(store) };
  }
  const get = (api: (r: Request) => Promise<Response>, path: string, method = "GET") => api(new Request(`http://x${path}`, { method }));

  test("by ticket and by hash: the bundle is served re-verified", async () => {
    const { api, hash } = await stored();
    for (const path of [`/jury/tickets/31337/${APP}/7`, `/jury/verdicts/31337/${APP}/${hash}`]) {
      const r = await get(api, path);
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      expect(body).toMatchObject({ verified: true, bundleHash: hash, status: "requested", ruleRecommendation: "approve", recommendation: "none" });
      expect(body.bundle.rules.juror).toBe("rules");
    }
    const list = (await (await get(api, "/jury/verdicts?account=0x00000000000000000000000000000000000000aa")).json()) as any;
    expect(list.verdicts).toHaveLength(1);
  });

  test("a tampered stored bundle is refused with 409", async () => {
    const { api, store, hash } = await stored();
    store.rows[0]!.bundleJson = store.rows[0]!.bundleJson.replace('"approve"', '"reject"');
    expect((await get(api, `/jury/verdicts/31337/${APP}/${hash}`)).status).toBe(409);
  });

  test("bad input: 400/404/405, never a stack trace", async () => {
    const { api } = await stored();
    expect((await get(api, `/jury/tickets/31337/${APP}/0xzz`)).status).toBe(400);
    expect((await get(api, `/jury/verdicts/31337/${APP}/0x12`)).status).toBe(400);
    expect((await get(api, `/jury/tickets/31337/${APP}/8`)).status).toBe(404);
    expect((await get(api, `/jury/tickets/31337/notanaddress/7`)).status).toBe(404);
    expect((await get(api, "/jury/verdicts?account=nope")).status).toBe(400);
    expect((await get(api, `/jury/tickets/31337/${APP}/7`, "POST")).status).toBe(405);
  });
});
