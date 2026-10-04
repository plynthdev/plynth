// Plaid adapter (todo 23). Works end to end against Plaid's free Sandbox; production is the same code with
// PLAID_ENV=production and production keys (Kal's switch). Access tokens are stored only AES-GCM sealed with
// KEEPER_SECRET_KEY, bound to (chain, user, item) as associated data.
//
// Rules:
//  P1 Plaid amounts are positive for money out: only amount > 0 is a spend; refunds/deposits are skipped.
//  P2 pending transactions are skipped: Plaid replaces them with a posted transaction (new id) later.
//  P3 non-USD (iso or unofficial currency) is skipped with a reason.
//  P4 /transactions/sync pages until has_more is false; a mutation during pagination restarts from the
//     page's starting cursor; the cursor is persisted only after a complete sync.
//  P5 removed transactions that were not yet accrued are skipped.
import { Configuration, PlaidApi, PlaidEnvironments, type Transaction } from "plaid";
import type { Address } from "viem";
import type { Sealer } from "../seal";
import { parseCents } from "./statement";
import { activeSources, insertEvents, openEvents, setSourceSync, skipRemoved, toSpendEvent } from "./store";
import { sha256Hex, type SpendEvent, type SpendSource } from "./types";
import type { Db } from "@plynth/db";

export type PlaidLike = Pick<PlaidApi, "transactionsSync" | "linkTokenCreate" | "itemPublicTokenExchange" | "itemRemove">;
export type PlaidConfig = { api: PlaidLike; env: "sandbox" | "production"; countryCodes: string[] };

/** PLAID_CLIENT_ID + PLAID_SECRET enable Plaid; PLAID_ENV = sandbox (default) | production. */
export function plaidFromEnv(env: Record<string, string | undefined>): PlaidConfig | undefined {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return undefined;
  const name = (env.PLAID_ENV || "sandbox").toLowerCase();
  if (name !== "sandbox" && name !== "production") throw new Error(`PLAID_ENV must be sandbox or production, got ${name}`);
  const api = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[name],
      baseOptions: { headers: { "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID, "PLAID-SECRET": env.PLAID_SECRET, "Plaid-Version": "2020-09-14" }, timeout: 30_000 },
    }),
  );
  const countryCodes = (env.PLAID_COUNTRY_CODES || "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return { api, env: name, countryCodes };
}

/** Associated data for a sealed access token: a ciphertext copied onto another user/item does not open. */
export const plaidAad = (chainId: number, user: string, itemId: string) => `plaid:${chainId}:${user.toLowerCase()}:${itemId}`;

export const plaidRowHash = (transactionId: string) => sha256Hex(`plaid\u001f${transactionId}`);

/** P1-P3: a Plaid transaction as a SpendEvent, or why it is not one. */
export function plaidEvent(tx: Pick<Transaction, "transaction_id" | "amount" | "pending" | "iso_currency_code" | "unofficial_currency_code" | "date" | "authorized_date" | "merchant_name" | "name">): { event?: SpendEvent; skip?: string } {
  if (tx.pending) return { skip: "pending; the posted transaction follows" };
  const cur = (tx.iso_currency_code ?? tx.unofficial_currency_code ?? "").toUpperCase();
  if (cur !== "USD") return { skip: `currency ${cur || "unknown"} is not USD` };
  const cents = parseCents(Number(tx.amount).toFixed(2));
  if (cents === null) return { skip: "unreadable amount" };
  if (cents <= 0n) return { skip: cents === 0n ? "zero amount" : "credit, not a spend" };
  const at = new Date(`${tx.authorized_date ?? tx.date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return { skip: "unreadable date" };
  const merchant = (tx.merchant_name ?? tx.name ?? "").trim().slice(0, 120) || undefined;
  return { event: { id: tx.transaction_id, amountCents: cents, currency: "USD", at, merchant } };
}

const errorCode = (e: unknown): string | undefined => (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;

export type SyncResult = { upserts: { rowHash: string; event: SpendEvent }[]; skipped: { id: string; reason: string }[]; removed: string[]; cursor: string };

/** P4: one complete /transactions/sync from `cursor` (undefined = from the start). */
export async function syncItem(api: PlaidLike, accessToken: string, cursor: string | undefined, maxRestarts = 3): Promise<SyncResult> {
  for (let restart = 0; ; restart++) {
    const out: SyncResult = { upserts: [], skipped: [], removed: [], cursor: cursor ?? "" };
    let c = cursor;
    try {
      for (let page = 0; page < 1_000; page++) {
        const { data } = await api.transactionsSync({ access_token: accessToken, ...(c ? { cursor: c } : {}), count: 500 });
        for (const tx of [...data.added, ...data.modified]) {
          const r = plaidEvent(tx);
          if (r.event) out.upserts.push({ rowHash: plaidRowHash(tx.transaction_id), event: r.event });
          else out.skipped.push({ id: tx.transaction_id, reason: r.skip! });
        }
        for (const rm of data.removed) if (rm.transaction_id) out.removed.push(rm.transaction_id);
        c = data.next_cursor;
        if (!data.has_more) {
          out.cursor = c;
          return out;
        }
      }
      throw new Error("transactions/sync did not finish in 1000 pages");
    } catch (e) {
      if (errorCode(e) === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restart < maxRestarts) continue;
      throw e;
    }
  }
}

type Deps = { db: Db; chainId: number; sealer: Sealer; plaid: PlaidLike };

/** Plaid behind the SpendSource interface: fetch() syncs every active item of the user, then returns open events. */
export class PlaidSource implements SpendSource {
  readonly name = "plaid" as const;
  /** Per-item sync failures of the last fetch (item id -> message); the other items still sync. */
  errors = new Map<string, string>();
  constructor(private readonly d: Deps) {}

  async sync(user: Address): Promise<void> {
    for (const s of await activeSources(this.d, "plaid", user)) {
      try {
        if (!s.secretEnc) throw new Error("no access token stored");
        const token = new TextDecoder().decode(await this.d.sealer.open(s.secretEnc, plaidAad(this.d.chainId, s.userAddress, s.sourceKey)));
        const r = await syncItem(this.d.plaid, token, s.cursor ?? undefined);
        await insertEvents(this.d, user, "plaid", s.sourceKey, r.upserts, true);
        await skipRemoved(this.d, user, r.removed.map(plaidRowHash));
        await setSourceSync(this.d, s, { cursor: r.cursor, error: null });
      } catch (e) {
        const msg = errorCode(e) ?? String((e as Error)?.message ?? e).split("\n")[0]!;
        this.errors.set(s.sourceKey, msg);
        await setSourceSync(this.d, s, { error: msg });
      }
    }
  }

  async fetch(user: Address, since: Date): Promise<SpendEvent[]> {
    await this.sync(user);
    return (await openEvents(this.d, user, "plaid", since)).map(toSpendEvent);
  }
}

/** Imported statements behind the same interface: the API stored them; fetch() returns the open ones. */
export class StatementSource implements SpendSource {
  readonly name = "statement" as const;
  constructor(private readonly d: Pick<Deps, "db" | "chainId">) {}
  async fetch(user: Address, since: Date): Promise<SpendEvent[]> {
    return (await openEvents(this.d, user, "statement", since)).map(toSpendEvent);
  }
}
