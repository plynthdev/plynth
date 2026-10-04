import { describe, expect, test } from "bun:test";
import { healthApp } from "../src/health";
import type { PassReport } from "../src/keeper";

function serve(last: PassReport | undefined, head: () => Promise<bigint> = async () => 42n) {
  const server = Bun.serve({ port: 0, fetch: healthApp({ chainId: 31337, keeper: "0xkeeper", last: () => last, head, intervalMs: 30_000 }).fetch });
  return { url: `http://127.0.0.1:${server.port}/health`, stop: () => server.stop(true) };
}

describe("/health", () => {
  test("200 with the last pass when it was recent and ok", async () => {
    const s = serve({ at: new Date().toISOString(), ok: true, jobs: [{ job: "roundups", ok: true, actions: 2, notes: [] }] });
    try {
      const r = await fetch(s.url);
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.ok).toBe(true);
      expect(j.head).toBe("42");
      expect(j.last.jobs[0].actions).toBe(2);
    } finally {
      s.stop();
    }
  });

  test("503 before the first pass, after a failed pass, when stale, or when the RPC is down", async () => {
    const cases: [PassReport | undefined, (() => Promise<bigint>) | undefined][] = [
      [undefined, undefined],
      [{ at: new Date().toISOString(), ok: false, jobs: [] }, undefined],
      [{ at: new Date(Date.now() - 10 * 60_000).toISOString(), ok: true, jobs: [] }, undefined],
      [{ at: new Date().toISOString(), ok: true, jobs: [] }, async () => { throw new Error("rpc down"); }],
    ];
    for (const [last, head] of cases) {
      const s = serve(last, head);
      try {
        expect((await fetch(s.url)).status).toBe(503);
      } finally {
        s.stop();
      }
    }
  });
});
