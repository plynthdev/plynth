// bun run treasury-webhooks add --account 0x.. --url https://.. --events guard.denied,close.committed --secret-env NAME
// bun run treasury-webhooks list [--account 0x..]
// bun run treasury-webhooks disable --id N
// bun run treasury-webhooks run [--once]      -> polls desk_actions/closes every TREASURY_WEBHOOK_INTERVAL_S (default 15);
//                                                GET /health on TREASURY_WEBHOOKS_PORT (default 8799) unless --once
//
// Env (config.ts): DATABASE_URL, TREASURY_CHAIN_ID (or TREASURY_RPC_URL to read it). The subscription secret is read from the
// environment variable named by --secret-env so it never appears in shell history or logs; `list` never prints it.
import { keysFor, loadConfig, namedSecret, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { serveHealth } from "@/lib/health";
import { createPublicClient, http } from "viem";
import { WebhookDispatcher, WebhookStore } from "@/treasury/webhooks/dispatcher";

const [cmd] = process.argv.slice(2);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const config = loadConfig();

async function chainId(): Promise<number> {
  if (config.TREASURY_CHAIN_ID) return config.TREASURY_CHAIN_ID;
  const rpc = config.TREASURY_RPC_URL;
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
    const secret = envName ? namedSecret(envName) : undefined;
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
    const interval = config.TREASURY_WEBHOOK_INTERVAL_S * 1000;
    const once = process.argv.includes("--once");
    let polls = 0;
    if (!once) {
      const health = serveHealth("treasury-webhooks", config.TREASURY_WEBHOOKS_PORT, () => ({ chainId: id, polls }));
      console.log(`[webhooks ${id}] every ${interval / 1000} s, /health on :${health.port} ${JSON.stringify(safeConfigSummary(config, keysFor("TREASURY_WEBHOOK", "LOG_")))}`);
    }
    for (;;) {
      const r = await d.pollOnce();
      polls++;
      const sent = r.filter((x) => !x.skipped);
      if (sent.length) console.log(`[webhooks ${id}] ${sent.filter((x) => x.ok).length}/${sent.length} delivered`);
      if (once) break;
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
