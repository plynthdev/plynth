// bun run treasury:valuer          -> a NAV mark per treasury every TREASURY_MARK_INTERVAL_S (default 60)
// bun run treasury:valuer --once   -> one pass, then exit (tests use this)
//
// Env: TREASURY_RPC_URL, DATABASE_URL (nav_marks), and the treasuries: TREASURY_ACCOUNTS (comma-separated)
// and/or TREASURY_FACTORY (every treasury it created, re-read each pass). No key: read-only on chain.
import { connect, databaseUrl } from "@plynth/db";
import { createPublicClient, http, type PublicClient } from "viem";
import { markOnce, treasuriesFromEnv } from "./service";

const once = process.argv.includes("--once");
const rpcUrl = process.env.TREASURY_RPC_URL;
if (!rpcUrl) throw new Error("TREASURY_RPC_URL is required");
const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }) as PublicClient;
const chainId = await pub.getChainId();
const { db, close } = connect(databaseUrl());
const say = (m: string) => console.log(`[valuer ${chainId}] ${m}`);

async function pass() {
  const r = await markOnce({ pub, db, chainId, accounts: await treasuriesFromEnv(pub), say });
  say(`marked ${r.marks.length} treasuries, ${r.errors.length} errors: ${r.marks.map((m) => `${m.account}=${m.navUsd}`).join(" ")}`);
  return r;
}

if (once) {
  let code = 0;
  try {
    if ((await pass()).errors.length) code = 1;
  } finally {
    await close();
  }
  process.exit(code);
}
const interval = Number(process.env.TREASURY_MARK_INTERVAL_S || 60) * 1000;
for (;;) {
  const started = Date.now();
  try {
    await pass();
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(Math.max(0, interval - (Date.now() - started))); // a mark every interval, not interval + read time
}
