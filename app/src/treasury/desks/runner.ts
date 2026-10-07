// One pass of the rule-only desks over one treasury:
//   1. equity desk: commit tomorrow's JitterBeacon window, reveal today's; if today's execution time has
//      passed and today's rebalance is not done and no feed is on hold: sells, (cash desk redeems what the
//      buys need), buys; then mark the day done.
//   2. cash desk: keep idle USDG >= reserveBps of NAV, sweep the rest into the vault, redeem when short.
// Every operation is first simulated with eth_call from the desk key; a revert is logged to desk_actions
// with its reason code and nothing is sent.
import { withEstimatedGas } from "@/lib/gas";
import {
  encodeAbiParameters,
  getAddress,
  stringToHex,
  zeroHash,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { accountAbi, beaconAbi, equitySleeveAbi, erc20Abi, guardAbi, policyAbi, valuerAbi, vaultAbi } from "@/abi/treasury-desks";
import { beaconKey, beaconSteps, commitmentOf, offsetOf, secretFor, windowStart } from "./beacon";
import type { DeskConfig } from "./runner-config";
import { decodeRejection, type Rejection } from "./errors";
import type { ActionLog, ActionRow } from "./log";
import { maxOrderUsd, planCash, planEquity, USDG_TO_WAD, type EquityToken, type PolicyView } from "./plan";

export type Desk = { account: PrivateKeyAccount; wallet: WalletClient };

export type DeskContext = {
  chain: Chain;
  pub: PublicClient;
  cfg: DeskConfig;
  cash: Desk;
  equity: Desk;
  log: ActionLog;
  say?: (m: string) => void;
  /** Called when a simulation is rejected; the jury (todo 26) files rule-9 rejections with the board. Errors
   *  are logged and never stop the pass. */
  onException?: (ctx: DeskContext, op: Op, rejection: Rejection) => Promise<void>;
};

export type State = {
  ts: bigint;
  nav: bigint;
  equityHold: boolean;
  usdg: Address;
  idleUsdg: bigint;
  vaultShares: bigint;
  vaultAssetsUsdg: bigint;
  policy: PolicyView & { allowRoot: Hex; noNewRiskOffHours: boolean };
  dayUsed: bigint;
  tokens: (EquityToken & { hold: boolean })[];
  guard: Address;
};

const PULLS = { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] } as const;

export function wrapData(pullToken: Address, pullAmount: bigint, runData: Hex): Hex {
  return encodeAbiParameters([PULLS, { type: "bytes" }], [[{ token: pullToken, amount: pullAmount }], runData]);
}

export function equityRunData(op: "buy" | "sell", token: Address, amount: bigint, slippageBps: number): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint16" }], [op === "buy" ? 0 : 1, token, amount, slippageBps]);
}

export function cashRunData(op: "deposit" | "redeem", vault: Address, amount: bigint, minOut: bigint): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [op === "deposit" ? 0 : 1, vault, amount, minOut]);
}

/** allowProof layout PolicyGuard.check expects: [len0, proof0..., len1, proof1..., ...]. */
export function packProofs(proofs: Hex[][]): Hex[] {
  const out: Hex[] = [];
  for (const p of proofs) {
    out.push(`0x${BigInt(p.length).toString(16).padStart(64, "0")}` as Hex);
    out.push(...p);
  }
  return out;
}

export const deskIdBytes = (id: string): Hex => stringToHex(id, { size: 32 });

// -------------------------------------------------------------------------------------------- reads

