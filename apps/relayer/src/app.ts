// Gasless claims for Quiet delivery. POST /claim {token, stealth, to, raw, deadline, sig}:
// shape check -> rate limit per IP -> destination check -> deadline -> EIP-712 signature recovered off-chain
// against the current on-chain nonce -> rate limit per stealth address -> balance -> eth_call simulation ->
// send from the relayer's own key -> { txHash }. The relayer pays the gas; there is no fee in v1.
// It cannot move funds anywhere the stealth key did not sign for: StealthClaims re-verifies the signature.
import { claimDomain, claimTypes, type ClaimMessage } from "@plynth/sdk/stealth";
import { Hono, type Context } from "hono";
import { getAddress, isAddress, isHex, recoverTypedDataAddress, size, type Address, type Hex } from "viem";
import { RateLimiter } from "./ratelimit";

export type ClaimArgs = { token: Address; stealth: Address; to: Address; raw: bigint; deadline: bigint; sig: Hex };
export type SimOutcome = { ok: true } | { ok: false; error: string };

export type RelayerDeps = {
  chainId: number;
  stealthClaims: Address;
  /** Every Plynth contract address (any case). Claims to these are refused: tokens would be stuck or misattributed. */
  plynth: Iterable<string>;
  relayer: Address;
  nonceOf: (stealth: Address) => Promise<bigint>;
  balanceOf: (token: Address, stealth: Address) => Promise<bigint>;
  simulate: (a: ClaimArgs) => Promise<SimOutcome>;
  send: (a: ClaimArgs) => Promise<Hex>;
  /** Seconds, chain-comparable. */
  now?: () => number;
  ipOf?: (c: Context) => string;
  ipLimiter?: RateLimiter;
  stealthLimiter?: RateLimiter;
  log?: (m: string) => void;
};

const UINT256_MAX = (1n << 256n) - 1n;

function parseUint(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return null;
  const b = BigInt(v);
  return b <= UINT256_MAX ? b : null;
}

export function parseClaim(body: unknown): ClaimArgs | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  for (const k of ["token", "stealth", "to"]) if (typeof b[k] !== "string" || !isAddress(b[k] as string, { strict: false })) return `${k} must be an address`;
  const raw = parseUint(b.raw);
  if (raw === null || raw === 0n) return "raw must be a positive integer";
  const deadline = parseUint(b.deadline);
  if (deadline === null) return "deadline must be an integer (unix seconds)";
  if (typeof b.sig !== "string" || !isHex(b.sig) || size(b.sig) !== 65) return "sig must be a 65-byte hex signature";
  return { token: getAddress(b.token as string), stealth: getAddress(b.stealth as string), to: getAddress(b.to as string), raw, deadline, sig: b.sig as Hex };
}

export function relayerApp(d: RelayerDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const ipOf = d.ipOf ?? ((c: Context) => c.req.header("x-real-ip") ?? "unknown");
  const ipLimiter = d.ipLimiter ?? new RateLimiter(20, 60_000);
  const stealthLimiter = d.stealthLimiter ?? new RateLimiter(3, 60_000);
  const plynth = new Set([...d.plynth].map((a) => a.toLowerCase()));
  plynth.add(d.stealthClaims.toLowerCase());
  const inFlight = new Set<string>();
  const log = d.log ?? (() => {});

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, chainId: d.chainId, stealthClaims: d.stealthClaims, relayer: d.relayer }));

  app.post("/claim", async (c) => {
    if (!ipLimiter.take(ipOf(c))) return c.json({ error: "rate limited (ip)" }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const a = parseClaim(body);
    if (typeof a === "string") return c.json({ error: a }, 400);
    if (plynth.has(a.to.toLowerCase())) return c.json({ error: "destination is a Plynth contract" }, 400);
    if (a.deadline < BigInt(Math.floor(now()))) return c.json({ error: "expired" }, 400);

    const nonce = await d.nonceOf(a.stealth);
    const message: ClaimMessage = { token: a.token, stealth: a.stealth, to: a.to, raw: a.raw, nonce, deadline: a.deadline };
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ domain: claimDomain(d.chainId, d.stealthClaims), types: claimTypes, primaryType: "Claim", message, signature: a.sig });
    } catch {
      return c.json({ error: "bad signature" }, 401);
    }
    if (signer !== a.stealth) return c.json({ error: "bad signature (not signed by the stealth address for its current nonce)" }, 401);
    // Per-stealth limit only after the signature checks out, so nobody can exhaust another stealth's quota.
    if (!stealthLimiter.take(a.stealth.toLowerCase())) return c.json({ error: "rate limited (stealth address)" }, 429);

    const flightKey = `${a.stealth.toLowerCase()}:${nonce}`;
    if (inFlight.has(flightKey)) return c.json({ error: "a claim for this nonce is already being sent" }, 409);
    inFlight.add(flightKey);
    try {
      const bal = await d.balanceOf(a.token, a.stealth);
      if (bal < a.raw) return c.json({ error: `insufficient balance (${bal})` }, 400);
      const sim = await d.simulate(a);
      if (!sim.ok) return c.json({ error: `simulation reverted: ${sim.error}` }, 400);
      const txHash = await d.send(a);
      log(`claim sent ${txHash}`);
      return c.json({ txHash });
    } catch (err) {
      log(`claim failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
      return c.json({ error: "could not send" }, 502);
    } finally {
      inFlight.delete(flightKey);
    }
  });
  return app;
}
