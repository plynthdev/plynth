// bun run mcp            -> streamable HTTP on MCP_PORT (default 8792), POST /mcp with a Bearer token
// bun run mcp --stdio    -> stdio transport for a local agent; the token comes from PLINTH_MCP_TOKEN
//
// Env (config.ts): RPC_URL (or TREASURY_RPC_URL), DATABASE_URL, MCP_TOKEN_SECRET (the same secret the API issues
// tokens with), DEPLOYMENT_JSON (optional path; default app/deployments/<chainid>.json + <chainid>-treasury.json).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticate, BlockTimes, type ApiDeployment } from "@/api";
import { DEFAULT_DEPLOYMENTS_DIR, keysFor, loadConfig, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { createMcpServer, httpHandler } from "@/mcp/server";

const stdio = process.argv.includes("--stdio");
const log = (m: string) => console.error(`[mcp] ${m}`); // stderr: stdout is the stdio transport
const config = loadConfig();
const rpcUrl = config.RPC_URL ?? config.TREASURY_RPC_URL;
if (!rpcUrl) throw new Error("RPC_URL is required");
const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }) as PublicClient;
const chainId = await pub.getChainId();

/** Only the treasury addresses matter here; the consumer fields are placeholders the treasury tools never read. */
function deployment(): ApiDeployment {
  const root = DEFAULT_DEPLOYMENTS_DIR;
  const files = config.DEPLOYMENT_JSON ? [config.DEPLOYMENT_JSON] : [join(root, `${chainId}.json`), join(root, `${chainId}-treasury.json`)];
  const j: Record<string, unknown> = {};
  for (const f of files) if (existsSync(f)) Object.assign(j, JSON.parse(readFileSync(f, "utf8")));
  const a = (k: string): Address | undefined => (typeof j[k] === "string" && BigInt(j[k] as string) !== 0n ? getAddress(j[k] as string) : undefined);
  const Z = "0x0000000000000000000000000000000000000000" as Address;
  return {
    vault: Z,
    crowd: Z,
    beacon: Z,
    valuer: a("valuer") ?? Z,
    usdg: a("usdg") ?? Z,
    stocks: [],
    deployBlock: 0n,
    treasuryFactory: a("treasuryFactory"),
    treasuryFactoryBlock: j.treasuryFactoryBlock !== undefined ? BigInt(j.treasuryFactoryBlock as string) : undefined,
    receipts: a("receipts"),
    templateRegistry: a("templateRegistry"),
  };
}

const { db } = connect(databaseUrl());
const d = { chainId, pub, db, dep: deployment(), blockTimes: new BlockTimes(pub), mcpSecret: config.MCP_TOKEN_SECRET };

if (stdio) {
  const claims = await authenticate(d, config.PLINTH_MCP_TOKEN ?? "");
  const server = createMcpServer(d, claims);
  await server.connect(new StdioServerTransport());
  log(`stdio server for ${claims.account} on chain ${chainId}`);
} else {
  const s = Bun.serve({ port: config.MCP_PORT, fetch: httpHandler(d) });
  log(`HTTP on :${s.port}/mcp (chain ${chainId}) ${JSON.stringify(safeConfigSummary(config, keysFor("MCP_", "DEPLOYMENT_", "LOG_")))}`);
}
