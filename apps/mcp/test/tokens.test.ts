// Todo 30: MCP API tokens (pure HMAC rules; issuance against the chain is in apps/api/test/treasury.anvil.test.ts).
import { describe, expect, test } from "bun:test";
import { issueMessage, McpAuthError, McpUnavailable, signToken, verifyToken, type McpClaims } from "@plynth/api";

const SECRET = "mcp-unit-secret-0123456789abcdef-0123456789"; // test-key
const claims: McpClaims = { v: 1, jti: "0123456789abcdef0123456789abcdef", chainId: 31337, account: "0x00000000000000000000000000000000000000Aa", exp: 2_000_000_000 };

describe("MCP tokens", () => {
  test("a token round-trips its claims", () => {
    const t = signToken(SECRET, claims);
    expect(t.startsWith("pmcp_")).toBe(true);
    expect(verifyToken(SECRET, t, 1_900_000_000)).toEqual({ ...claims, account: "0x00000000000000000000000000000000000000AA" });
  });

  test("any change to the claims, or another secret, breaks the HMAC", () => {
    const t = signToken(SECRET, claims);
    const [body, mac] = t.split(".");
    const forged = `pmcp_${Buffer.from(JSON.stringify({ ...claims, account: "0x00000000000000000000000000000000000000bb" })).toString("base64url")}.${mac}`;
    expect(() => verifyToken(SECRET, forged, 1_900_000_000)).toThrow(McpAuthError);
    expect(() => verifyToken(`${SECRET}x`, t, 1_900_000_000)).toThrow(/signature/);
    expect(() => verifyToken(SECRET, `${body}.AAAA`, 1_900_000_000)).toThrow(McpAuthError);
    expect(() => verifyToken(SECRET, "Bearer nope", 1_900_000_000)).toThrow(/not an MCP token/);
  });

  test("an expired token is refused", () => {
    const t = signToken(SECRET, claims);
    expect(() => verifyToken(SECRET, t, claims.exp)).toThrow(/expired/);
  });

  test("a missing or short secret disables tokens instead of signing with a weak key", () => {
    expect(() => signToken("short", claims)).toThrow(McpUnavailable);
    expect(() => verifyToken("", "pmcp_x.y")).toThrow(McpUnavailable);
  });

  test("the signed issue message names chain, account, label and both times", () => {
    const m = issueMessage({ chainId: 31337, account: claims.account, label: "ops", issuedAt: 1, expiresAt: 2 });
    for (const s of ["chain: 31337", "account: 0x00000000000000000000000000000000000000AA", "label: ops", "issued: 1", "expires: 2"]) expect(m).toContain(s);
  });
});
