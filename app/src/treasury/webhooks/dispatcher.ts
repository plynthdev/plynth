// Signed webhooks for board-facing treasury events, from the treasury_webhooks subscription table.
//
// Events:
//   guard.denied     a desk operation the PolicyGuard refused (desk_actions rows with status rejected|reverted and
//                    a rule code), polled from desk_actions by id cursor
//   close.committed  a period close committed on-chain (closes rows with status committed), polled
//   drawdown.state   pushed by the risk service through `emit` (the dispatcher is a WebhookSink)
//   risk.alert, reconcile.break  also accepted through `emit` when a subscription asks for them
//
// Body: {"type","id","ts","data"} JSON, `id` = a stable event key so receivers can drop duplicates. Header
// `x-plinth-signature: sha256=<hex HMAC-SHA256(secret, raw body)>` with the subscription's own secret. The exact
// body is stored with the delivery so a retry resends identical bytes (same signature). A delivery that got a
// 2xx is never sent again; network errors, 5xx and 429 are retried with backoff in the same poll and again on
// later polls until `maxAttempts`; other 4xx are final.
import { treasuryWebhookCursors, treasuryWebhookDeliveries, treasuryWebhooks, closes, deskActions, type Db } from "@/db";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getAddress } from "viem";
import { sign, stringify, type WebhookEvent, type WebhookSink } from "@/treasury/risk/webhooks";

