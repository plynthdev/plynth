// Pure planning for the rule-only desks. No I/O: the runner reads chain state, these functions decide.
// Money is bigint everywhere: USD values are 1e18-scaled (as the PolicyGuard), USDG is 6 decimals.

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const USDG_TO_WAD = 10n ** 12n; // 6dp USDG -> 1e18 USD (USDG = 1 USD, as the guard values it)

export type Band = { minBps: number; maxBps: number };

export type PolicyView = {
  cash: Band;
  equity: Band;
  perOrderCapUsd: bigint; // whole USD
  perDayCapUsd: bigint; // whole USD
  approvalAboveUsd: bigint; // whole USD
  perNameFloatCapBps: number;
};

/** Largest single order a desk may send without a board ticket: min(perOrderCap, approvalAbove), in 1e18 USD.
 *  Kept 1% under the cap because the guard's notional includes the fee-side move as well. */
export function maxOrderUsd(p: PolicyView): bigint {
  const cap = p.perOrderCapUsd < p.approvalAboveUsd ? p.perOrderCapUsd : p.approvalAboveUsd;
  return (cap * WAD * 99n) / 100n;
}

/** Splits `total` into chunks of at most `max` (largest first, last one the remainder). */
export function chunk(total: bigint, max: bigint): bigint[] {
  if (total <= 0n) return [];
  if (max <= 0n) throw new Error("chunk: max must be > 0");
  const out: bigint[] = [];
  let left = total;
  while (left > 0n) {
    const c = left > max ? max : left;
    out.push(c);
    left -= c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- cash desk

export type CashInput = {
  navUsd: bigint; // 1e18
  idleUsdg: bigint; // 6dp, USDG held directly by the account
  vaultAssetsUsdg: bigint; // 6dp, convertToAssets(shares held)
  reserveBps: number; // idle USDG kept for fees, default 200 (2% of NAV)
  sweepMinBps: number; // only sweep when idle exceeds the reserve by at least this, default 50
  extraNeedUsdg?: bigint | undefined; // 6dp, USDG the equity desk is about to spend on buys (net of sells)
  maxOrderUsd: bigint; // 1e18
};

export type CashOp = { action: "deposit" | "redeem"; usdg: bigint };

/** Keeps idle USDG at reserve (+ what the equity desk needs); sweeps the excess into the vault. */
export function planCash(i: CashInput): CashOp[] {
  if (i.navUsd <= 0n) return [];
  const reserve = (i.navUsd * BigInt(i.reserveBps)) / BPS / USDG_TO_WAD; // 6dp
  const need = i.extraNeedUsdg && i.extraNeedUsdg > 0n ? i.extraNeedUsdg : 0n;
  const required = reserve + need;
  const maxOrder = i.maxOrderUsd / USDG_TO_WAD;
  if (i.idleUsdg < required) {
    let short = required - i.idleUsdg;
    if (short > i.vaultAssetsUsdg) short = i.vaultAssetsUsdg;
    return chunk(short, maxOrder).map((usdg) => ({ action: "redeem" as const, usdg }));
  }
  const excess = i.idleUsdg - required;
  const minSweep = (i.navUsd * BigInt(i.sweepMinBps)) / BPS / USDG_TO_WAD;
  if (excess > 0n && excess >= minSweep) {
    return chunk(excess, maxOrder).map((usdg) => ({ action: "deposit" as const, usdg }));
  }
  return [];
}

// ---------------------------------------------------------------------------------------------- equity desk

export type EquityToken = {
  token: `0x${string}`;
  raw: bigint; // held, base units
  usd: bigint; // 1e18 value of `raw`
  priceUsd: bigint; // 1e18 per whole token (multiplier applied once)
  decimals: number;
  floatCapRaw: bigint; // most raw units the account may hold (perNameFloatCapBps x totalSupply)
};

export type EquityConfig = {
  /** Total equity weight to aim for (bps of NAV). Default: the middle of the policy's equity band. */
  targetBps?: number | undefined;
  /** Relative weights per token (board-supplied); default equal. Tokens missing from the map get 0. */
  weights?: Record<string, number> | undefined;
  /** Do not trade a name whose weight is within this many bps of its target. Default 100. */
  driftBps?: number | undefined;
  /** Slippage passed to the sleeve (bounded on-chain by the guard's maxOpLossBps). Default 100. */
  slippageBps?: number | undefined;
};

export type EquityOrder = {
  action: "buy" | "sell";
  token: `0x${string}`;
  amount: bigint; // buy: USDG 6dp in; sell: token raw in
  usd: bigint; // 1e18 notional estimate
};

export type EquityPlan = {
  targetBps: number;
  targets: Record<string, bigint>; // token -> target USD 1e18
  orders: EquityOrder[]; // sells first, then buys
  deferred: EquityOrder[]; // dropped because the 24h cap would be exceeded
  buyUsdg: bigint; // 6dp, USDG the buys need
  sellUsdg: bigint; // 6dp, USDG the sells are expected to return (after slippage)
};

export function equityTargetBps(band: Band, cfg: EquityConfig): number {
  const mid = Math.floor((band.minBps + band.maxBps) / 2);
  const t = cfg.targetBps ?? mid;
  return Math.min(Math.max(t, band.minBps), band.maxBps);
}

function weightsOf(tokens: EquityToken[], cfg: EquityConfig): bigint[] {
  if (!cfg.weights) return tokens.map(() => 1n);
  const lower = Object.fromEntries(Object.entries(cfg.weights).map(([k, v]) => [k.toLowerCase(), v]));
  return tokens.map((t) => {
    const w = lower[t.token.toLowerCase()] ?? 0;
    if (!(w >= 0) || !Number.isFinite(w)) throw new Error(`bad weight for ${t.token}: ${w}`);
    return BigInt(Math.round(w * 1e6));
  });
}

/** Target weights inside the equity band, clamped to each name's float cap; orders to get there. */
export function planEquity(
  navUsd: bigint,
  tokens: EquityToken[],
  policy: PolicyView,
  dayUsedUsd: bigint,
  cfg: EquityConfig = {},
): EquityPlan {
  const targetBps = equityTargetBps(policy.equity, cfg);
  const plan: EquityPlan = { targetBps, targets: {}, orders: [], deferred: [], buyUsdg: 0n, sellUsdg: 0n };
  if (navUsd <= 0n || tokens.length === 0) return plan;
  const w = weightsOf(tokens, cfg);
  const wSum = w.reduce((a, b) => a + b, 0n);
  if (wSum === 0n) return plan;

  const equityUsd = (navUsd * BigInt(targetBps)) / BPS;
  const drift = (navUsd * BigInt(cfg.driftBps ?? 100)) / BPS;
  const slip = BigInt(cfg.slippageBps ?? 100);
  const maxOrder = maxOrderUsd(policy);
  const sells: EquityOrder[] = [];
  const buys: EquityOrder[] = [];

  tokens.forEach((t, i) => {
    const unit = 10n ** BigInt(t.decimals);
    let target = (equityUsd * w[i]!) / wSum;
    // Float cap with a 0.1% margin so the post-trade balance (fee, rounding) stays under it.
    const capUsd = (((t.floatCapRaw * 999n) / 1000n) * t.priceUsd) / unit;
    if (target > capUsd) target = capUsd;
    plan.targets[t.token] = target;
    const delta = target - t.usd;
    const abs = delta < 0n ? -delta : delta;
    if (abs === 0n || abs < drift) return;
    if (delta < 0n) {
      const sellAll = target === 0n;
      for (const usd of chunk(abs, maxOrder)) {
        let raw = (usd * unit) / t.priceUsd;
        if (raw > t.raw) raw = t.raw;
        if (raw > 0n) sells.push({ action: "sell", token: t.token, amount: raw, usd });
      }
      if (sellAll) {
        // Exit the whole position: put any rounding dust into the last chunk.
        const sold = sells.filter((s) => s.token === t.token).reduce((a, s) => a + s.amount, 0n);
        const last = sells.filter((s) => s.token === t.token).at(-1);
        if (last && sold < t.raw) last.amount += t.raw - sold;
      }
    } else {
      for (const usd of chunk(delta, maxOrder)) {
        const usdg = usd / USDG_TO_WAD;
        if (usdg > 0n) buys.push({ action: "buy", token: t.token, amount: usdg, usd });
      }
    }
  });

  // 24h cap: keep orders in sequence (sells first) until the day's notional would exceed the cap.
  const dayCap = policy.perDayCapUsd * WAD;
  let used = dayUsedUsd;
  for (const o of [...sells, ...buys]) {
    if (used + o.usd > dayCap) {
      plan.deferred.push(o);
      continue;
    }
    used += o.usd;
    plan.orders.push(o);
  }
  for (const o of plan.orders) {
    if (o.action === "buy") plan.buyUsdg += o.amount;
    else plan.sellUsdg += (o.usd * (BPS - slip)) / BPS / USDG_TO_WAD;
  }
  return plan;
}

/** Weight of `part` in `nav`, in bps (floor). */
export function weightBps(part: bigint, nav: bigint): number {
  return nav === 0n ? 0 : Number((part * BPS) / nav);
}
