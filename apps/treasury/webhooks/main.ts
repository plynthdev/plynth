// bun run treasury:webhooks add --account 0x.. --url https://.. --events guard.denied,close.committed --secret-env NAME
// bun run treasury:webhooks list [--account 0x..]
// bun run treasury:webhooks disable --id N
// bun run treasury:webhooks run [--once]      -> polls desk_actions/closes every TREASURY_WEBHOOK_INTERVAL_S (default 15)
//
// Env: DATABASE_URL, TREASURY_CHAIN_ID (or TREASURY_RPC_URL to read it). The subscription secret is read from the
// environment variable named by --secret-env so it never appears in shell history or logs; `list` never prints it.
import { connect, databaseUrl } from "@plynth/db";
import { createPublicClient, http } from "viem";
import { WebhookDispatcher, WebhookStore } from "./dispatcher";

const [cmd] = process.argv.slice(2);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function chainId(): Promise<number> {
  if (process.env.TREASURY_CHAIN_ID) return Number(process.env.TREASURY_CHAIN_ID);
  const rpc = process.env.TREASURY_RPC_URL;
  if (!rpc) throw new Error("set TREASURY_CHAIN_ID or TREASURY_RPC_URL");
  return createPublicClient({ transport: http(rpc) }).getChainId();
}

const { db, close } = connect(databaseUrl());
let code = 0;
try {
  const id = await chainId();
  const store = new WebhookStore(db);
  if (cmd === "add") {
    const envName = arg("--secret-env");
    const secret = envName ? process.env[envName] : undefined;
    if (!secret) throw new Error("--secret-env NAME must name a set environment variable holding the HMAC secret");
    const wid = await store.add(id, arg("--account") ?? "", arg("--url") ?? "", secret, (arg("--events") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    console.log(`[webhooks] subscription ${wid} active`);
  } else if (cmd === "list") {
    console.log(JSON.stringify(await store.list(id, arg("--account")), null, 2));
  } else if (cmd === "disable") {
    await store.disable(Number(arg("--id")));
    console.log(`[webhooks] subscription ${arg("--id")} disabled`);
  } else if (cmd === "run") {
    const d = new WebhookDispatcher(db, { chainId: id });
    const interval = Number(process.env.TREASURY_WEBHOOK_INTERVAL_S ?? 15) * 1000;
    for (;;) {
      const r = await d.pollOnce();
      const sent = r.filter((x) => !x.skipped);
      if (sent.length) console.log(`[webhooks ${id}] ${sent.filter((x) => x.ok).length}/${sent.length} delivered`);
      if (process.argv.includes("--once")) break;
      await Bun.sleep(interval);
    }
  } else {
    throw new Error("usage: add | list | disable | run [--once]");
  }
} catch (e) {
  console.error(`[webhooks] ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  await close();
}
process.exit(code);
