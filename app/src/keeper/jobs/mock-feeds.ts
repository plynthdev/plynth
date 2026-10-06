// Job 0: refresh-mock-feeds. Testnet only. The testnet kit prices its mock Stock Tokens with MockFeeds, and its
// Valuer holds a market (every buy reverts MarketOnHold) once a feed is older than maxStaleness (30 min). For each
// mock feed older than KEEPER_MOCK_FEED_INTERVAL_S this job reads the REAL Chainlink feed of the same stock on
// Robinhood Chain mainnet (public RPC, read only) and posts it with MockFeed.set, which stamps it with the block
// time, so testnet prices track real ones.
//
//   - Real feeds price one TOKEN (uiMultiplier embedded); the kit's mock feeds price one SHARE and the Valuer
//     applies the mock token's own multiplier. So a per-share mock gets real answer x 1e18 / real uiMultiplier.
//   - Off-hours the real feed stops updating. Older than KEEPER_MOCK_FEED_REAL_STALE_S counts as stale: with
//     KEEPER_MOCK_FEED_KEEP_ALIVE=1 its last answer is still posted (a "keep-alive", logged as one) so demos keep
//     trading; with 0 nothing is posted and the testnet market holds, like mainnet does.
//   - A mainnet read that fails falls back to a keep-alive of the mock's own last answer (KEEP_ALIVE=1 only).
//   - The kit's v4 pools were seeded at the kit's made-up prices. When the oracle price is more than
//     KEEPER_MOCK_FEED_ALIGN_BPS away from a pool (checked every pass), the keeper mints the input side (it owns the kit's mocks) and
//     swaps through the StockRouter until the pool sits at the oracle price, so buys AND sells pass the router's
//     oracle check. A swap towards the oracle always beats the oracle-derived minimum output.
//
// Runs only on mock-feed deployments: `mockFeeds: true` in the deployment file (TestnetKit writes it), or, for a
// file written before the flag existed, chain 46630 with every feed describing itself as a mock. `mockFeeds:
// false` and every other deployment: no-op. The keeper must own the feeds (MockFeed is Ownable): a feed owned by
// someone else is skipped with a note (transferOwnership to the keeper to enable it).
import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { aggregatorAbi, feeds, stockTokenAbi, stockTokens } from "@/chain";
import { chainNow, simulate, type Ctx, type JobResult, type MockStock } from "@/keeper/context";

export const mockFeedAbi = parseAbi([
  "function set(int256 answer)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function owner() view returns (address)",
]);
const mockTokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function owner() view returns (address)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const registryAbi = parseAbi([
  "struct Entry { address feed; bool multiplierEmbedded; bool active; }",
  "function entry(address token) view returns (Entry)",
]);
const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote q)",
]);
const routerAbi = parseAbi([
  "function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient) returns (uint256)",
  "function sell(address stockToken, uint256 rawIn, uint16 maxSlippageBps, address recipient) returns (uint256)",
  "error MarketOnHold(address stockToken)",
  "error Slippage(uint256 minOut, uint256 got)",
  "error PartialFill(uint256 wanted, uint256 used)",
]);
const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

/** One read of a real mainnet feed: answer (feed decimals), when it was updated, the token's uiMultiplier, mainnet time. */
export type RealFeed = { answer: bigint; decimals: number; updatedAt: bigint; multiplier: bigint; mainnetNow: bigint };
/** Reads the real feed of a mainnet Stock Token by symbol ("TSLA"). Tests pass a fake. */
export type MainnetFeedReader = { read(symbol: string): Promise<RealFeed> };

export type MockFeedOptions = {
  reader: MainnetFeedReader;
  intervalS: number;
  keepAlive: boolean;
  realStaleS: number;
  alignBps: number;
};

