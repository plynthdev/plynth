// Runs per-treasury services as --once passes against testnet with an explicit environment (never app/.env),
// the plynth_testnet database and the desk keystores; reads their rows back for the report.
import { connect, databaseUrl, withDatabase } from "@/db";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { expect } from "../../fork/exercise/core";
import { APP, DB_NAME, keystorePath, passwordFile, RPC, TESTNET_CHAIN_ID, TESTNET_DIR, WALLETS } from "../lib";
import type { TCtx } from "./ctx";

export const testnetDbUrl = () => withDatabase(databaseUrl(), DB_NAME);

let conn: ReturnType<typeof connect> | undefined;
export function db() {
  conn ??= connect(testnetDbUrl());
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
    DATABASE_URL: testnetDbUrl(),
    TREASURY_RPC_URL: RPC,
    TREASURY_CHAIN_ID: String(TESTNET_CHAIN_ID),
    TREASURY_POLL_MS: "1000",
    TREASURY_CONTROLLER_KEYSTORE: keystorePath(WALLETS.controller),
    TREASURY_CONTROLLER_KEYSTORE_PASSWORD_FILE: passwordFile(WALLETS.controller),
    LOG_LEVEL: "info",
    ...extra,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
}

/** Runs `bun <app>/<entry> ...args` from the testnet dir (so Bun does not load app/.env); returns code + output. */
export async function runOnce(entry: string, args: string[], env: Record<string, string>, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", join(APP, entry), ...args], { cwd: TESTNET_DIR, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: `${out}${err}` };
}

export type DeskRow = { id: number; desk: string; action: string; status: string; reason: string | null; asset: string | null; notional_usd: string | null; tx_hash: string | null };

export async function deskRows(account: string, afterId = 0): Promise<DeskRow[]> {
  return (await db().sql`select id, desk, action, status, reason, asset, notional_usd, tx_hash from desk_actions where lower(account) = ${account.toLowerCase()} and id > ${afterId} order by id`) as unknown as DeskRow[];
}

/** One `treasury-desks --once` pass with the desk keystores; each desk action it logged becomes a step. */
export async function deskPass(x: TCtx, account: Address, desksConfig: string, label: string): Promise<DeskRow[]> {
  const { r } = x;
  const after = Number(x.data.lastDeskRow ?? 0);
  const run = await runOnce("src/bin/treasury-desks.ts", ["--once"], treasuryEnv({
    TREASURY_CONFIG: desksConfig,
    TREASURY_CASH_DESK_KEYSTORE: keystorePath(WALLETS.cashDesk),
    TREASURY_CASH_DESK_KEYSTORE_PASSWORD_FILE: passwordFile(WALLETS.cashDesk),
    TREASURY_EQUITY_DESK_KEYSTORE: keystorePath(WALLETS.equityDesk),
    TREASURY_EQUITY_DESK_KEYSTORE_PASSWORD_FILE: passwordFile(WALLETS.equityDesk),
    TREASURY_JURY: "off",
  }));
  const rows = await deskRows(account, after);
  if (rows.length) x.data.lastDeskRow = rows[rows.length - 1]!.id;
  await r.check(`treasury-desks --once (${label}) exits cleanly`, async () => {
    expect(run.code === 0, `exit ${run.code}: ${run.out.slice(-600)}`);
    return `${rows.length} desk actions logged`;
  }, "desk runner");
  for (const row of rows) {
    await r.external(`desk runner (${label}): ${row.desk} ${row.action}${row.asset ? ` ${r.who(row.asset as Address)}` : ""} -> ${row.status}${row.reason ? ` (${row.reason})` : ""}`, `${row.desk} desk`, async () => {
      expect(row.status !== "reverted", `reverted: ${row.reason}`);
      return { tx: (row.tx_hash ?? undefined) as Hex | undefined, assertion: `desk_actions row ${row.id}: ${row.status}` };
    });
  }
  return rows;
}
