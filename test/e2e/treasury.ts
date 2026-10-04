// scripts/e2e.sh treasury: a Plinth treasury on an anvil fork of Robinhood Chain mainnet.
//
// fork mainnet -> core (registry of real Stock Tokens with their real Chainlink feeds, Valuer, StockRouter on the
// real v4 USDG pools) -> PolicyGuard + locked implementations + TreasuryFactory -> factory deploy from the
// balanced template (real USDG, real steakUSDG, five deep-pool Stock Tokens, 7-day period) -> funded with
// 100k real USDG -> cash + equity desks run `treasury:desks --once` over a simulated week of time warps ->
// `treasury:close --once` commits the period -> `treasury:cfo-pack` renders it -> every number checked
// against the chain.
//
// The fork freezes Chainlink: no new rounds arrive after the fork block (and none arrive off-hours on the real
// chain either). The Valuer is deployed with a 60-day staleness window so the frozen marks stay usable for the
// simulated week; everything else (tokens, feeds, pools, vault, USDG) is the real mainnet contract.
import { compileTemplate, loadTemplate, policyAbiParam } from "@plynth/policy-compiler";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseAbi, stringToHex, type Address, type PublicClient } from "viem";
import { periodCloseAbi } from "../../apps/treasury/close/abi";
import { accountAbi, beaconAbi, guardAbi } from "../../apps/treasury/desks/abi";
import { beaconKey, dayStart, DAY } from "../../apps/treasury/desks/beacon";
import { artifact, KEYS, Kit } from "../../apps/treasury/test/kit";
import { Checks, clearDevAccountCode, e2eDb, onCleanup, ROOT, run, runCleanup, startFork } from "./lib";

