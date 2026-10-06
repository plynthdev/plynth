// Runs the per-treasury services (desks, close, risk, receipts, reconciler, cfo-pack) as --once passes against
// the fork, with an explicit environment (never app/.env) and the fork database.
import { connect, databaseUrl, withDatabase } from "@/db";
import { join } from "node:path";
import { APP, DB_NAME, devKey, FORK_DIR, ROLE, RPC } from "../lib";

export const forkDbUrl = () => withDatabase(databaseUrl(), DB_NAME);

let conn: ReturnType<typeof connect> | undefined;
/** The fork's database (read-only use: service rows, desk actions, closes). */
export function db() {
  conn ??= connect(forkDbUrl());
  return conn;
}
export async function closeDb() {
  await conn?.close();
  conn = undefined;
}

export function treasuryEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    DATABASE_URL: forkDbUrl(),
    TREASURY_RPC_URL: RPC,
    TREASURY_POLL_MS: "100",
    TREASURY_CONTROLLER_KEY: devKey(ROLE.controller),
    LOG_LEVEL: "info",
    ...extra,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
}

/** Runs `bun <app>/<entry> ...args` from the fork dir (so Bun does not load app/.env); returns code + output. */
export async function runOnce(entry: string, args: string[], env: Record<string, string>, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", join(APP, entry), ...args], { cwd: FORK_DIR, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: `${out}${err}` };
}

export type DeskRow = { id: number; desk: string; action: string; status: string; reason_code: number | null; reason: string | null; asset: string | null; amount: string | null; notional_usd: string | null; tx_hash: string | null; beacon_key: string | null };

export async function deskRows(account: string, afterId = 0): Promise<DeskRow[]> {
  return (await db().sql`select id, desk, action, status, reason_code, reason, asset, amount, notional_usd, tx_hash, beacon_key from desk_actions where lower(account) = ${account.toLowerCase()} and id > ${afterId} order by id`) as unknown as DeskRow[];
}
