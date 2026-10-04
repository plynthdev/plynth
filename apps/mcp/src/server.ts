// Plinth MCP server (todo 30, spec §5). One treasury per API token: every tool reads the account the token is
// scoped to (tools take no account argument, so a token for treasury A can never read treasury B).
//
// Read-only tools: nav, positions, policy, close_latest. One write: exceptions_request files an exception
// request for the board; it changes nothing on-chain and grants nothing (the board still decides).
// Transports: stdio (token from PLINTH_MCP_TOKEN, checked once at start) and streamable HTTP (Bearer token,
// checked on every request, stateless).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  authenticate,
  closeGet,
  closeList,
  fileExceptionRequest,
  McpAuthError,
  McpUnavailable,
  navLatest,
  policyCurrent,
  positionsList,
  TreasuryNotFound,
  TxInputError,
  type Deps,
  type McpClaims,
} from "@plynth/api";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

export const SERVER_INFO = { name: "plinth-treasury", version: "1.0.0" };

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** Tool errors: a caller mistake (bad input) is shown to the agent; anything else is "internal error". */
async function run(f: () => Promise<unknown>) {
  try {
    return json(await f());
  } catch (e) {
    if (e instanceof TxInputError || e instanceof TreasuryNotFound) return fail(e.message);
    return fail("internal error");
  }
}

/** An MCP server bound to one authenticated token. */
export function createMcpServer(d: Deps, claims: McpClaims): McpServer {
  const account = claims.account;
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("nav", { title: "NAV", description: "Current NAV of this treasury, band weights and feed-hold flag, from one pinned block.", annotations: ro }, () =>
    run(() => navLatest(d, account)),
  );
  server.registerTool("positions", { title: "Positions", description: "Every holding with amount, USD value, band and weight, from one pinned block.", annotations: ro }, () =>
    run(() => positionsList(d, account)),
  );
  server.registerTool("policy", { title: "Policy", description: "The policy in force (version, hash, bands, caps) and any pending timelocked change.", annotations: ro }, () =>
    run(() => policyCurrent(d, account)),
  );
  server.registerTool(
    "close_latest",
    { title: "Latest close", description: "The latest committed period-close statement, with its bundle when its hash matches the chain.", annotations: ro },
    () =>
      run(async () => {
        const l = await closeList(d, account);
        const last = l.closes[0];
        if (!last) return { account, close: null, nextPeriodEnd: l.nextPeriodEnd };
        return closeGet(d, account, last.index);
      }),
  );
  server.registerTool(
    "exceptions_request",
    {
      title: "Request an exception",
      description:
        "File a request asking the board to allow an operation the policy would refuse. Only files the request: nothing is executed or approved; the board decides.",
      inputSchema: {
        action: z.string().describe("what to allow, e.g. buy, sell, raise_cap"),
        reason: z.string().describe("why, 10-2000 characters"),
        desk: z.string().optional(),
        asset: z.string().optional().describe("token address, if the request is about one asset"),
        amountUsd: z.string().optional().describe("USD amount as a decimal string"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        if (a.asset !== undefined && !isAddress(a.asset, { strict: false })) throw new TxInputError("asset is not an address");
        return fileExceptionRequest(d, account, claims.jti, { ...a, asset: a.asset ? getAddress(a.asset) : undefined });
      }),
  );
  return server;
}

/**
 * Streamable HTTP handler (stateless): POST /mcp with `Authorization: Bearer <token>`. A fresh server and
 * transport per request, bound to that request's token.
 */
export function httpHandler(d: Deps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return Response.json({ error: "not found" }, { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    let claims: McpClaims;
    try {
      claims = await authenticate(d, token);
    } catch (e) {
      if (e instanceof McpUnavailable) return Response.json({ error: e.message }, { status: 503 });
      const msg = e instanceof McpAuthError ? e.message : "unauthorized";
      return Response.json({ error: msg }, { status: 401, headers: { "www-authenticate": 'Bearer realm="plinth-mcp"' } });
    }
    if (req.method !== "POST") return Response.json({ error: "stateless server: POST only" }, { status: 405, headers: { allow: "POST" } });
    const server = createMcpServer(d, claims);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