const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const STEAK_USDG = getAddress("0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
const MORPHO = getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010"); // holds USDG supplied to Morpho markets
const FEE_TO = getAddress("0x00000000000000000000000000000000000fee70");
const FUNDING = 100_000n * 10n ** 6n;
const PERIOD_DAYS = 7;
/** Deep hookless USDG pools (docs: chain facts, default v4 pools 2026-10-04). Thin AMZN/GOOGL/QCOM left out. */
const NAMES = [
  { sym: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", fee: 3000, ts: 60, id: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e" }, // not-a-key (v4 pool id)
  { sym: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", fee: 3000, ts: 60, id: "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb" }, // not-a-key (v4 pool id)
  { sym: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", fee: 100, ts: 1, id: "0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5" }, // not-a-key (v4 pool id)
  { sym: "SPY", token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", fee: 500, ts: 5, id: "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907" }, // not-a-key (v4 pool id)
  { sym: "MSTR", token: "0xec262a75e413fAfD0dF80480274532C79D42da09", feed: "0x396118bdFB181e6240E74D243F266B061c0edc3D", fee: 2400, ts: 24, id: "0xc105b8300ff65d750a0e4e63c7a879e20504069b770713464a5315e797735326" }, // not-a-key (v4 pool id)
].map((n) => ({ ...n, token: getAddress(n.token), feed: getAddress(n.feed) }));
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);

/** The desk test kit, pointed at a fork's real chain id instead of 31337. */
class ForkKit extends Kit {
  constructor(rpc: string, id: number) {
    super(rpc);
    this.chain = defineChain({ id, name: `fork-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }) as never;
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  }
}

async function main(c: Checks) {
  const forkUrl = process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  c.step(`forking mainnet (${forkUrl})`);
  const anvil = await startFork(forkUrl);
  c.must("fork is Robinhood Chain mainnet (4663)", anvil.chainId === 4663, `chainId ${anvil.chainId}`);
  await clearDevAccountCode(anvil.rpc);
  const kit = new ForkKit(anvil.rpc, 4663);
  const a = kit.a;
  const d = kit.deployer.address;
  const rpc = (method: string, params: unknown[] = []) => kit.pub.request({ method: method as never, params: params as never });

  // ---- core on the real tokens ----
  c.step("deploying registry (real feeds), Valuer, StockRouter (real v4 pools)");
  a.usdg = USDG;
  a.vault = STEAK_USDG;
  a.pm = POOL_MANAGER;
  a.registry = await kit.deploy("StockTokenRegistry.sol", "StockTokenRegistry", [d]);
  a.valuer = await kit.deploy("Valuer.sol", "Valuer", [a.registry, 60n * DAY]);
  a.router = await kit.deploy("StockRouter.sol", "StockRouter", [POOL_MANAGER, a.registry, a.valuer, USDG, d]);
  for (const n of NAMES) {
    const usdgIs0 = BigInt(USDG) < BigInt(n.token);
    const key = { currency0: usdgIs0 ? USDG : n.token, currency1: usdgIs0 ? n.token : USDG, fee: n.fee, tickSpacing: n.ts, hooks: ZERO };
    const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    c.must(`${n.sym} pool key matches the verified pool id`, id === n.id, id);
    // Robinhood's Chainlink feeds price one TOKEN (multiplier embedded): verified in chain facts.
    await kit.send(a.registry, "StockTokenRegistry.sol", "StockTokenRegistry", "list", [n.token, n.feed, true]);
    await kit.send(a.router, "StockRouter.sol", "StockRouter", "setPool", [n.token, key]);
  }

  // ---- factory + treasury from the balanced template ----
  c.step("deploying PolicyGuard, implementations, TreasuryFactory; factory.deploy(balanced)");
  const dir = mkdtempSync(join(tmpdir(), "plynth-e2e-treasury-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const balanced = loadTemplate(join(ROOT, "templates", "balanced.yaml")) as Record<string, any>;
  const tpl = {
    ...balanced,
    name: "balanced-e2e",
    network: "mainnet",
    periodDays: PERIOD_DAYS,
    controller: d,
    instruments: [{ asset: "USDG", kind: "cash" }, { asset: "steakUSDG", kind: "cash_vault" }, ...NAMES.map((n) => ({ asset: n.sym, kind: "stock_token" }))],
    desks: { equity: { weights: Object.fromEntries(NAMES.map((n) => [n.sym, 1])) } },
  };
  writeFileSync(join(dir, "policy.yaml"), JSON.stringify(tpl, null, 2)); // JSON is YAML
  const compiled = compileTemplate(tpl as never, { controller: d, network: "mainnet" });
  c.eq("compiled policy keeps the balanced bands (cash 40-70%, equity 30-60%)", [compiled.policy.cash, compiled.policy.equity], [{ minBps: 4000, maxBps: 7000 }, { minBps: 3000, maxBps: 6000 }]);
  a.guard = await kit.deploy("PolicyGuard.sol", "PolicyGuard", [a.registry, a.valuer, 200]);
  const none = { cash: { minBps: 0, maxBps: 0 }, equity: { minBps: 0, maxBps: 0 }, basis: { minBps: 0, maxBps: 0 }, netDeltaMinBps: 0, netDeltaMaxBps: 0, maxLeverageX10: 0, perOrderCapUsd: 0n, perDayCapUsd: 0n, perNameFloatCapBps: 0, perVenueCapBps: 0, noNewRiskOffHours: false, pauseNewRiskAtDrawdownBps: 0, deriskAtDrawdownBps: 0, approvalAboveUsd: 0n, periodSeconds: 0, instrumentAllowRoot: `0x${"0".repeat(64)}`, venueAllowRoot: `0x${"0".repeat(64)}`, controller: ZERO };
  a.policyImpl = await kit.deploy("TreasuryPolicy.sol", "TreasuryPolicy", [ZERO, none]);
  a.accountImpl = await kit.deploy("TreasuryAccount.sol", "TreasuryAccount", [ZERO, ZERO, ZERO, ZERO]);
  a.closeImpl = await kit.deploy("PeriodClose.sol", "PeriodClose", [ZERO, ZERO, ZERO, ZERO]);
  a.approvalsImpl = await kit.deploy("BoardApprovals.sol", "BoardApprovals", [ZERO, ZERO]);
  a.templates = await kit.deploy("TemplateRegistry.sol", "TemplateRegistry", [d, ZERO]);
  a.factory = await kit.deploy("TreasuryFactory.sol", "TreasuryFactory", [a.policyImpl, a.accountImpl, a.closeImpl, a.approvalsImpl, a.guard, USDG, FEE_TO, ZERO, a.templates]);
  const factoryBlock = await kit.pub.getBlockNumber();
  const rc = await kit.send(a.factory, "TreasuryFactory.sol", "TreasuryFactory", "deploy", [encodeAbiParameters([policyAbiParam], [compiled.policy]), d]);
  for (const l of rc.logs) {
    try {
      const ev = decodeEventLog({ abi: artifact("TreasuryFactory.sol", "TreasuryFactory").abi, data: l.data, topics: l.topics }) as { eventName: string; args: Record<string, Address> };
      if (ev.eventName !== "TreasuryCreated") continue;
      a.account = ev.args.account!;
      a.policy = ev.args.policy!;
      a.periodClose = ev.args.close!;
      a.approvals = ev.args.approvals!;
    } catch {}
  }
  c.must("factory emitted TreasuryCreated", Boolean(a.account && a.periodClose));
  a.cashSleeve = await kit.deploy("CashSleeve.sol", "CashSleeve", [a.valuer, USDG, [STEAK_USDG]]);
  a.equitySleeve = await kit.deploy("EquitySleeve.sol", "EquitySleeve", [a.router, NAMES.map((n) => n.token)]);
  a.beacon = await kit.deploy("JitterBeacon.sol", "JitterBeacon", [kit.equityKey.address, d]);
  await kit.send(a.account!, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("cash", { size: 32 }), kit.cashKey.address, [a.cashSleeve]]);
  await kit.send(a.account!, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("equity", { size: 32 }), kit.equityKey.address, [a.equitySleeve]]);

  // ---- fund with real USDG (moved out of Morpho Blue's balance on the fork) ----
  await rpc("anvil_impersonateAccount", [MORPHO]);
  await rpc("anvil_setBalance", [MORPHO, "0xde0b6b3a7640000"]);
  const fundHash = await kit.pub.request({ method: "eth_sendTransaction" as never, params: [{ from: MORPHO, to: USDG, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [a.account!, FUNDING] }) }] as never });
  await kit.pub.waitForTransactionReceipt({ hash: fundHash as never });
  await rpc("anvil_stopImpersonatingAccount", [MORPHO]);
  c.eq("treasury holds 100,000 real USDG", await kit.pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [a.account!] }), FUNDING);

  const cfgPath = join(dir, "desks.json");
  writeFileSync(cfgPath, JSON.stringify({ rpcUrl: anvil.rpc, account: a.account, cashSleeve: a.cashSleeve, equitySleeve: a.equitySleeve, vault: STEAK_USDG, beacon: a.beacon, cashDeskId: "cash", equityDeskId: "equity", policyTemplate: "policy.yaml", network: "mainnet" }));
  const db = await e2eDb("treasury");
  const env = { DATABASE_URL: db.url, TREASURY_RPC_URL: anvil.rpc, TREASURY_POLL_MS: "100" };
  const desks = () => run(["bun", "run", "treasury:desks", "--once"], { env: { ...env, TREASURY_CONFIG: cfgPath, TREASURY_CASH_DESK_KEY: KEYS.cash, TREASURY_EQUITY_DESK_KEY: KEYS.equity } });
  const rows = async () => (await db.sql`select desk, action, status, reason, asset, beacon_key from desk_actions order by id`) as unknown as { desk: string; action: string; status: string; reason: string | null; asset: string | null; beacon_key: string | null }[];
  const snapshot = () => kit.pub.readContract({ address: a.guard!, abi: guardAbi, functionName: "snapshot", args: [a.account!] });
  const weights = async () => {
    const s = await snapshot();
    return { cash: Number((s.cashUsd * 10_000n) / s.nav), equity: Number((s.equityUsd * 10_000n) / s.nav), nav: s.nav, hold: s.equityHold };
  };

  // ---- a simulated week ----
  c.step("desks: day 0 commits the first beacon");
  desks();
  const start = await kit.read<bigint>(a.periodClose!, "PeriodClose.sol", "PeriodClose", "startTime");
  let day = dayStart(await kit.now());
  for (let i = 1; i <= PERIOD_DAYS; i++) {
    day += DAY;
    await kit.warpTo(day + 60n);
    desks(); // reveal today's beacon, commit ahead
    const b = await kit.pub.readContract({ address: a.beacon!, abi: beaconAbi, functionName: "beacon", args: [beaconKey(a.account!, day)] });
    if (b.executeAt > (await kit.now())) await kit.warpTo(b.executeAt);
    desks(); // rebalance at the jittered time, then the cash desk sweeps/redeems
    const w = await weights();
    const r = await rows();
    c.step(`day ${i}: NAV $${(Number(w.nav / 10n ** 12n) / 1e6).toFixed(2)}, cash ${w.cash} bps, equity ${w.equity} bps, ${r.filter((x) => x.status === "sent").length} desk txs so far`);
    c.ok(`day ${i}: weights inside the bands`, w.cash >= 4000 && w.cash <= 7000 && w.equity >= 3000 && w.equity <= 6000, JSON.stringify({ cash: w.cash, equity: w.equity }));
    c.ok(`day ${i}: rebalance finished at the beacon time`, r.some((x) => x.action === "rebalance_done" && x.beacon_key === beaconKey(a.account!, day)));
  }
  const r = await rows();
  const bought = new Set(r.filter((x) => x.action === "buy" && x.status === "sent").map((x) => x.asset));
  // A name whose real pool trades more than the desk's slippage away from its (frozen) Chainlink mark is refused
  // by StockRouter's oracle guard: that is the guard working, not a failure. Every other name must be bought.
  const held = NAMES.filter((n) => bought.has(n.token.toLowerCase()));
  const refused = NAMES.filter((n) => !bought.has(n.token.toLowerCase()));
  for (const n of refused) {
    const tries = r.filter((x) => x.asset === n.token.toLowerCase() && x.action === "buy");
    c.ok(`${n.sym}: not bought only because the oracle guard refused the pool price`, tries.length > 0 && tries.every((x) => x.status === "rejected" && x.reason === "Slippage"), JSON.stringify(tries.slice(-2)));
    c.step(`${n.sym}: pool price is more than the desk slippage away from its Chainlink mark on this fork; buy refused`);
  }
  c.ok("equity desk bought at least 3 of the 5 names on the real pools", held.length >= 3, `${held.length}`);
  c.ok("cash desk parked USDG in real steakUSDG", r.some((x) => x.desk === "cash" && x.action === "deposit" && x.status === "sent"));
  for (const n of held) c.ok(`treasury holds real ${n.sym}`, (await kit.pub.readContract({ address: n.token, abi: erc20, functionName: "balanceOf", args: [a.account!] })) > 0n);
  const navWeek = (await weights()).nav;
  c.ok("NAV after a week within 1% of funding (pool fees + slippage only)", navWeek * 100n >= FUNDING * 10n ** 12n * 99n && navWeek <= FUNDING * 10n ** 12n * 101n / 100n, navWeek.toString());
  const [accNav] = await kit.pub.readContract({ address: a.account!, abi: accountAbi, functionName: "navUsd" });
  c.eq("guard and account agree on NAV", accNav, navWeek);

  // ---- period close ----
  c.step("period close");
  const periodEnd = start + BigInt(PERIOD_DAYS) * DAY;
  if ((await kit.now()) <= periodEnd) await kit.warpTo(periodEnd + 60n);
  // steakUSDG accrues every second, and the close commits an exact NAV, so the commit must land in a block with
  // the timestamp it was built at. Robinhood Chain (Arbitrum Orbit) makes several blocks per second; anvil gives
  // every block a new second unless told otherwise, so emulate the sub-second blocks for the commit.
  await rpc("anvil_setBlockTimestampInterval", [0]);
  const closeOut = run(["bun", "run", "treasury:close", "--once"], { env: { ...env, TREASURY_PERIOD_CLOSE: a.periodClose!, TREASURY_CONTROLLER_KEY: KEYS.deployer } });
  c.must("close service committed the period", closeOut.includes('"status":"committed"'), closeOut.slice(-800));
  const pcRead = <T>(fn: string, args: unknown[] = []) => kit.pub.readContract({ address: a.periodClose!, abi: periodCloseAbi, functionName: fn as never, args: args as never }) as Promise<T>;
  const latest = await pcRead<{ periodEnd: bigint; navUsd: bigint; cashBps: number; equityBps: number; bundleHash: string }>("latest");
  c.eq("closed period ends at start + 7 days", latest.periodEnd, periodEnd);
  const fee = await pcRead<bigint>("feeFor", [latest.navUsd, BigInt(PERIOD_DAYS) * DAY]);
  c.eq("fee paid to the fee recipient in real USDG", await kit.pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [FEE_TO] }), fee);
  c.ok("committed NAV is the treasury's on-chain NAV (steakUSDG accrues per second: within 0.01%)", latest.navUsd > 0n && (latest.navUsd > navWeek ? latest.navUsd - navWeek : navWeek - latest.navUsd) * 10_000n <= navWeek, `${latest.navUsd} vs ${navWeek}`);
  c.ok("committed weights inside the bands", latest.cashBps >= 4000 && latest.cashBps <= 7000 && latest.equityBps >= 3000 && latest.equityBps <= 6000);
  const stored = (await db.sql`select status, bundle_hash from closes where status = 'committed'`) as unknown as { bundle_hash: string }[];
  c.eq("stored bundle hash equals the on-chain one", stored[0]?.bundle_hash, latest.bundleHash.toLowerCase());

  // ---- CFO pack ----
  c.step("CFO pack");
  const out = join(dir, "cfo");
  run(["bun", "run", "treasury:cfo-pack", "--index", "0", "--from-block", factoryBlock.toString(), "--out", out], { env: { ...env, TREASURY_PERIOD_CLOSE: a.periodClose! } });
  const j = JSON.parse(readFileSync(join(out, "statement.json"), "utf8"));
  c.eq("statement.json NAV equals the on-chain close", j.statement.navUsd, latest.navUsd.toString());
  c.eq("statement.json bundle hash equals the on-chain close", j.statement.bundleHash, latest.bundleHash);
  const syms = j.positions.map((p: { symbol: string }) => p.symbol);
  c.ok("positions list every name held", held.every((n) => syms.some((s: string) => s.toUpperCase().includes(n.sym))), JSON.stringify(syms));
  c.ok("positions.csv carries the NAV", readFileSync(join(out, "positions.csv"), "utf8").includes(`nav_usd_1e18,${latest.navUsd}`));
  const html = readFileSync(join(out, "statement.html"), "utf8");
  c.ok("statement.html renders period #0, self-contained (no scripts, no remote URLs)", html.includes("Period statement #0") && !/<script|https?:\/\//i.test(html));
}

const c = new Checks("treasury");
let code = 1;
try {
  await main(c);
  code = c.finish();
} catch (e) {
  console.error(`[e2e treasury] ${(e as Error).stack ?? e}`);
  c.finish();
  code = 1;
} finally {
  await runCleanup();
}
process.exit(code);