export const WEBHOOK_EVENTS = ["guard.denied", "drawdown.state", "close.committed", "risk.alert", "reconcile.break"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export type DispatcherOptions = {
  chainId: number;
  fetchImpl?: typeof fetch;
  retries?: number; // extra attempts inside one send (default 2)
  backoffMs?: number; // default 250, doubled per retry
  timeoutMs?: number; // per attempt, default 5000
  maxAttempts?: number; // total attempts across polls before giving up (default 10)
  now?: () => Date;
};

type Sub = typeof treasuryWebhooks.$inferSelect;

export type SendResult = { webhookId: number; eventKey: string; ok: boolean; status: number | null; attempts: number; skipped?: boolean };

export class WebhookStore {
  constructor(private readonly db: Db) {}

  async add(chainId: number, account: string, url: string, secret: string, events: string[]): Promise<number> {
    validateSubscription(url, secret, events);
    const [row] = await this.db
      .insert(treasuryWebhooks)
      .values({ chainId, account: getAddress(account).toLowerCase(), url, secret, events, active: true })
      .onConflictDoUpdate({ target: [treasuryWebhooks.chainId, treasuryWebhooks.account, treasuryWebhooks.url], set: { secret, events, active: true } })
      .returning({ id: treasuryWebhooks.id });
    return row!.id;
  }

  async disable(id: number) {
    await this.db.update(treasuryWebhooks).set({ active: false }).where(eq(treasuryWebhooks.id, id));
  }

  /** Subscriptions without their secrets (safe to print or serve). */
  async list(chainId: number, account?: string) {
    const rows = await this.db
      .select({ id: treasuryWebhooks.id, account: treasuryWebhooks.account, url: treasuryWebhooks.url, events: treasuryWebhooks.events, active: treasuryWebhooks.active, createdAt: treasuryWebhooks.createdAt })
      .from(treasuryWebhooks)
      .where(account ? and(eq(treasuryWebhooks.chainId, chainId), eq(treasuryWebhooks.account, account.toLowerCase())) : eq(treasuryWebhooks.chainId, chainId))
      .orderBy(asc(treasuryWebhooks.id));
    return rows;
  }
}

export function validateSubscription(url: string, secret: string, events: string[]) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`bad webhook url ${url}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
    throw new Error("webhook url must be https (http only for localhost)");
  }
  if (secret.length < 16) throw new Error("webhook secret must be at least 16 characters");
  if (events.length === 0) throw new Error("subscribe to at least one event");
  for (const e of events) if (!(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new Error(`unknown webhook event ${e}`);
}

export class WebhookDispatcher implements WebhookSink {
  constructor(
    private readonly db: Db,
    private readonly opts: DispatcherOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private async subs(account: string, type: string): Promise<Sub[]> {
    const rows = await this.db
      .select()
      .from(treasuryWebhooks)
      .where(and(eq(treasuryWebhooks.chainId, this.opts.chainId), eq(treasuryWebhooks.account, account.toLowerCase()), eq(treasuryWebhooks.active, true)));
    return rows.filter((r) => r.events.includes(type));
  }

  /** WebhookSink: deliver a pushed event (drawdown.state from the risk service) to the account's subscribers. */
  async emit(e: WebhookEvent): Promise<SendResult[]> {
    const data = (e.data ?? {}) as { account?: string; blockNumber?: bigint | number | string; to?: string };
    if (!data.account) return [];
    const key = `${e.type}:${data.account.toLowerCase()}:${String(data.blockNumber ?? this.now().toISOString())}:${data.to ?? ""}`;
    return this.publish(data.account, e.type, key, e.data);
  }

  /** Sends one event to every matching subscription once (idempotent per (subscription, key)). */
  async publish(account: string, type: string, eventKey: string, data: unknown): Promise<SendResult[]> {
    const out: SendResult[] = [];
    for (const s of await this.subs(account, type)) out.push(await this.sendOnce(s, type, eventKey, data));
    return out;
  }

  private async sendOnce(s: Sub, type: string, eventKey: string, data: unknown): Promise<SendResult> {
    const [prev] = await this.db
      .select()
      .from(treasuryWebhookDeliveries)
      .where(and(eq(treasuryWebhookDeliveries.webhookId, s.id), eq(treasuryWebhookDeliveries.eventKey, eventKey)));
    const max = this.opts.maxAttempts ?? 10;
    if (prev && (prev.ok || prev.attempts >= max || (prev.status !== null && prev.status < 500 && prev.status !== 429))) {
      return { webhookId: s.id, eventKey, ok: prev.ok, status: prev.status, attempts: prev.attempts, skipped: true };
    }
    const body = prev?.body ?? stringify({ type, id: eventKey, ts: this.now().toISOString(), data });
    const r = await this.post(s.url, s.secret, body);
    const attempts = (prev?.attempts ?? 0) + r.attempts;
    const values = { ok: r.ok, status: r.status, attempts, error: r.error ?? null, deliveredAt: r.ok ? this.now() : null };
    if (prev) await this.db.update(treasuryWebhookDeliveries).set(values).where(eq(treasuryWebhookDeliveries.id, prev.id));
    else await this.db.insert(treasuryWebhookDeliveries).values({ webhookId: s.id, eventKey, type, body, ...values });
    return { webhookId: s.id, eventKey, ok: r.ok, status: r.status, attempts };
  }

  private async post(url: string, secret: string, body: string): Promise<{ ok: boolean; status: number | null; attempts: number; error?: string }> {
    const f = this.opts.fetchImpl ?? fetch;
    const retries = this.opts.retries ?? 2;
    let wait = this.opts.backoffMs ?? 250;
    const headers = { "content-type": "application/json", "x-plinth-signature": sign(secret, body) };
    let last: { ok: boolean; status: number | null; attempts: number; error?: string } = { ok: false, status: null, attempts: 0 };
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const r = await f(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
        last = { ok: r.ok, status: r.status, attempts: attempt };
        if (r.ok || (r.status < 500 && r.status !== 429)) return last;
      } catch (err) {
        last = { ok: false, status: null, attempts: attempt, error: err instanceof Error ? err.message : String(err) };
      }
      if (attempt <= retries) {
        await Bun.sleep(wait);
        wait *= 2;
      }
    }
    return last;
  }

  private async cursor(name: string): Promise<number> {
    const [r] = await this.db.select().from(treasuryWebhookCursors).where(eq(treasuryWebhookCursors.name, name));
    return r?.lastId ?? 0;
  }

  private async setCursor(name: string, lastId: number) {
    await this.db
      .insert(treasuryWebhookCursors)
      .values({ name, lastId })
      .onConflictDoUpdate({ target: treasuryWebhookCursors.name, set: { lastId, updatedAt: sql`now()` } });
  }

  /** One pass: new guard denials, committed closes, then retries of earlier failed deliveries. */
  async pollOnce(): Promise<SendResult[]> {
    const out: SendResult[] = [];
    const chainId = this.opts.chainId;

    // guard.denied, by desk_actions id cursor (rows are append-only).
    const curName = `desk_actions:${chainId}`;
    const from = await this.cursor(curName);
    const acts = await this.db
      .select()
      .from(deskActions)
      .where(and(eq(deskActions.chainId, chainId), gt(deskActions.id, from)))
      .orderBy(asc(deskActions.id))
      .limit(1000);
    for (const a of acts) {
      if ((a.status === "rejected" || a.status === "reverted") && a.reasonCode !== null) {
        out.push(
          ...(await this.publish(a.account, "guard.denied", `guard.denied:desk_action:${chainId}:${a.id}`, {
            account: getAddress(a.account),
            chainId,
            desk: a.desk,
            action: a.action,
            status: a.status,
            reasonCode: a.reasonCode,
            reason: a.reason,
            asset: a.asset,
            amount: a.amount,
            notionalUsd: a.notionalUsd,
            txHash: a.txHash,
            at: a.createdAt.toISOString(),
          })),
        );
      }
    }
    if (acts.length) await this.setCursor(curName, acts[acts.length - 1]!.id);

    // close.committed: committed rows of subscribed accounts (closes are rare; keys make this idempotent).
    const accounts = await this.db
      .selectDistinct({ account: treasuryWebhooks.account })
      .from(treasuryWebhooks)
      .where(and(eq(treasuryWebhooks.chainId, chainId), eq(treasuryWebhooks.active, true)));
    if (accounts.length) {
      const rows = await this.db
        .select()
        .from(closes)
        .where(and(eq(closes.chainId, chainId), eq(closes.status, "committed"), inArray(closes.account, accounts.map((a) => a.account))))
        .orderBy(asc(closes.id));
      for (const c of rows) {
        out.push(
          ...(await this.publish(c.account, "close.committed", `close.committed:${chainId}:${c.periodClose}:${c.closeIndex}`, {
            account: getAddress(c.account),
            chainId,
            periodClose: getAddress(c.periodClose),
            index: c.closeIndex,
            periodEnd: c.periodEnd,
            navUsd: c.navUsd,
            bundleHash: c.bundleHash,
            txHash: c.txHash,
            blockNumber: c.blockNumber,
          })),
        );
      }
    }

    // Retries of pushed events (drawdown.state) that failed earlier: resend the stored body.
    const failed = await this.db
      .select({ d: treasuryWebhookDeliveries, s: treasuryWebhooks })
      .from(treasuryWebhookDeliveries)
      .innerJoin(treasuryWebhooks, eq(treasuryWebhooks.id, treasuryWebhookDeliveries.webhookId))
      .where(and(eq(treasuryWebhookDeliveries.ok, false), lt(treasuryWebhookDeliveries.attempts, this.opts.maxAttempts ?? 10), eq(treasuryWebhooks.active, true)));
    for (const { d, s } of failed) {
      if (out.some((o) => o.webhookId === s.id && o.eventKey === d.eventKey)) continue;
      out.push(await this.sendOnce(s, d.type, d.eventKey, undefined));
    }
    return out;
  }
}
