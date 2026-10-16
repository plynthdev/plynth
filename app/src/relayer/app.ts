// Gasless claims for Quiet delivery. POST /claim {token, stealth, to, raw, deadline, sig}:
// shape check -> rate limit per IP -> destination check -> deadline -> EIP-712 signature recovered off-chain
// against the current on-chain nonce -> rate limit per stealth address -> balance -> eth_call simulation ->
// send from the relayer's own key -> { txHash }. The relayer pays the gas; StealthClaims takes no fee, so a claim
// below the per-token minimum (RELAYER_CLAIM_MIN_RAW, audit L-12) is refused: the user claims it from their own wallet.
// It cannot move funds anywhere the stealth key did not sign for: StealthClaims re-verifies the signature.
// Rate limits key IPv4 addresses whole and IPv6 addresses by their /64 (one subscriber's prefix; audit M-8).
//
// Hidden Vault withdraws (todo 16). POST /withdraw {proof, pub}: shape check -> rate limit per IP ->
// recipient is not a Plynth contract -> amount and relayerFee > 0, relayerFee >= the minimum for the asset (an asset
// without one is not relayed; audit M-8) -> one in flight per
// nullifier -> nullifier unspent and root known (on-chain reads) -> eth_call simulation -> send -> { txHash }.
// The proof binds recipient, amount, fee and the encrypted change (ext_hash), so the relayer cannot redirect
// funds or strand the change note by swapping its ciphertext; it keeps pub.relayerFee.
import { claimDomain, claimTypes, type ClaimMessage } from "@plynth/sdk/stealth";
import type { PublicSwap, PublicWithdraw } from "@plynth/sdk/vault";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getAddress, isAddress, isHex, recoverTypedDataAddress, size, type Address, type Hex } from "viem";
import { ipKey, RateLimiter } from "./ratelimit";

export type ClaimArgs = { token: Address; stealth: Address; to: Address; raw: bigint; deadline: bigint; sig: Hex };
export type SimOutcome = { ok: true } | { ok: false; error: string };

export type WithdrawArgs = { proof: Hex; pub: PublicWithdraw };

export type WithdrawDeps = {
  pool: Address;
  /** Minimum relayer fee in raw units of `asset`; undefined = this asset is not relayed. Never below 1. */
  minFee: (asset: Address) => bigint | undefined;
  nullifierSpent: (nullifier: Hex) => Promise<boolean>;
  isKnownRoot: (root: Hex) => Promise<boolean>;
  simulate: (w: WithdrawArgs) => Promise<SimOutcome>;
  send: (w: WithdrawArgs) => Promise<Hex>;
};

export type SwapArgs = { proof: Hex; pub: PublicSwap; maxSlippageBps: number; encryptedChange: Hex; encryptedOut: Hex };
export type SettleArgs = { proof: Hex; root: Hex; nullifier: Hex; outCommitment: Hex; encryptedOut: Hex };

/**
 * Private sell / buy / park through ShieldedTrade (SDK lead from the audit): sent from the user's own wallet a swap
 * names that wallet as the trader, so the relayer submits it and keeps the proven relayerFee. Settle (a swap output
 * into a v1 note) carries no fee; it is relayed so that step does not link the wallet either.
 */
export type TradeDeps = {
  trade: Address;
  /** Same table as withdraws: minimum fee in raw units of the input asset; undefined = not relayed. */
  minFee: (asset: Address) => bigint | undefined;
  nullifierSpent: (nullifier: Hex) => Promise<boolean>;
  isKnownRoot: (root: Hex) => Promise<boolean>;
  simulateSwap: (s: SwapArgs) => Promise<SimOutcome>;
  sendSwap: (s: SwapArgs) => Promise<Hex>;
  simulateSettle: (s: SettleArgs) => Promise<SimOutcome>;
  sendSettle: (s: SettleArgs) => Promise<Hex>;
};

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
  /** Hidden Vault withdraws; absent = POST /withdraw answers 503. */
  withdraw?: WithdrawDeps | undefined;
  /** Private trades (ShieldedTrade swap and settle); absent = POST /swap and /settle answer 503. */
  trade?: TradeDeps | undefined;
  /** Smallest claim relayed per token (raw); undefined = token not relayed. Absent = no minimum (tests, local). */
  claimMin?: ((token: Address) => bigint | undefined) | undefined;
  /** Exact browser origins allowed to call the relayer (the web app). Absent = no CORS headers (server-to-server only). */
  corsOrigins?: string[] | undefined;
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