/** The production reader: Chainlink proxies from chain/index.ts (chain-facts.md) over a mainnet client. */
export function mainnetFeedReader(pub: Pick<PublicClient, "readContract" | "getBlock">): MainnetFeedReader {
  return {
    async read(symbol) {
      const feed = (feeds as Record<string, { feed: Address; decimals: number } | null>)[symbol];
      const token = (stockTokens as Record<string, Address>)[symbol];
      if (!feed || !token) throw new Error(`no mainnet feed for ${symbol}`);
      const [round, multiplier, block] = await Promise.all([
        pub.readContract({ address: feed.feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
        pub.readContract({ address: token, abi: stockTokenAbi, functionName: "uiMultiplier" }),
        pub.getBlock({ blockTag: "latest" }),
      ]);
      return { answer: round[1], decimals: feed.decimals, updatedAt: round[3], multiplier, mainnetNow: block.timestamp };
    },
  };
}

/** True if a mainnet feed exists for `symbol` (QCOM has none). */
export function hasRealFeed(symbol: string): boolean {
  return Boolean((feeds as Record<string, unknown>)[symbol]) && symbol in stockTokens;
}

/** Mock answer for a real one: rescaled to the mock's decimals, and divided by the real multiplier for a per-share mock. */
export function mockAnswerFor(real: Pick<RealFeed, "answer" | "decimals" | "multiplier">, mockDecimals: number, perShare: boolean): bigint {
  if (real.answer <= 0n) throw new Error("real feed answer is not positive");
  if (perShare && real.multiplier <= 0n) throw new Error("real uiMultiplier is zero");
  let num = real.answer * 10n ** BigInt(mockDecimals);
  let den = 10n ** BigInt(real.decimals);
  if (perShare) {
    num *= 10n ** 18n;
    den *= real.multiplier;
  }
  return (num + den / 2n) / den; // nearest
}

/** Decides what to post for one feed. Pure, so every branch has a unit test. */
export function refreshDecision(o: {
  mockAge: bigint;
  intervalS: number;
  keepAlive: boolean;
  realStaleS: number;
  /** Undefined when the mainnet read failed. */
  real?: RealFeed | undefined;
}): { action: "skip"; reason: "fresh" | "real_stale_no_keep_alive" | "read_failed_no_keep_alive" } | { action: "track" } | { action: "keep_alive"; source: "real" | "mock" } {
  if (o.mockAge < BigInt(o.intervalS)) return { action: "skip", reason: "fresh" };
  if (!o.real) return o.keepAlive ? { action: "keep_alive", source: "mock" } : { action: "skip", reason: "read_failed_no_keep_alive" };
  const stale = o.real.mainnetNow - o.real.updatedAt > BigInt(o.realStaleS);
  if (!stale) return { action: "track" };
  return o.keepAlive ? { action: "keep_alive", source: "real" } : { action: "skip", reason: "real_stale_no_keep_alive" };
}

const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  // Integer Newton from 2^ceil(bits/2) >= sqrt(n): strictly decreasing until it reaches floor(sqrt(n)).
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** sqrtPriceX96 of a USDG/token v4 pool at `p` USD per whole token (1e18), as TestnetPoolMath.sqrtPriceX96For. */
export function sqrtPriceX96For(p: bigint, usdgDecimals: number, tokenDecimals: number, usdgIs0: boolean): bigint {
  const tokenScale = 10n ** BigInt(tokenDecimals) * 10n ** 18n;
  const usdScale = p * 10n ** BigInt(usdgDecimals);
  if (usdScale === 0n) throw new Error("zero price");
  return isqrt(usdgIs0 ? (tokenScale * Q192) / usdScale : (usdScale * Q192) / tokenScale);
}

/** USD per whole token (1e18) at a pool's sqrtPriceX96, as TestnetPoolMath.priceUsdPerTokenAt. */
export function priceAt(sqrtP: bigint, usdgDecimals: number, tokenDecimals: number, usdgIs0: boolean): bigint {
  const priceX96 = (sqrtP * sqrtP) / Q96;
  const tokenScale = 10n ** BigInt(tokenDecimals) * 10n ** 18n;
  const usdgUnit = 10n ** BigInt(usdgDecimals);
  return usdgIs0 ? (tokenScale * Q96) / (priceX96 * usdgUnit) : (priceX96 * tokenScale) / (Q96 * usdgUnit);
}

/**
 * Exact input that moves a pool with in-range liquidity `L` from `sqrtP` to `target` (both X96), fee included
 * (`feePips`, v4 takes it from the input). zeroForOne = currency0 in (price down). Rounded up.
 */
export function swapToPrice(sqrtP: bigint, target: bigint, L: bigint, feePips: number): { zeroForOne: boolean; amountIn: bigint } {
  if (L <= 0n) throw new Error("no liquidity");
  const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const zeroForOne = target < sqrtP;
  const net = zeroForOne ? ceil(L * Q96 * (sqrtP - target), sqrtP * target) : ceil(L * (target - sqrtP), Q96);
  const amountIn = ceil(net * 1_000_000n, 1_000_000n - BigInt(feePips));
  return { zeroForOne, amountIn };
}

export function divergenceBps(poolPrice: bigint, oraclePrice: bigint): bigint {
  const d = poolPrice > oraclePrice ? poolPrice - oraclePrice : oraclePrice - poolPrice;
  return (d * 10_000n) / oraclePrice;
}

/** v4 pool state slot: keccak256(abi.encode(poolId, POOLS_SLOT = 6)) (chain-facts.md, extsload). */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
}

const MAX_SLIPPAGE_BPS = 100;

async function isMockFeedDeployment(ctx: Ctx): Promise<boolean> {
  const m = ctx.dep.mock;
  if (m.flag !== undefined) return m.flag && m.stocks.length > 0;
  // A file from before the flag: only the testnet kit's own feeds, recognised by their description.
  if (ctx.chainId !== 46630 || m.stocks.length === 0) return false;
  for (const s of m.stocks) {
    const d = await ctx.pub.readContract({ address: s.feed, abi: mockFeedAbi, functionName: "description" }).catch(() => "");
    if (!/\(mock\b/i.test(d)) return false;
  }
  return true;
}

export async function runRefreshMockFeeds(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "refresh-mock-feeds", ok: true, actions: 0, notes: [] };
  const opt = ctx.mockFeeds;
  if (!opt) return res;
  if (!(await isMockFeedDeployment(ctx))) return res;
  const now = await chainNow(ctx);
  for (const s of ctx.dep.mock.stocks) {
    const owner = await ctx.pub.readContract({ address: s.feed, abi: mockFeedAbi, functionName: "owner" });
    if (getAddress(owner) !== getAddress(ctx.account)) {
      res.notes.push(`${s.symbol}: feed owned by ${owner}, not the keeper; transferOwnership to the keeper to refresh it`);
      continue;
    }
    if (!hasRealFeed(s.underlying)) {
      res.notes.push(`${s.symbol}: no mainnet feed for ${s.underlying}; set "underlying" in the deployment file`);
      continue;
    }
    await refreshFeed(ctx, s, opt, now, res);
    // Every pass, not only after a post: a pool knocked off the oracle price by trading (or a failed earlier
    // alignment) is put back too. Silent while the market holds or the pool is within the band.
    if (opt.alignBps > 0) {
      const note = await alignPool(ctx, s, opt.alignBps);
      if (note) {
        res.notes.push(`${s.symbol}: ${note}`);
        if (note.startsWith("pool aligned")) res.actions++;
      }
    }
  }
  return res;
}

/** Posts one mock feed if it is older than the interval (see refreshDecision). */
async function refreshFeed(ctx: Ctx, s: MockStock, opt: MockFeedOptions, now: bigint, res: JobResult): Promise<void> {
  const [, lastAnswer, , updatedAt] = await ctx.pub.readContract({ address: s.feed, abi: mockFeedAbi, functionName: "latestRoundData" });
  const mockAge = now > updatedAt ? now - updatedAt : 0n;
  if (mockAge < BigInt(opt.intervalS)) return; // fresh: nothing to read or send

  let real: RealFeed | undefined;
  let readError: string | undefined;
  try {
    real = await opt.reader.read(s.underlying);
  } catch (e) {
    readError = String((e as Error)?.message ?? e).split("\n")[0];
  }
  const decision = refreshDecision({ mockAge, intervalS: opt.intervalS, keepAlive: opt.keepAlive, realStaleS: opt.realStaleS, real });
  if (decision.action === "skip") {
    res.notes.push(
      decision.reason === "real_stale_no_keep_alive"
        ? `${s.symbol}: ${s.underlying} feed stale (market closed); not re-stamped (KEEPER_MOCK_FEED_KEEP_ALIVE=0)`
        : `${s.symbol}: mainnet read failed (${readError}); not re-stamped (KEEPER_MOCK_FEED_KEEP_ALIVE=0)`,
    );
    return;
  }
  let answer = lastAnswer;
  if (decision.action === "track" || decision.source === "real") {
    const mockDecimals = await ctx.pub.readContract({ address: s.feed, abi: mockFeedAbi, functionName: "decimals" });
    answer = mockAnswerFor(real!, mockDecimals, await perShare(ctx, s));
  }
  await ctx.sender.sendCall(s.feed, mockFeedAbi, "set", [answer], `mock-feed ${s.symbol}`);
  res.actions++;
  if (decision.action === "track") res.notes.push(`${s.symbol}: ${answer} from ${s.underlying}`);
  else if (decision.source === "real") res.notes.push(`${s.symbol}: keep-alive, ${s.underlying} feed stale since ${real!.updatedAt}; re-stamped ${answer}`);
  else res.notes.push(`${s.symbol}: keep-alive, mainnet read failed (${readError}); re-stamped the mock's own ${answer}`);
  ctx.log(`refresh-mock-feeds ${res.notes[res.notes.length - 1]}`);
}

/** The registry says whether the feed prices one token (multiplier embedded) or one share. Kit default: share. */
async function perShare(ctx: Ctx, s: MockStock): Promise<boolean> {
  const reg = ctx.dep.mock.registry;
  if (!reg) return true;
  const e = await ctx.pub.readContract({ address: reg, abi: registryAbi, functionName: "entry", args: [s.token] });
  return !e.multiplierEmbedded;
}

/** Swaps the kit's v4 pool to the oracle price when it is more than `alignBps` away. Returns a note, or undefined. */
export async function alignPool(ctx: Ctx, s: MockStock, alignBps: number): Promise<string | undefined> {
  const m = ctx.dep.mock;
  if (!m.valuer || !m.router || !m.poolManager || !m.usdg || !s.poolId || s.fee === undefined || !s.currency0 || !s.currency1) return undefined;
  const q = await ctx.pub.readContract({ address: m.valuer, abi: valuerAbi, functionName: "quote", args: [s.token] });
  if (q.hold) return undefined; // nothing to align to; the router refuses trades anyway
  const usdgIs0 = getAddress(s.currency0) === getAddress(m.usdg);
  const [usdgDec, tokenDec] = await Promise.all([
    ctx.pub.readContract({ address: m.usdg, abi: mockTokenAbi, functionName: "decimals" }),
    ctx.pub.readContract({ address: s.token, abi: mockTokenAbi, functionName: "decimals" }),
  ]);
  const slot = poolStateSlot(s.poolId);
  const [slot0, liq] = await Promise.all([
    ctx.pub.readContract({ address: m.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] }),
    ctx.pub.readContract({ address: m.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [`0x${(BigInt(slot) + 3n).toString(16).padStart(64, "0")}` as Hex] }),
  ]);
  const sqrtP = BigInt(slot0) & ((1n << 160n) - 1n);
  const L = BigInt(liq) & ((1n << 128n) - 1n);
  if (sqrtP === 0n || L === 0n) return "pool not aligned: pool not initialized or empty";
  const before = divergenceBps(priceAt(sqrtP, usdgDec, tokenDec, usdgIs0), q.priceUsdPerToken);
  if (before <= BigInt(alignBps)) return undefined;

  const target = sqrtPriceX96For(q.priceUsdPerToken, usdgDec, tokenDec, usdgIs0);
  const { zeroForOne, amountIn } = swapToPrice(sqrtP, target, L, s.fee);
  const tokenIn = zeroForOne ? s.currency0 : s.currency1;
  const isBuy = getAddress(tokenIn) === getAddress(m.usdg);
  const bal = await ctx.pub.readContract({ address: tokenIn, abi: mockTokenAbi, functionName: "balanceOf", args: [ctx.account] });
  if (bal < amountIn) {
    const owner = await ctx.pub.readContract({ address: tokenIn, abi: mockTokenAbi, functionName: "owner" }).catch(() => undefined);
    if (!owner || getAddress(owner) !== getAddress(ctx.account)) return `pool not aligned (${before} bps off): keeper holds too little ${isBuy ? "USDG" : s.symbol} and cannot mint it`;
    await ctx.sender.sendCall(tokenIn, mockTokenAbi, "mint", [ctx.account, amountIn - bal], `mint ${isBuy ? "USDG" : s.symbol}`);
  }
  const allowance = await ctx.pub.readContract({ address: tokenIn, abi: mockTokenAbi, functionName: "allowance", args: [ctx.account, m.router] });
  if (allowance < amountIn) await ctx.sender.sendCall(tokenIn, mockTokenAbi, "approve", [m.router, 2n ** 256n - 1n], "approve router");
  const fn = isBuy ? "buy" : "sell";
  const args = [s.token, amountIn, MAX_SLIPPAGE_BPS, ctx.account] as const;
  const sim = await simulate(ctx, m.router, routerAbi, fn, args);
  if (!sim.ok) return `pool not aligned (${before} bps off): ${fn} reverts ${sim.errorName}`;
  await ctx.sender.sendCall(m.router, routerAbi, fn, args, `align ${s.symbol}`);
  const slot0After = await ctx.pub.readContract({ address: m.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  const after = divergenceBps(priceAt(BigInt(slot0After) & ((1n << 160n) - 1n), usdgDec, tokenDec, usdgIs0), q.priceUsdPerToken);
  return `pool aligned ${before} -> ${after} bps (${fn} ${amountIn})`;
}