export async function readState(ctx: DeskContext): Promise<State> {
  const { pub, cfg } = ctx;
  const block = await pub.getBlock({ blockTag: "latest" });
  const guard = (await pub.readContract({ address: cfg.account, abi: accountAbi, functionName: "guard" })) as Address;
  const policyAddr = (await pub.readContract({ address: cfg.account, abi: accountAbi, functionName: "policy" })) as Address;
  const [snap, tracked, cur, dayUsed] = await Promise.all([
    pub.readContract({ address: guard, abi: guardAbi, functionName: "snapshot", args: [cfg.account] }),
    pub.readContract({ address: cfg.account, abi: accountAbi, functionName: "trackedAssets" }),
    pub.readContract({ address: policyAddr, abi: policyAbi, functionName: "current" }),
    pub.readContract({ address: guard, abi: guardAbi, functionName: "dayTotal", args: [cfg.account] }),
  ]);
  const [assets, kinds] = tracked as readonly [readonly Address[], readonly number[], readonly number[]];
  const p = cur[0];
  const policy = {
    cash: p.cash,
    equity: p.equity,
    perOrderCapUsd: p.perOrderCapUsd,
    perDayCapUsd: p.perDayCapUsd,
    approvalAboveUsd: p.approvalAboveUsd,
    perNameFloatCapBps: p.perNameFloatCapBps,
    noNewRiskOffHours: p.noNewRiskOffHours,
    allowRoot: p.instrumentAllowRoot,
  };
  const idx = (a: Address) => snap.assets.findIndex((x) => x.toLowerCase() === a.toLowerCase());
  const usdgIdx = kinds.findIndex((k) => k === 0);
  if (usdgIdx < 0) throw new Error("treasury tracks no cash (USDG) asset");
  const usdg = getAddress(assets[usdgIdx]!);
  const vi = idx(cfg.vault);
  const vaultShares = vi >= 0 ? snap.raw[vi]! : 0n;
  const vaultAssetsUsdg = vi >= 0 ? snap.usd[vi]! / USDG_TO_WAD : 0n;

  const [eqTokens] = (await pub.readContract({ address: cfg.equitySleeve, abi: equitySleeveAbi, functionName: "assets" })) as readonly [readonly Address[], readonly number[]];
  const valuer = (await pub.readContract({ address: cfg.equitySleeve, abi: equitySleeveAbi, functionName: "valuer" })) as Address;
  const tokens = await Promise.all(
    eqTokens.map(async (token) => {
      const i = idx(token);
      const [decimals, floatCapRaw] = await Promise.all([
        pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
        pub.readContract({ address: cfg.equitySleeve, abi: equitySleeveAbi, functionName: "floatCapRaw", args: [token, policy.perNameFloatCapBps] }),
      ]);
      let priceUsd = 0n;
      let hold = true; // a token the Valuer cannot quote (delisted) is never bought
      try {
        const q = await pub.readContract({ address: valuer, abi: valuerAbi, functionName: "quote", args: [token] });
        priceUsd = q.priceUsdPerToken;
        hold = q.hold;
      } catch {}
      return { token: getAddress(token), raw: i >= 0 ? snap.raw[i]! : 0n, usd: i >= 0 ? snap.usd[i]! : 0n, priceUsd, decimals: Number(decimals), floatCapRaw, hold };
    }),
  );
  return {
    ts: block.timestamp,
    nav: snap.nav,
    equityHold: snap.equityHold,
    usdg,
    idleUsdg: snap.raw[usdgIdx]!,
    vaultShares,
    vaultAssetsUsdg,
    policy,
    dayUsed,
    tokens,
    guard,
  };
}

// -------------------------------------------------------------------------------------------- execution

export type Op = {
  desk: "cash" | "equity";
  action: "deposit" | "redeem" | "buy" | "sell";
  adapter: Address;
  data: Hex;
  increased: Address; // the asset whose balance goes up (needs an allow proof)
  asset: Address;
  amount: bigint;
  usd: bigint;
  beaconKey?: Hex;
};

export type Outcome = { ok: true; txHash: Hex } | { ok: false; rejection: Rejection; sent: boolean; txHash?: Hex };

function deskOf(ctx: DeskContext, d: "cash" | "equity") {
  return d === "cash" ? { desk: ctx.cash, id: ctx.cfg.cashDeskId } : { desk: ctx.equity, id: ctx.cfg.equityDeskId };
}

export function executeArgs(ctx: DeskContext, op: Op) {
  const proof = ctx.cfg.proofs[getAddress(op.increased)];
  if (!proof) throw new Error(`no allow proof for ${op.increased} in the policy template`);
  return [deskIdBytes(deskOf(ctx, op.desk).id), op.adapter, op.data, packProofs([proof]), zeroHash] as const;
}