const MAX_PROOF_BYTES = 32_768;
const MAX_NOTE_BYTES = 512;
const isWord = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export function parseWithdraw(body: unknown): WithdrawArgs | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.proof !== "string" || !isHex(b.proof) || size(b.proof) === 0 || size(b.proof) > MAX_PROOF_BYTES) return "proof must be hex bytes";
  const p = b.pub as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return "pub must be an object";
  for (const k of ["root", "nullifier", "changeCommitment"]) if (!isWord(p[k])) return `pub.${k} must be a 32-byte hex word`;
  for (const k of ["asset", "recipient"]) if (typeof p[k] !== "string" || !isAddress(p[k] as string, { strict: false })) return `pub.${k} must be an address`;
  const amount = parseUint(p.amount);
  const relayerFee = parseUint(p.relayerFee);
  if (amount === null || amount === 0n || amount >= 1n << 128n) return "pub.amount must be a positive integer below 2^128";
  // A zero fee would make the relayer pay for the transaction, and a zero amount moves nothing (audit M-8).
  if (relayerFee === null || relayerFee === 0n || relayerFee > amount) return "pub.relayerFee must be a positive integer <= amount";
  if (typeof p.encryptedChange !== "string" || !isHex(p.encryptedChange) || size(p.encryptedChange) > MAX_NOTE_BYTES) return "pub.encryptedChange must be hex, at most 512 bytes";
  return {
    proof: b.proof as Hex,
    pub: {
      root: p.root as Hex,
      nullifier: p.nullifier as Hex,
      changeCommitment: p.changeCommitment as Hex,
      asset: getAddress(p.asset as string),
      amount,
      recipient: getAddress(p.recipient as string),
      relayerFee,
      encryptedChange: p.encryptedChange as Hex,
    },
  };
}

const MAX_SLIPPAGE_BPS = 500;
const U128 = 1n << 128n;

export function parseSwap(body: unknown): SwapArgs | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.proof !== "string" || !isHex(b.proof) || size(b.proof) === 0 || size(b.proof) > MAX_PROOF_BYTES) return "proof must be hex bytes";
  const p = b.pub as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return "pub must be an object";
  for (const k of ["root", "nullifier", "changeCommitment", "outPartial"]) if (!isWord(p[k])) return `pub.${k} must be a 32-byte hex word`;
  for (const k of ["assetIn", "assetOut"]) if (typeof p[k] !== "string" || !isAddress(p[k] as string, { strict: false })) return `pub.${k} must be an address`;
  const amountIn = parseUint(p.amountIn);
  const relayerFee = parseUint(p.relayerFee);
  const minOut = parseUint(p.minOut);
  const deadline = parseUint(p.deadline);
  if (amountIn === null || amountIn === 0n || amountIn >= U128) return "pub.amountIn must be a positive integer below 2^128";
  if (relayerFee === null || relayerFee === 0n || relayerFee >= amountIn) return "pub.relayerFee must be a positive integer below amountIn";
  if (minOut === null || minOut >= U128) return "pub.minOut must be an integer below 2^128";
  if (deadline === null || deadline >= 1n << 64n) return "pub.deadline must be unix seconds";
  const slip = b.maxSlippageBps;
  if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > MAX_SLIPPAGE_BPS) return `maxSlippageBps must be an integer 0..${MAX_SLIPPAGE_BPS}`;
  for (const k of ["encryptedChange", "encryptedOut"]) if (typeof b[k] !== "string" || !isHex(b[k]) || size(b[k] as Hex) > MAX_NOTE_BYTES) return `${k} must be hex, at most 512 bytes`;
  if (size(b.encryptedOut as Hex) === 0) return "encryptedOut must not be empty";
  return {
    proof: b.proof as Hex,
    pub: {
      root: p.root as Hex,
      nullifier: p.nullifier as Hex,
      changeCommitment: p.changeCommitment as Hex,
      assetIn: getAddress(p.assetIn as string),
      amountIn,
      relayerFee,
      assetOut: getAddress(p.assetOut as string),
      minOut,
      outPartial: p.outPartial as Hex,
      deadline,
    },
    maxSlippageBps: slip,
    encryptedChange: b.encryptedChange as Hex,
    encryptedOut: b.encryptedOut as Hex,
  };
}

export function parseSettle(body: unknown): SettleArgs | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.proof !== "string" || !isHex(b.proof) || size(b.proof) === 0 || size(b.proof) > MAX_PROOF_BYTES) return "proof must be hex bytes";
  for (const k of ["root", "nullifier", "outCommitment"]) if (!isWord(b[k])) return `${k} must be a 32-byte hex word`;
  if (BigInt(b.outCommitment as Hex) === 0n) return "outCommitment must not be zero";
  if (typeof b.encryptedOut !== "string" || !isHex(b.encryptedOut) || size(b.encryptedOut) === 0 || size(b.encryptedOut) > MAX_NOTE_BYTES) return "encryptedOut must be hex, 1..512 bytes";
  return { proof: b.proof as Hex, root: b.root as Hex, nullifier: b.nullifier as Hex, outCommitment: b.outCommitment as Hex, encryptedOut: b.encryptedOut as Hex };
}

