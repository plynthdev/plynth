import { Hono } from "hono";
import type { PassReport } from "./keeper";

export type KeeperHealth = { chainId: number; keeper: string; last: () => PassReport | undefined; head: () => Promise<bigint>; intervalMs: number };

/** GET /health -> last pass summary. 503 if the RPC is down, the last pass failed, or no pass finished recently. */
export function healthApp(h: KeeperHealth): Hono {
  const app = new Hono();
  app.get("/health", async (c) => {
    const last = h.last();
    try {
      const head = await h.head();
      const stale = !last || Date.now() - Date.parse(last.at) > 3 * h.intervalMs;
      const ok = !!last && last.ok && !stale;
      return c.json({ ok, chainId: h.chainId, keeper: h.keeper, head: head.toString(), stale, last: last ?? null }, ok ? 200 : 503);
    } catch (err) {
      return c.json({ ok: false, error: String((err as Error)?.message ?? err), last: last ?? null }, 503);
    }
  });
  return app;
}
