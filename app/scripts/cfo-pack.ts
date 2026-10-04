// bun run cfo-pack --index N [--out DIR] [--from-block B]
// bun run cfo-pack --period-end TS [--out DIR]
//
// Env (app/src/config.ts): TREASURY_RPC_URL, TREASURY_PERIOD_CLOSE, DATABASE_URL. Writes statement.json, positions.csv and
// statement.html to DIR (default ./cfo-pack-<index>). Exits 2 without writing anything if the stored bundle
// does not hash to the on-chain bundleHash (or disagrees with the event in any field).
import { loadConfig } from "@/config";
import { connect, databaseUrl } from "@/db";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { CloseStore } from "@/treasury/close/store";
import { toCsv, toHtml, toJson } from "@/treasury/cfo-pack/render";
import { CfoPackRefused, loadStatement } from "@/treasury/cfo-pack/verify";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = loadConfig();
const rpcUrl = config.TREASURY_RPC_URL;
const pcAddr = config.TREASURY_PERIOD_CLOSE;
if (!rpcUrl || !pcAddr) throw new Error("TREASURY_RPC_URL and TREASURY_PERIOD_CLOSE are required");
const index = arg("--index");
const periodEnd = arg("--period-end");
if (index === undefined && periodEnd === undefined) throw new Error("pass --index N or --period-end TS");

const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }) as PublicClient;
const pc = getAddress(pcAddr);
const { db, close } = connect(databaseUrl());
const store = new CloseStore(db);
let code = 0;
try {
  const chainId = await pub.getChainId();
  // The committed row's block (if any) narrows the log scan; the row's content is not trusted for anything else.
  let fromBlock = arg("--from-block") ? BigInt(arg("--from-block")!) : undefined;
  let toBlock: bigint | undefined;
  if (periodEnd !== undefined && fromBlock === undefined) {
    const hint = await store.committedAt(chainId, pc, BigInt(periodEnd));
    if (hint?.blockNumber) fromBlock = toBlock = hint.blockNumber;
  }
  const s = await loadStatement(
    pub,
    pc,
    { index: index === undefined ? undefined : Number(index), periodEnd: periodEnd === undefined ? undefined : BigInt(periodEnd), fromBlock, toBlock },
    async (cid, addr, h) => (await store.byBundleHash(cid, addr, h))?.bundleJson,
  );
  const out = resolve(arg("--out") ?? `cfo-pack-${s.event.index}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "statement.json"), JSON.stringify(toJson(s), null, 2) + "\n");
  writeFileSync(join(out, "positions.csv"), toCsv(s));
  writeFileSync(join(out, "statement.html"), toHtml(s));
  console.log(`[cfo-pack] statement #${s.event.index} written to ${out}`);
} catch (e) {
  if (e instanceof CfoPackRefused) {
    console.error(`[cfo-pack] ${e.message}`);
    code = 2;
  } else throw e;
} finally {
  await close();
}
process.exit(code);