/** eth_call `execute` from the desk key; returns the decoded rejection if the guard (or anything) reverts. */
export async function simulate(ctx: DeskContext, op: Op): Promise<{ ok: true; request: unknown } | { ok: false; rejection: Rejection }> {
  const { desk } = deskOf(ctx, op.desk);
  try {
    const { request } = await ctx.pub.simulateContract({
      address: ctx.cfg.account,
      abi: accountAbi,
      functionName: "execute",
      args: executeArgs(ctx, op),
      account: desk.account,
      chain: ctx.chain,
    });
    return { ok: true, request };
  } catch (e) {
    return { ok: false, rejection: decodeRejection(e) };
  }
}

/** Simulate, then send only if the simulation passed. Logs the outcome either way. */
export async function attempt(ctx: DeskContext, op: Op): Promise<Outcome> {
  const row: Omit<ActionRow, "status"> = {
    chainId: ctx.chain.id,
    account: ctx.cfg.account,
    desk: op.desk,
    action: op.action,
    adapter: op.adapter,
    asset: op.asset,
    amount: op.amount,
    notionalUsd: op.usd,
    beaconKey: op.beaconKey ?? null,
  };
  const sim = await simulate(ctx, op);
  if (!sim.ok) {
    await ctx.log.record({ ...row, status: "rejected", reasonCode: sim.rejection.code, reason: sim.rejection.reason });
    ctx.say?.(`${op.desk} ${op.action} ${op.asset} ${op.amount}: rejected by simulation (${sim.rejection.reason})`);
    if (ctx.onException) {
      try {
        await ctx.onException(ctx, op, sim.rejection);
      } catch (e) {
        ctx.say?.(`exception filing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ok: false, rejection: sim.rejection, sent: false };
  }
  const { desk } = deskOf(ctx, op.desk);
  // Explicit gas: a bare estimate can miss accrual a sleeve's venue does once a second has passed; withEstimatedGas
  // estimates a second ahead too and adds headroom (lib/gas.ts).
  const request = await withEstimatedGas(ctx.pub, sim.request as Record<string, unknown>);
  const hash = await desk.wallet.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
  const rcpt = await ctx.pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") {
    await ctx.log.record({ ...row, status: "reverted", reason: "reverted on-chain after a passing simulation", txHash: hash, blockNumber: rcpt.blockNumber });
    return { ok: false, rejection: { code: null, reason: "reverted" }, sent: true, txHash: hash };
  }
  await ctx.log.record({ ...row, status: "sent", txHash: hash, blockNumber: rcpt.blockNumber });
  ctx.say?.(`${op.desk} ${op.action} ${op.asset} ${op.amount}: sent ${hash}`);
  return { ok: true, txHash: hash };
}

// -------------------------------------------------------------------------------------------- cash desk

async function cashOps(ctx: DeskContext, s: State, opts: { extraNeedUsdg?: bigint; redeemOnly?: boolean }): Promise<Op[]> {
  const planned = planCash({
    navUsd: s.nav,
    idleUsdg: s.idleUsdg,
    vaultAssetsUsdg: s.vaultAssetsUsdg,
    reserveBps: ctx.cfg.cash.reserveBps,
    sweepMinBps: ctx.cfg.cash.sweepMinBps,
    extraNeedUsdg: opts.extraNeedUsdg,
    maxOrderUsd: maxOrderUsd(s.policy),
  });
  const ops: Op[] = [];
  const v = ctx.cfg.vault;
  let sharesLeft = s.vaultShares;
  for (const p of planned) {
    if (p.action === "deposit") {
      if (opts.redeemOnly) continue;
      const shares = await ctx.pub.readContract({ address: v, abi: vaultAbi, functionName: "previewDeposit", args: [p.usdg] });
      ops.push({ desk: "cash", action: "deposit", adapter: ctx.cfg.cashSleeve, data: wrapData(s.usdg, p.usdg, cashRunData("deposit", v, p.usdg, (shares * 9_999n) / 10_000n)), increased: v, asset: v, amount: p.usdg, usd: p.usdg * USDG_TO_WAD });
    } else {
      let shares = await ctx.pub.readContract({ address: v, abi: vaultAbi, functionName: "previewWithdraw", args: [p.usdg] });
      if (shares > sharesLeft) shares = sharesLeft;
      if (shares === 0n) continue;
      sharesLeft -= shares;
      const assets = await ctx.pub.readContract({ address: v, abi: vaultAbi, functionName: "previewRedeem", args: [shares] });
      ops.push({ desk: "cash", action: "redeem", adapter: ctx.cfg.cashSleeve, data: wrapData(v, shares, cashRunData("redeem", v, shares, (assets * 9_999n) / 10_000n)), increased: s.usdg, asset: v, amount: shares, usd: assets * USDG_TO_WAD });
    }
  }
  return ops;
}

export async function runCashDesk(ctx: DeskContext): Promise<Outcome[]> {
  const s = await readState(ctx);
  const out: Outcome[] = [];
  for (const op of await cashOps(ctx, s, {})) out.push(await attempt(ctx, op));
  return out;
}

// -------------------------------------------------------------------------------------------- equity desk

export type EquityResult = { beacon: string[]; rebalanced: boolean; skipped?: string; outcomes: Outcome[] };

export async function runEquityDesk(ctx: DeskContext): Promise<EquityResult> {
  const { pub, cfg } = ctx;
  const res: EquityResult = { beacon: [], rebalanced: false, outcomes: [] };
  let s = await readState(ctx);
  if (s.policy.allowRoot.toLowerCase() !== cfg.allowRoot.toLowerCase()) {
    throw new Error(`policy template is stale: on-chain allow root ${s.policy.allowRoot} != template ${cfg.allowRoot}`);
  }

  // ---- beacon: one commit/reveal per window (beaconWindowSeconds)
  const grace = await pub.readContract({ address: cfg.beacon, abi: beaconAbi, functionName: "GRACE" });
  const window = BigInt(cfg.beaconWindowSeconds);
  if (window <= grace) throw new Error(`desk config: beaconWindowSeconds ${window} must exceed the beacon GRACE ${grace}`);
  const today = windowStart(s.ts, window);
  const kToday = beaconKey(cfg.account, today);
  const kTomorrow = beaconKey(cfg.account, today + window);
  const [bToday, bTomorrow, keeper] = await Promise.all([
    pub.readContract({ address: cfg.beacon, abi: beaconAbi, functionName: "beacon", args: [kToday] }),
    pub.readContract({ address: cfg.beacon, abi: beaconAbi, functionName: "beacon", args: [kTomorrow] }),
    pub.readContract({ address: cfg.beacon, abi: beaconAbi, functionName: "keeper" }),
  ]);
  const sign = (key: Hex) => ctx.equity.account.signMessage({ message: { raw: key } });
  const revealAt = bToday.windowEnd > bToday.windowStart
    ? bToday.windowStart + offsetOf(await secretFor(sign, kToday), kToday, bToday.windowStart, bToday.windowEnd, grace)
    : undefined;
  for (const step of beaconSteps(s.ts, grace, { key: kToday, b: bToday, ...(revealAt === undefined ? {} : { revealAt }) }, { key: kTomorrow, b: bTomorrow }, window)) {
    const secret = await secretFor(sign, step.key);
    if (step.kind === "commit" && keeper.toLowerCase() !== ctx.equity.account.address.toLowerCase()) {
      await ctx.log.record({ chainId: ctx.chain.id, account: cfg.account, desk: "equity", action: "beacon_commit", status: "skipped", reason: "NOT_BEACON_KEEPER", beaconKey: step.key });
      continue;
    }
    const args =
      step.kind === "commit"
        ? ({ functionName: "commit", args: [step.key, step.windowStart, step.windowEnd, commitmentOf(secret, step.key)] } as const)
        : ({ functionName: "reveal", args: [step.key, secret] } as const);
    try {
      const { request } = await pub.simulateContract({ address: cfg.beacon, abi: beaconAbi, ...args, account: ctx.equity.account, chain: ctx.chain } as Parameters<PublicClient["simulateContract"]>[0]);
      const hash = await ctx.equity.wallet.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
      const r = await pub.waitForTransactionReceipt({ hash });
      await ctx.log.record({ chainId: ctx.chain.id, account: cfg.account, desk: "equity", action: `beacon_${step.kind}`, status: r.status === "success" ? "sent" : "reverted", beaconKey: step.key, txHash: hash, blockNumber: r.blockNumber });
      res.beacon.push(step.kind);
    } catch (e) {
      const rej = decodeRejection(e);
      await ctx.log.record({ chainId: ctx.chain.id, account: cfg.account, desk: "equity", action: `beacon_${step.kind}`, status: "rejected", reason: rej.reason, beaconKey: step.key });
    }
  }

  // ---- rebalance at the beacon time, once per window
  s = await readState(ctx);
  const executeAfter = await pub.readContract({ address: cfg.beacon, abi: beaconAbi, functionName: "executeAfter", args: [kToday] });
  if (s.ts < executeAfter) return res;
  if (await ctx.log.rebalanceDone(cfg.account, kToday)) return res;
  const held = s.tokens.filter((t) => t.hold).map((t) => t.token);
  if (held.length > 0) {
    res.skipped = "FEED_HOLD";
    await ctx.log.record({ chainId: ctx.chain.id, account: cfg.account, desk: "equity", action: "rebalance", status: "skipped", reason: "FEED_HOLD", beaconKey: kToday, detail: { held } });
    return res;
  }

  const plan = planEquity(s.nav, s.tokens, s.policy, s.dayUsed, cfg.equity);
  const slip = cfg.equity.slippageBps ?? 100;
  const opFor = (o: (typeof plan.orders)[number]): Op =>
    o.action === "buy"
      ? { desk: "equity", action: "buy", adapter: cfg.equitySleeve, data: wrapData(s.usdg, o.amount, equityRunData("buy", o.token, o.amount, slip)), increased: o.token, asset: o.token, amount: o.amount, usd: o.usd, beaconKey: kToday }
      : { desk: "equity", action: "sell", adapter: cfg.equitySleeve, data: wrapData(o.token, o.amount, equityRunData("sell", o.token, o.amount, slip)), increased: s.usdg, asset: o.token, amount: o.amount, usd: o.usd, beaconKey: kToday };

  for (const o of plan.orders.filter((o) => o.action === "sell")) res.outcomes.push(await attempt(ctx, opFor(o)));

  let buys = plan.orders.filter((o) => o.action === "buy");
  if (buys.length > 0) {
    // Cash desk: redeem from the vault what the buys need on top of the fee reserve.
    s = await readState(ctx);
    const need = buys.reduce((a, o) => a + o.amount, 0n);
    for (const op of await cashOps(ctx, s, { extraNeedUsdg: need, redeemOnly: true })) res.outcomes.push(await attempt(ctx, op));
    // Never spend the reserve: trim buys to what is actually idle above it.
    s = await readState(ctx);
    const reserve = (s.nav * BigInt(cfg.cash.reserveBps)) / 10_000n / USDG_TO_WAD;
    let avail = s.idleUsdg > reserve ? s.idleUsdg - reserve : 0n;
    buys = buys.flatMap((o) => {
      const amt = o.amount <= avail ? o.amount : avail;
      avail -= amt;
      return amt > 0n ? [{ ...o, amount: amt, usd: amt * USDG_TO_WAD }] : [];
    });
  }
  for (const o of buys) res.outcomes.push(await attempt(ctx, opFor(o)));

  await ctx.log.record({
    chainId: ctx.chain.id,
    account: cfg.account,
    desk: "equity",
    action: "rebalance_done",
    status: "done",
    beaconKey: kToday,
    detail: { targetBps: plan.targetBps, targets: plan.targets, orders: plan.orders.length, deferred: plan.deferred.length },
  });
  res.rebalanced = true;
  return res;
}

export async function runOnce(ctx: DeskContext) {
  const equity = await runEquityDesk(ctx);
  const cash = await runCashDesk(ctx);
  return { equity, cash };
}
