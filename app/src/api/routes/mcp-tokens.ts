// MCP API tokens (todo 30). A token lets an AI agent read one treasury over MCP and file exception requests for
// it; nothing else. The board issues it through the API by signing a plain-text request (EOA or Safe: the
// signature is checked with viem's verifyMessage, which also accepts ERC-1271 contract signatures), so the API
// never needs to trust the caller.
//
// Token = "pmcp_" + base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, "pmcp_" + base64url(claims))).
// Claims: { v: 1, jti, chainId, account, exp }. The token is not stored: `treasury_mcp_tokens` keeps only the
// jti (to list and revoke), and every use re-checks HMAC, expiry, chain, and that the jti is not revoked.
// The jti is derived from the board's signature, so replaying one signed request cannot mint a second token.
import { treasuryMcpTokens } from "@/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { Deps } from "@/api/service";
import { TxInputError } from "@/api/tx";
import { wiring } from "./treasury";

export const MCP_TOKEN_PREFIX = "pmcp_";
export const MAX_TOKEN_DAYS = 90;
/** How far the signed `issuedAt` may be from the server clock (replay window). */
export const ISSUE_SKEW_S = 600;

export type McpClaims = { v: 1; jti: string; chainId: number; account: Address; exp: number };

export class McpAuthError extends Error {}
export class McpUnavailable extends Error {}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

function needSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new McpUnavailable("MCP tokens are not enabled on this server (MCP_TOKEN_SECRET)");
  return secret;
}

export function signToken(secret: string, c: McpClaims): string {
  const body = MCP_TOKEN_PREFIX + b64(JSON.stringify(c));
  return `${body}.${b64(mac(needSecret(secret), body))}`;
}

