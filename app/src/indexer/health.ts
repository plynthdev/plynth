import { evCursors, type Db } from "@/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Stream } from "./handlers/streams";

export type HealthDeps = { db: Db; chainId: number; streams: Stream[]; safeHead: () => Promise<bigint> };

/** GET /health -> per-stream lag in blocks behind head - confirmations. 503 if the RPC or DB is down. */
export function healthApp(d: HealthDeps): Hono {
  const app = new Hono();
  app.get("/health", async (c) => {
    try {
      const head = await d.safeHead();
      const rows = await d.db.select().from(evCursors).where(eq(evCursors.chainId, d.chainId));
      const byName = new Map(rows.map((r) => [r.stream, r.lastBlock]));
      const streams = d.streams.map((s) => {
        const last = byName.get(s.name) ?? s.fromBlock - 1n;
        const lag = head > last ? head - last : 0n;
        return { stream: s.name, lastBlock: last.toString(), lag: Number(lag) };
      });
      return c.json({ ok: true, chainId: d.chainId, head: head.toString(), maxLag: Math.max(0, ...streams.map((s) => s.lag)), streams });
    } catch (err) {
      return c.json({ ok: false, error: String((err as Error)?.message ?? err) }, 503);
    }
  });
  return app;
}
