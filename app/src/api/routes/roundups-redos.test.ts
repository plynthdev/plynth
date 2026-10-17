// Review v2, V2-M4: one signed worst-case OFX import through createApp + roundupRoutes must not block the API's event
// loop. Before the fix a 400 KB import stalled every other request for 5.9 s (the parse ran on the request thread).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MAX_STATEMENT_BYTES, sha256Hex } from "@/keeper";
import { BlockTimes, createApp, roundupMessage, roundupRoutes } from "@/api";
import { keeperTestDb } from "@/testing/keeper-helpers";

let t: Awaited<ReturnType<typeof keeperTestDb>>;
beforeAll(async () => {
  t = await keeperTestDb("ofxroute");
});
afterAll(async () => {
  await t?.drop();
});

test("max-size worst-case OFX through POST /v1/roundups/import does not stall a concurrent request", async () => {
  const CHAIN = 31337;
  const fresh = privateKeyToAccount(generatePrivateKey()); // any new wallet, no funds
  const noChain = new Proxy({}, { get: () => () => Promise.resolve(1n) }) as any;
  const roundups = roundupRoutes({ chainId: CHAIN, db: t.db, ipOf: () => "203.0.113.7" });
  const app = createApp({ chainId: CHAIN, pub: noChain, db: t.db, dep: {} as any, blockTimes: new BlockTimes(noChain) }, { roundups, ipOf: () => "198.51.100.1" });

  const n = Math.floor((MAX_STATEMENT_BYTES - 200) / "<CURRENCY>".length);
  const content = "OFXHEADER:100\n<OFX><STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><DTPOSTED>20261001<TRNAMT>-1.23" + "<CURRENCY>".repeat(n) + "</STMTTRN></BANKTRANLIST></STMTRS></OFX>";
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await fresh.signMessage({ message: roundupMessage({ action: "import", user: fresh.address, chainId: CHAIN, subject: sha256Hex(content), issuedAt }) });

  let last = performance.now();
  let maxGap = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  await Bun.sleep(50);
  const t0 = performance.now();
  const ri = await app.request("/v1/roundups/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: fresh.address, issuedAt, signature, content, format: "ofx" }) });
  const importMs = performance.now() - t0;
  await Bun.sleep(30);
  clearInterval(tick);
  expect(ri.status).toBe(200);
  expect(((await ri.json()) as { rows: number }).rows).toBe(1);
  expect(importMs).toBeLessThan(1000);
  expect(maxGap).toBeLessThan(250);
}, 30_000);