/** HMAC + shape + expiry. Does not check revocation (see `authenticate`). */
export function verifyToken(secret: string, token: string, nowS = Math.floor(Date.now() / 1000)): McpClaims {
  const s = needSecret(secret);
  if (typeof token !== "string" || !token.startsWith(MCP_TOKEN_PREFIX)) throw new McpAuthError("not an MCP token");
  const dot = token.lastIndexOf(".");
  if (dot < 0) throw new McpAuthError("malformed token");
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1), "base64url");
  const want = mac(s, body);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new McpAuthError("bad token signature");
  let c: McpClaims;
  try {
    c = JSON.parse(Buffer.from(body.slice(MCP_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new McpAuthError("malformed token");
  }
  if (c.v !== 1 || typeof c.jti !== "string" || typeof c.exp !== "number" || typeof c.chainId !== "number") throw new McpAuthError("malformed token");
  if (c.exp <= nowS) throw new McpAuthError("token expired");
  return { ...c, account: getAddress(c.account) };
}

/** Full check for a request: HMAC, expiry, this chain, and not revoked. */
export async function authenticate(d: Pick<Deps, "db" | "chainId" | "mcpSecret">, token: string, nowS?: number): Promise<McpClaims> {
  const c = verifyToken(d.mcpSecret ?? "", token, nowS);
  if (c.chainId !== d.chainId) throw new McpAuthError("token is for another chain");
  const [row] = await d.db.select().from(treasuryMcpTokens).where(eq(treasuryMcpTokens.id, c.jti)).limit(1);
  if (!row || row.account !== c.account.toLowerCase()) throw new McpAuthError("unknown token");
  if (row.revokedAt) throw new McpAuthError("token revoked");
  return c;
}

/**
 * Audit L-14: the off-chain treasury records (desk decisions with their reasons, exceptions and exception requests,
 * the board's MCP token list, a decision's receipt proof, which carries the decision row) are read only with an MCP
 * token scoped to that treasury, sent as `Authorization: Bearer pmcp_...`. Everything derived from the chain (NAV,
 * positions, desks, policy, period closes and the CFO pack, hourly receipt roots, templates) stays public by design:
 * anyone can recompute it from the chain, and publishing it is the point of a policy-enforced treasury.
 */
export async function requireTreasuryReader(d: Pick<Deps, "db" | "chainId" | "mcpSecret">, headers: Headers, account: Address): Promise<McpClaims> {
  const auth = headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new McpAuthError("this treasury record needs an MCP token for the treasury (Authorization: Bearer pmcp_...)");
  const c = await authenticate(d, m[1]!);
  if (c.account.toLowerCase() !== account.toLowerCase()) throw new McpAuthError("token is for another treasury");
  return c;
}

/** The exact text the board signs to issue a token. */
export function issueMessage(i: { chainId: number; account: Address; label: string; issuedAt: number; expiresAt: number }): string {
  return [
    "Plinth MCP token",
    `chain: ${i.chainId}`,
    `account: ${getAddress(i.account)}`,
    `label: ${i.label}`,
    `issued: ${i.issuedAt}`,
    `expires: ${i.expiresAt}`,
    "Grants read access to this treasury and lets the holder file exception requests for the board.",
  ].join("\n");
}

/** The exact text the board signs to revoke a token. */
export function revokeMessage(i: { chainId: number; account: Address; id: string; issuedAt: number }): string {
  return ["Plinth MCP token revoke", `chain: ${i.chainId}`, `account: ${getAddress(i.account)}`, `token: ${i.id}`, `issued: ${i.issuedAt}`].join("\n");
}

async function checkBoardSig(d: Deps, board: Address, message: string, signature: Hex, issuedAt: number, nowS: number) {
  if (Math.abs(issuedAt - nowS) > ISSUE_SKEW_S) throw new TxInputError(`issuedAt must be within ${ISSUE_SKEW_S}s of now`);
  let ok = false;
  try {
    ok = await d.pub.verifyMessage({ address: board, message, signature });
  } catch {
    ok = false;
  }
  if (!ok) throw new McpAuthError("signature is not from the treasury's board");
}

export async function issueMcpToken(d: Deps, account: Address, i: { label: string; issuedAt: number; expiresAt: number; signature: Hex }, nowS = Math.floor(Date.now() / 1000)) {
  const secret = needSecret(d.mcpSecret);
  const w = await wiring(d, account);
  if (!/^[\w .:-]{1,64}$/.test(i.label)) throw new TxInputError("label: 1-64 letters, digits, spaces or . : _ -");
  if (i.expiresAt <= nowS) throw new TxInputError("expiresAt must be in the future");
  if (i.expiresAt - i.issuedAt > MAX_TOKEN_DAYS * 86_400) throw new TxInputError(`a token lives at most ${MAX_TOKEN_DAYS} days`);
  const msg = issueMessage({ chainId: d.chainId, account: w.account, label: i.label, issuedAt: i.issuedAt, expiresAt: i.expiresAt });
  await checkBoardSig(d, w.board, msg, i.signature, i.issuedAt, nowS);
  const jti = keccak256(i.signature).slice(2, 34);
  const inserted = await d.db
    .insert(treasuryMcpTokens)
    .values({ id: jti, chainId: d.chainId, account: w.account.toLowerCase(), label: i.label, issuedBy: w.board.toLowerCase(), expiresAt: new Date(i.expiresAt * 1000) })
    .onConflictDoNothing()
    .returning({ id: treasuryMcpTokens.id });
  if (!inserted.length) throw new TxInputError("this signed request was already used");
  const token = signToken(secret, { v: 1, jti, chainId: d.chainId, account: w.account, exp: i.expiresAt });
  return { id: jti, token, account: w.account, label: i.label, expiresAt: new Date(i.expiresAt * 1000).toISOString() };
}

export async function revokeMcpToken(d: Deps, account: Address, i: { id: string; issuedAt: number; signature: Hex }, nowS = Math.floor(Date.now() / 1000)) {
  const w = await wiring(d, account);
  await checkBoardSig(d, w.board, revokeMessage({ chainId: d.chainId, account: w.account, id: i.id, issuedAt: i.issuedAt }), i.signature, i.issuedAt, nowS);
  const r = await d.db
    .update(treasuryMcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(treasuryMcpTokens.id, i.id), eq(treasuryMcpTokens.account, w.account.toLowerCase())))
    .returning({ id: treasuryMcpTokens.id });
  if (!r.length) throw new TxInputError(`no token ${i.id} for this treasury`);
  return { id: i.id, revoked: true };
}

export async function listMcpTokens(d: Deps, account: Address) {
  await wiring(d, account);
  const rows = await d.db
    .select()
    .from(treasuryMcpTokens)
    .where(and(eq(treasuryMcpTokens.chainId, d.chainId), eq(treasuryMcpTokens.account, account.toLowerCase())))
    .orderBy(desc(treasuryMcpTokens.createdAt));
  return {
    account,
    tokens: rows.map((r) => ({ id: r.id, label: r.label, issuedBy: r.issuedBy, expiresAt: r.expiresAt.toISOString(), revokedAt: r.revokedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
  };
}
