// Outgoing webhooks. Body: {"type", "id", "ts", "data"} as JSON (bigints as decimal strings). When a secret is
// set, header `x-plinth-signature: sha256=<hex HMAC-SHA256(secret, body)>` lets the receiver verify it.
// Delivery retries with backoff on network errors and 5xx/429; a 4xx is final.
import { createHmac, randomUUID } from "node:crypto";

export type WebhookEvent = { type: string; data: unknown };

/** Anything that accepts events: the URL-list `Webhooks` below or the DB-subscription dispatcher (webhooks/). */
export interface WebhookSink {
  emit(e: WebhookEvent): Promise<unknown>;
}

/** Sends every event to each sink in turn. */
export const fanout = (...sinks: (WebhookSink | undefined)[]): WebhookSink | undefined => {
  const live = sinks.filter((s): s is WebhookSink => s !== undefined);
  if (live.length === 0) return undefined;
  return { emit: async (e) => Promise.all(live.map((s) => s.emit(e))) };
};

export type Delivery = { url: string; ok: boolean; status: number | null; attempts: number; error?: string };

export type WebhookOptions = {
  urls: string[];
  secret?: string;
  retries?: number; // extra attempts after the first (default 3)
  backoffMs?: number; // first backoff, doubled each retry (default 500)
  timeoutMs?: number; // per attempt (default 5000)
  fetchImpl?: typeof fetch;
};

export const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class Webhooks implements WebhookSink {
  constructor(readonly opts: WebhookOptions) {}

  async emit(e: WebhookEvent, now = new Date()): Promise<Delivery[]> {
    const body = stringify({ type: e.type, id: randomUUID(), ts: now.toISOString(), data: e.data });
    return Promise.all(this.opts.urls.map((u) => this.deliver(u, body)));
  }

  private async deliver(url: string, body: string): Promise<Delivery> {
    const f = this.opts.fetchImpl ?? fetch;
    const retries = this.opts.retries ?? 3;
    let wait = this.opts.backoffMs ?? 500;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.secret) headers["x-plinth-signature"] = sign(this.opts.secret, body);
    let last: Delivery = { url, ok: false, status: null, attempts: 0 };
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const r = await f(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
        last = { url, ok: r.ok, status: r.status, attempts: attempt };
        if (r.ok || (r.status < 500 && r.status !== 429)) return last;
      } catch (err) {
        last = { url, ok: false, status: null, attempts: attempt, error: err instanceof Error ? err.message : String(err) };
      }
      if (attempt <= retries) {
        await Bun.sleep(wait);
        wait *= 2;
      }
    }
    return last;
  }
}