export function relayerApp(d: RelayerDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const rawIp = d.ipOf ?? ((c: Context) => c.req.header("x-real-ip") ?? "unknown");
  const ipOf = (c: Context) => ipKey(rawIp(c));
  const ipLimiter = d.ipLimiter ?? new RateLimiter(20, 60_000);
  const stealthLimiter = d.stealthLimiter ?? new RateLimiter(3, 60_000);
  const plynth = new Set([...d.plynth].map((a) => a.toLowerCase()));
  plynth.add(d.stealthClaims.toLowerCase());
  const inFlight = new Set<string>();
  const log = d.log ?? (() => {});

  const app = new Hono();
  if (d.corsOrigins) {
    // Same rule as the API: unknown browser origins get 403; requests without an Origin header pass.
    const allowed = new Set(d.corsOrigins);
    app.use("*", async (c, next) => {
      const origin = c.req.header("origin");
      if (origin && !allowed.has(origin)) return c.json({ error: "origin not allowed" }, 403);
      await next();
    });
    app.use("*", cors({ origin: (o) => (allowed.has(o) ? o : null), allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type"], maxAge: 600 }));
  }
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
    if (d.claimMin) {
      const min = d.claimMin(a.token);
      if (min === undefined) return c.json({ error: "this token is not relayed: claim it from your own wallet" }, 400);
      if (a.raw < min) return c.json({ error: `claim below the relayer minimum (${min}): claim it from your own wallet` }, 400);
    }
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
  const withdrawing = new Set<string>();
  app.post("/withdraw", async (c) => {
    const w = d.withdraw;
    if (!w) return c.json({ error: "Hidden Vault withdraws are not configured" }, 503);
    if (!ipLimiter.take(ipOf(c))) return c.json({ error: "rate limited (ip)" }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const a = parseWithdraw(body);
    if (typeof a === "string") return c.json({ error: a }, 400);
    if (plynth.has(a.pub.recipient.toLowerCase()) || a.pub.recipient.toLowerCase() === w.pool.toLowerCase()) {
      return c.json({ error: "recipient is a Plynth contract" }, 400);
    }
    const min = w.minFee(a.pub.asset);
    if (min === undefined) return c.json({ error: "this asset is not relayed: withdraw it from your own wallet" }, 400);
    if (a.pub.relayerFee < (min > 0n ? min : 1n)) return c.json({ error: `relayerFee below the minimum (${min > 0n ? min : 1n})` }, 400);
    const key = a.pub.nullifier.toLowerCase();
    if (withdrawing.has(key)) return c.json({ error: "a withdraw for this note is already being sent" }, 409);
    withdrawing.add(key);
    try {
      if (await w.nullifierSpent(a.pub.nullifier)) return c.json({ error: "note already spent" }, 409);
      if (!(await w.isKnownRoot(a.pub.root))) return c.json({ error: "unknown or expired root: sync and prove again" }, 400);
      const sim = await w.simulate(a);
      if (!sim.ok) return c.json({ error: `simulation reverted: ${sim.error}` }, 400);
      const txHash = await w.send(a);
      log(`withdraw sent ${txHash}`);
      return c.json({ txHash });
    } catch (err) {
      log(`withdraw failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
      return c.json({ error: "could not send" }, 502);
    } finally {
      withdrawing.delete(key);
    }
  });
  // One in flight per nullifier, shared by withdraw, swap and settle (they all spend a note).
  const spending = withdrawing;
  async function relayTrade(c: Context, kind: "swap" | "settle"): Promise<Response> {
    const t = d.trade;
    if (!t) return c.json({ error: "private trades are not configured" }, 503);
    if (!ipLimiter.take(ipOf(c))) return c.json({ error: "rate limited (ip)" }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const a = kind === "swap" ? parseSwap(body) : parseSettle(body);
    if (typeof a === "string") return c.json({ error: a }, 400);
    const nullifier = "pub" in a ? a.pub.nullifier : a.nullifier;
    const root = "pub" in a ? a.pub.root : a.root;
    if ("pub" in a) {
      if (a.pub.deadline <= BigInt(Math.floor(now()))) return c.json({ error: "expired" }, 400);
      const min = t.minFee(a.pub.assetIn);
      if (min === undefined) return c.json({ error: "this asset is not relayed" }, 400);
      if (a.pub.relayerFee < (min > 0n ? min : 1n)) return c.json({ error: `relayerFee below the minimum (${min > 0n ? min : 1n})` }, 400);
    }
    const key = nullifier.toLowerCase();
    if (spending.has(key)) return c.json({ error: "a transaction for this note is already being sent" }, 409);
    spending.add(key);
    try {
      if (await t.nullifierSpent(nullifier)) return c.json({ error: "note already spent" }, 409);
      if (!(await t.isKnownRoot(root))) return c.json({ error: "unknown or expired root: sync and prove again" }, 400);
      const sim = "pub" in a ? await t.simulateSwap(a) : await t.simulateSettle(a);
      if (!sim.ok) return c.json({ error: `simulation reverted: ${sim.error}` }, 400);
      const txHash = "pub" in a ? await t.sendSwap(a) : await t.sendSettle(a);
      log(`${kind} sent ${txHash}`);
      return c.json({ txHash });
    } catch (err) {
      log(`${kind} failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
      return c.json({ error: "could not send" }, 502);
    } finally {
      spending.delete(key);
    }
  }
  app.post("/swap", (c) => relayTrade(c, "swap"));
  app.post("/settle", (c) => relayTrade(c, "settle"));
  return app;
}
