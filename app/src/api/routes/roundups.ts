// Round-up source routes (todo 23), mounted at /roundups and /v1/roundups when ROUNDUPS_ENABLED=1:
//   POST /import             statement upload (CSV, OFX/QFX) -> roundup_events (deduped per user)
//   POST /plaid/link-token   a Plaid Link token for the user (Plaid configured only)
//   POST /plaid/exchange     public_token -> access token, stored sealed with KEEPER_SECRET_KEY
//   POST /sources/unlink     stop a source; its sealed token is forgotten (Plaid item removed best effort)
// Every request is signed by the user's wallet (personal_sign of roundupMessage) and must be fresh: nobody can
// import spends into, or link a bank to, someone else's account. The keeper does the accruing.
import type { Db } from "@/db";
import {
  insertEvents,
  MAX_STATEMENT_BYTES,
  parseStatement,
  plaidAad,
  plaidFromEnv,
  sha256Hex,
  spendRows,
  StatementError,
  unlinkSource,
  upsertSource,
  parseSecretKey,
  Sealer,
  type PlaidConfig,
} from "@/keeper";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAddress, isAddress, verifyMessage, type Address, type Hex, type PublicClient } from "viem";

export const SIGNATURE_MAX_AGE_S = 600;
/** New statement rows one user may add in any 7 days (audit M-7). Re-imports of known rows do not count. */
export const DEFAULT_MAX_IMPORT_ROWS_PER_WEEK = 2_000;

export type RoundupAction = "import" | "plaid-link" | "plaid-exchange" | "unlink";

/** The exact text the user's wallet signs. `subject` binds the signature to the payload. */
export function roundupMessage(m: { action: RoundupAction; user: Address; chainId: number; subject: string; issuedAt: number }): string {
  return [
    "Plynth round-up sources",
    `action: ${m.action}`,
    `user: ${getAddress(m.user)}`,
    `chain: ${m.chainId}`,
    `subject: ${m.subject}`,
    `issued: ${m.issuedAt}`,
  ].join("\n");
}

export type RoundupDeps = {
  chainId: number;
  db: Db;
  /** With a client, smart-wallet (ERC-1271/6492) signatures verify too; without, EOA only. */
  pub?: PublicClient;
  plaid?: PlaidConfig | undefined;
  sealer?: Sealer | undefined;
  now?: () => number;
  /** New statement rows per user per rolling 7 days (ROUNDUPS_MAX_ROWS_PER_WEEK). */
  maxRowsPerWeek?: number | undefined;
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (!b || typeof b !== "object") throw new Error();
    return b as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

const str = (b: Record<string, unknown>, k: string, required = true): string | undefined => {
  const v = b[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${k} must be a string`);
  return v;
};

/** Checks the wallet signature and freshness; returns the checksummed user. */
async function authorise(d: RoundupDeps, b: Record<string, unknown>, action: RoundupAction, subject: string): Promise<Address> {
  const userRaw = str(b, "user")!;
  if (!isAddress(userRaw)) throw new HttpError(400, "user must be an address");
  const user = getAddress(userRaw);
  const issuedAt = Number(b.issuedAt);
  if (!Number.isInteger(issuedAt)) throw new HttpError(400, "issuedAt must be unix seconds");
  const now = Math.floor((d.now?.() ?? Date.now()) / 1000);
  if (Math.abs(now - issuedAt) > SIGNATURE_MAX_AGE_S) throw new HttpError(401, "signature expired or from the future");
  const signature = str(b, "signature")! as Hex;
  const message = roundupMessage({ action, user, chainId: d.chainId, subject, issuedAt });
  let ok = false;
  try {
    ok = d.pub ? await d.pub.verifyMessage({ address: user, message, signature }) : await verifyMessage({ address: user, message, signature });
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, "bad signature");
  return user;
}

const SOURCE_KINDS = new Set(["statement", "plaid"]);

export function roundupRoutes(d: RoundupDeps): Hono {
  const app = new Hono();
  const wrap = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: { message: e.message } }, e.status);
      if (e instanceof StatementError) return c.json({ error: { message: e.message } }, 400);
      return c.json({ error: { message: "internal error" } }, 500);
    }
  };
  const needPlaid = () => {
    if (!d.plaid || !d.sealer) throw new HttpError(503, "Plaid is not configured on this server");
    return { plaid: d.plaid, sealer: d.sealer };
  };

  app.post(
    "/import",
    // JSON escaping can grow the text: allow some headroom over the statement cap.
    bodyLimit({ maxSize: MAX_STATEMENT_BYTES * 2, onError: (c) => c.json({ error: { message: "statement too large" } }, 413) }),
    wrap(async (c) => {
      const b = await json(c);
      const content = str(b, "content")!;
      const user = await authorise(d, b, "import", sha256Hex(content));
      const format = str(b, "format", false);
      const debitSign = str(b, "debitSign", false);
      if (format && format !== "csv" && format !== "ofx") throw new HttpError(400, "format must be csv or ofx");
      if (debitSign && debitSign !== "negative" && debitSign !== "positive") throw new HttpError(400, "debitSign must be negative or positive");
      const parsed = parseStatement(content, { format: format as "csv" | "ofx" | undefined, debitSign: debitSign as "negative" | "positive" | undefined, layout: str(b, "layout", false) });
      // Audit M-7: rows per user per week are capped, so one wallet cannot fill the table (the keeper's own accrual
      // limits keep these rows from costing gas).
      const cap = d.maxRowsPerWeek ?? DEFAULT_MAX_IMPORT_ROWS_PER_WEEK;
      const [{ n: recent } = { n: 0 }] = (await d.db.execute(sql`
        select count(*)::int as n from roundup_events
        where chain_id = ${d.chainId} and user_address = ${user.toLowerCase()} and source = 'statement' and created_at >= now() - interval '7 days'`)) as unknown as { n: number }[];
      const spends = spendRows(parsed.rows);
      const known = new Set(
        spends.length === 0
          ? []
          : (
              (await d.db.execute(sql`select row_hash from roundup_events where chain_id = ${d.chainId} and user_address = ${user.toLowerCase()}
                and row_hash in ${sql`(${sql.join(spends.map((x) => sql`${x.rowHash}`), sql`, `)})`}`)) as unknown as { row_hash: string }[]
            ).map((x) => x.row_hash),
      );
      const fresh = spends.filter((x) => !known.has(x.rowHash));
      if (fresh.length > 0 && Number(recent) + fresh.length > cap) throw new HttpError(429, `import limit: at most ${cap} new statement rows per 7 days (${recent} already)`);
      await upsertSource(d, user, "statement", "statement");
      const r = await insertEvents(d, user, "statement", "statement", spends);
      return c.json({
        format: parsed.format,
        layout: parsed.layout,
        rows: parsed.rows.length,
        imported: r.inserted,
        duplicates: r.duplicates,
        skipped: parsed.rows.filter((x) => x.skip).map((x) => ({ line: x.line, reason: x.skip })),
      });
    }),
  );

  app.post(
    "/plaid/link-token",
    wrap(async (c) => {
      const { plaid } = needPlaid();
      const b = await json(c);
      const user = await authorise(d, b, "plaid-link", "");
      const { data } = await plaid.api.linkTokenCreate({
        user: { client_user_id: sha256Hex(`${d.chainId}:${user.toLowerCase()}`) },
        client_name: "Plynth",
        products: ["transactions" as any],
        country_codes: plaid.countryCodes as any,
        language: "en",
      });
      return c.json({ linkToken: data.link_token, expiration: data.expiration });
    }),
  );

  app.post(
    "/plaid/exchange",
    wrap(async (c) => {
      const { plaid, sealer } = needPlaid();
      const b = await json(c);
      const publicToken = str(b, "publicToken")!;
      const user = await authorise(d, b, "plaid-exchange", sha256Hex(publicToken));
      const { data } = await plaid.api.itemPublicTokenExchange({ public_token: publicToken });
      const sealed = await sealer.seal(new TextEncoder().encode(data.access_token), plaidAad(d.chainId, user, data.item_id));
      await upsertSource(d, user, "plaid", data.item_id, sealed);
      return c.json({ itemId: data.item_id, linked: true });
    }),
  );

  app.post(
    "/sources/unlink",
    wrap(async (c) => {
      const b = await json(c);
      const kind = str(b, "kind")!;
      if (!SOURCE_KINDS.has(kind)) throw new HttpError(400, "kind must be statement or plaid");
      const sourceKey = str(b, "sourceKey", false) ?? (kind === "statement" ? "statement" : undefined);
      if (!sourceKey) throw new HttpError(400, "sourceKey is required");
      const user = await authorise(d, b, "unlink", `${kind}:${sourceKey}`);
      const before = await unlinkSource(d, user, kind as "statement" | "plaid", sourceKey);
      if (!before) throw new HttpError(404, "no such source");
      if (kind === "plaid" && before.secretEnc && d.plaid && d.sealer) {
        try {
          const token = new TextDecoder().decode(await d.sealer.open(before.secretEnc, plaidAad(d.chainId, user, sourceKey)));
          await d.plaid.api.itemRemove({ access_token: token });
        } catch {
          // best effort: the token is already forgotten here, and the keeper no longer syncs the item
        }
      }
      return c.json({ unlinked: true });
    }),
  );
  return app;
}

/**
 * ROUNDUPS_ENABLED=1 mounts the routes (they write roundup_sources/roundup_events). Plaid routes also need
 * PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV) and KEEPER_SECRET_KEY (to seal access tokens).
 */
export async function roundupsFromEnv(env: Record<string, string | undefined>, base: Omit<RoundupDeps, "plaid" | "sealer">): Promise<Hono | undefined> {
  if (env.ROUNDUPS_ENABLED !== "1") return undefined;
  const plaid = plaidFromEnv(env);
  const sealer = plaid ? await Sealer.create(parseSecretKey(env.KEEPER_SECRET_KEY)) : undefined;
  const maxRows = Number(env.ROUNDUPS_MAX_ROWS_PER_WEEK);
  return roundupRoutes({ ...base, plaid, sealer, ...(env.ROUNDUPS_MAX_ROWS_PER_WEEK && Number.isInteger(maxRows) && maxRows > 0 ? { maxRowsPerWeek: maxRows } : {}) });
}
