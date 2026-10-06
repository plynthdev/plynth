// In-house perps on real feeds (LP deposit/redeem, long and short open/increase/decrease/close, funding, a
// third-party liquidation, a trade-only operator), then the treasury's T2 desks on the same venue: hedge desk
// order, basis pair open -> funding flip -> close, PositionMirror staleness blocking new risk, and a reconciler
// break blocking the period close.
import { encodeAbiParameters, getAddress, maxUint256, stringToHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { basisPeriodReport, BasisSleeveDesk, decideBasis } from "@/treasury/desks/basis";
import { hedgeOnce } from "@/treasury/desks/hedge";
import { breakGate, PgExceptionStore, PgLedger } from "@/treasury/reconciler";
import { signSnapshot } from "@/treasury/risk/mirror";
import { AccountExecutor, InHouseClient } from "@/treasury/venues";
import type { Compiled } from "@/treasury/policy-compiler";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { devAccount, FORK_CHAIN_ID, PATHS, ROLE } from "../lib";
import { abiOf, expect, j } from "./core";
import { E18, erc20Abi, HOUR, U, usdgOf, type Ctx } from "./context";
import { db, runOnce, treasuryEnv } from "./services";
import { packProofs } from "@/treasury/desks/runner";

const LP_DEPOSIT = 50_000n * U;

/** Before the 48h warp: the LP deposits, so its 24h redeem cooldown has passed when the perps area runs. */
export async function perpsSetup(x: Ctx) {
  const { r, A } = x;
  const pool = x.addr("perpPool");
  const PP = abiOf("PerpPool");
  await r.send("LP approves the perp pool", A.lp, { address: x.addr("usdg"), abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] });
  await r.send("LP deposits 50,000 USDG into the PerpPool (ERC-4626)", A.lp, { address: pool, abi: PP, functionName: "deposit", args: [LP_DEPOSIT, A.lp.address] }, async () => {
    const sh = await r.read<bigint>(pool, PP, "balanceOf", [A.lp.address]);
    expect(sh > 0n, "no shares");
    return `${sh} pPLP shares`;
  });
  await r.reverts("an LP cannot deposit for someone else (would reset their cooldown)", A.lp, { address: pool, abi: PP, functionName: "deposit", args: [1n * U, A.outsider.address] }, "ReceiverNotSender");
  await r.reverts("an LP cannot redeem inside the 24h cooldown (maxRedeem is 0 until it ends)", A.lp, { address: pool, abi: PP, functionName: "redeem", args: [1n, A.lp.address, A.lp.address] }, "ERC4626ExceededMaxRedeem");
}

export async function perps(x: Ctx) {
  const { r, A } = x;
  const pool = x.addr("perpPool");
  const PP = abiOf("PerpPool");
  const PM = abiOf("PerpMarket");
  const aaplM = getAddress(x.dep.perpMarkets.AAPL!);
  const tslaM = getAddress(x.dep.perpMarkets.TSLA!);
  for (const who of [A.longT, A.shortT, A.trader2]) await r.send(`${r.who(who)} approves the perp pool for collateral`, who, { address: x.addr("usdg"), abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] });
  const pos = (m: Address, who: Address) => r.read<{ size: bigint; collateral: bigint; tokens: bigint; isLong: boolean }>(m, PM, "position", [who]);

  // ---- positions on AAPL (real feed price)
  await r.send("long opens 50k USDG long AAPL at 10x", A.longT, { address: aaplM, abi: PM, functionName: "open", args: [true, 50_000n * U, 5_000n * U, 100n] }, async () => {
    const p = await pos(aaplM, A.longT.address);
    expect(p.isLong && p.size === 50_000n * U, j(p));
    return `size 50k, ${Number(p.tokens) / 1e18} AAPL at the feed price`;
  });
  await r.send("long increases by 10k", A.longT, { address: aaplM, abi: PM, functionName: "increase", args: [10_000n * U, 1_000n * U, 100n] }, async () => `size ${(await pos(aaplM, A.longT.address)).size / U}`);
  await r.send("short opens 20k USDG short AAPL", A.shortT, { address: aaplM, abi: PM, functionName: "open", args: [false, 20_000n * U, 4_000n * U, 100n] }, async () => `short size ${(await pos(aaplM, A.shortT.address)).size / U}`);
  await r.reverts("a second open on the same market reverts (one position per account)", A.shortT, { address: aaplM, abi: PM, functionName: "open", args: [false, 1_000n * U, 500n * U, 100n] }, "HasPosition");
  await r.reverts("leverage above 50x is refused", A.trader2, { address: aaplM, abi: PM, functionName: "open", args: [true, 10_000n * U, 100n * U, 100n] }, "Leverage");
  await r.check("funding: the heavier long side pays", async () => {
    const [rate, longsPay] = await r.read<[bigint, boolean]>(aaplM, PM, "fundingRate");
    expect(longsPay && rate > 0n, `rate ${rate} longsPay ${longsPay}`);
    return `rate ${rate} /s (1e18), longs pay`;
  });
  const eq0 = await r.read<bigint>(aaplM, PM, "equityOf", [A.longT.address]);
  await r.check("warp 4h: funding and borrow accrue", async () => {
    await r.warp(4n * HOUR);
    return `chain time ${await r.now()}`;
  });
  await r.send("anyone pokes funding accrual", A.outsider, { address: aaplM, abi: PM, functionName: "funding" }, async () => {
    const eq1 = await r.read<bigint>(aaplM, PM, "equityOf", [A.longT.address]);
    expect(eq1 < eq0, `long equity ${eq0} -> ${eq1}`);
    return `long equity ${Number(eq0) / 1e6} -> ${Number(eq1) / 1e6} USDG (paid funding + borrow)`;
  });
  const b0 = await usdgOf(x, A.longT.address);
  await r.send("long decreases by 20k (realises PnL net of funding)", A.longT, { address: aaplM, abi: PM, functionName: "decrease", args: [20_000n * U] }, async (rc) => {
    const got = (await usdgOf(x, A.longT.address)) - b0;
    return `size ${(await pos(aaplM, A.longT.address)).size / U}k left, ${Number(got) / 1e6} USDG paid out (block ${rc.blockNumber})`;
  });
  await r.send("short closes", A.shortT, { address: aaplM, abi: PM, functionName: "close" }, async () => {
    expect((await pos(aaplM, A.shortT.address)).size === 0n, "still open");
    return "short position closed, collateral returned";
  });

  // ---- trade-only operator: may trade for the account, never take its money
  await r.send("short authorises a trade-only operator", A.shortT, { address: pool, abi: PP, functionName: "setOperator", args: [A.operator.address, true] });
  await r.send("operator opens a 5k short for the account", A.operator, { address: aaplM, abi: PM, functionName: "openFor", args: [A.shortT.address, false, 5_000n * U, 1_000n * U, 100n] }, async () => {
    expect((await pos(aaplM, A.shortT.address)).size === 5_000n * U, "not opened for the account");
    return "position belongs to the account; collateral pulled from the account";
  });
  const op0 = await usdgOf(x, A.operator.address);
  await r.send("operator closes it: proceeds go to the account, not the operator", A.operator, { address: aaplM, abi: PM, functionName: "closeFor", args: [A.shortT.address] }, async () => {
    expect((await usdgOf(x, A.operator.address)) === op0, "operator received USDG");
    return "operator balance unchanged";
  });
  await r.send("LP also authorises the operator (trading only)", A.lp, { address: pool, abi: PP, functionName: "setOperator", args: [A.operator.address, true] });
  await r.reverts("operator cannot withdraw the LP's pool shares", A.operator, { address: pool, abi: PP, functionName: "redeem", args: [1_000n, A.operator.address, A.lp.address] }, "ERC20InsufficientAllowance");
  await r.reverts("an account's operator cannot liquidate it", A.operator, { address: aaplM, abi: PM, functionName: "liquidate", args: [A.shortT.address] }, "NotAuthorized");

  // ---- liquidation by a third party (borrow fee raised by the market owner to make it reachable on frozen prices)
  await r.send("trader opens a 45x long AAPL (10k on 222 USDG)", A.trader2, { address: aaplM, abi: PM, functionName: "open", args: [true, 10_000n * U, 222n * U, 100n] });
  await r.reverts("a healthy position cannot be liquidated", A.liquidator, { address: aaplM, abi: PM, functionName: "liquidate", args: [A.trader2.address] }, "NotLiquidatable");
  const params = await Promise.all(["takerFeeBps", "makerFeeBps", "offHoursSpreadBps", "borrowBpsPerHour", "fundingK", "oiCapBps", "maxProfitBps", "liquidationFee"].map((f) => r.read<bigint>(aaplM, PM, f)));
  const raised = [...params];
  raised[3] = 100n; // 1%/h borrow
  await r.send("market owner raises the AAPL borrow fee to 1%/h", A.deployer, { address: aaplM, abi: PM, functionName: "setParams", args: raised });
  await r.check("warp 2h: borrow eats the thin margin", async () => {
    await r.warp(2n * HOUR);
    expect(await r.read<boolean>(aaplM, PM, "isLiquidatable", [A.trader2.address]), "not liquidatable yet");
    return "isLiquidatable(trader) = true";
  });
  const l0 = await usdgOf(x, A.liquidator.address);
  await r.send("a third party liquidates and earns the fee", A.liquidator, { address: aaplM, abi: PM, functionName: "liquidate", args: [A.trader2.address] }, async () => {
    const got = (await usdgOf(x, A.liquidator.address)) - l0;
    expect(got > 0n && (await pos(aaplM, A.trader2.address)).size === 0n, `reward ${got}`);
    return `position gone; liquidator earned ${Number(got) / 1e6} USDG`;
  });
  await r.send("market owner restores the borrow fee", A.deployer, { address: aaplM, abi: PM, functionName: "setParams", args: params });
  await r.send("long closes the rest", A.longT, { address: aaplM, abi: PM, functionName: "close" });

  // ---- LP redeem after the cooldown
  const sh = await r.read<bigint>(pool, PP, "balanceOf", [A.lp.address]);
  const lb = await usdgOf(x, A.lp.address);
  await r.send("LP redeems half its shares after the 24h cooldown", A.lp, { address: pool, abi: PP, functionName: "redeem", args: [sh / 2n, A.lp.address, A.lp.address] }, async () => {
    const got = (await usdgOf(x, A.lp.address)) - lb;
    expect(got > 20_000n * U, `got ${got}`);
    return `${Number(got) / 1e6} USDG for half the shares (fees, funding and losses of traders included)`;
  });

  // ---- treasury T2 desks on the in-house TSLA market
  const t = x.state.treasury as Record<string, Address> | undefined;
  const t2 = x.state.t2 as Compiled | undefined;
  if (!t || !t2) throw new Error("treasury T2 setup missing");
  const venueProof = (v: Address) => t2.venues.find((w) => getAddress(w.address) === getAddress(v))!.proof;
  const usdgProof = t2.instruments.find((i) => i.label === "USDG")!.proof;
  const valuer = x.addr("valuer");
  const usdg = x.addr("usdg");
  const tsla = x.token("TSLA");
  const chain = r.c.chain;
  const key = (i: number) => devAccount(i) as unknown as PrivateKeyAccount;
  const ledger = new PgLedger(db().db);

  // Hedge desk: net delta above a 0-25% target band -> short more through the guard-checked in-house client.
  const execH = new AccountExecutor(r.pub, r.wallet(A.hedgeDesk) as never, key(ROLE.hedge), chain, t.account!, "hedge");
  const hedge = new InHouseClient(r.pub, { venue: t.hedgeVenue!, valuer, usdg, sleeve: t.perp!, venueIdx: 0, venueProof: venueProof(t.hedgeVenue!), executor: execH });
  await r.external("hedge desk shorts TSLA perps to bring net delta into its band (guard-checked execute)", "hedge desk", async () => {
    const s = await r.read<{ nav: bigint; stockUsd: bigint; perpDeltaUsd: bigint }>(x.addr("policyGuard"), abiOf("PolicyGuard"), "snapshot", [t.account!]);
    const q = await r.read<{ priceUsdPerToken: bigint; hold: boolean }>(valuer, x.abi("Valuer"), "quote", [tsla]);
    // A target band 5-15% below today's delta: one ~10%-of-NAV short, below the $20k board-ticket line.
    const delta = Number(((s.stockUsd + (s.perpDeltaUsd > 0n ? s.perpDeltaUsd : 0n)) * 10_000n) / s.nav);
    const res = await hedgeOnce({ navUsd: s.nav, stockUsd: s.stockUsd, perpDeltaUsd: s.perpDeltaUsd, band: { minBps: Math.max(0, delta - 1500), maxBps: Math.max(1, delta - 500) }, offHours: q.hold, shortTokens: 0n, priceUsd: q.priceUsdPerToken }, { underlying: tsla }, hedge, (f) => ledger.record(FORK_CHAIN_ID, t.account!, f));
    expect(res.decision.action === "short_more" && !!res.order, j(res.decision));
    const st = await hedge.statement();
    expect(st.positions.some((p) => p.tokens < 0n), "no short at the venue");
    return { tx: res.order?.id as Hex | undefined, assertion: `${res.decision.reason}: delta ${res.decision.deltaBps / 100}% -> short ${Number(res.order!.tokens) / 1e18} TSLA; fill recorded in the ledger` };
  });

  // Basis desk: longs pay on TSLA (the crowd is long) -> open a pair (spot TSLA + short perp) -> funding flips -> close.
  await r.send("crowd: a 200k long on the TSLA perp (longs pay)", A.longT, { address: tslaM, abi: PM, functionName: "open", args: [true, 200_000n * U, 40_000n * U, 100n] });
  await r.send("crowd: a small short on the TSLA perp (both sides open)", A.shortT, { address: tslaM, abi: PM, functionName: "open", args: [false, 10_000n * U, 2_000n * U, 100n] });
  const execB = new AccountExecutor(r.pub, r.wallet(A.basisDesk) as never, key(ROLE.basis), chain, t.account!, "basis");
  const desk = new BasisSleeveDesk(r.pub, execB, t.basis!, usdg, venueProof(t.basisVenue!), usdgProof);
  const basisClient = new InHouseClient(r.pub, { venue: t.basisVenue!, valuer, usdg });
  const t0 = await r.now();
  const inputs = async (open: bigint | null) => {
    const [f] = await basisClient.funding();
    const q = await r.read<{ hold: boolean }>(valuer, x.abi("Valuer"), "quote", [tsla]);
    return { fundingRate: f!.ratePerSecond, streakSec: 9 * 3600, openPairId: open, drawdown: "normal" as const, offHours: q.hold, depthOk: true, floatRoom: true, venueRoom: true, capBreached: false };
  };
  const i0 = await inputs(null);
  await r.check("basis desk decides to open (funding positive for 8h+)", async () => {
    const d = decideBasis(i0, {});
    expect(d.action === "open", j(d));
    return `${d.reason}, funding ${i0.fundingRate} /s`;
  }, "basis desk");
  await r.external("basis desk opens a pair: treasury TSLA spot + short TSLA perp, delta-neutral", "basis desk", async () => {
    const o = await desk.open(0, tsla, 3_000n * U, 1_500n * U, 100);
    expect(o.ok, j(o));
    const p = (await desk.pairs())[0]!;
    const delta = await r.read<bigint>(t.basis!, abiOf("BasisSleeve"), "pairDelta", [0n]);
    expect(delta === 0n, `pair delta ${delta}`);
    return { tx: (o as { tx: Hex }).tx, assertion: `pair 0: ${Number(p.perpTokens) / 1e18} TSLA short vs equal spot; pairDelta = 0` };
  });
  await r.check("warp 3h: the pair earns funding", async () => {
    await r.warp(3n * HOUR);
    const carry = await r.read<bigint>(t.basis!, abiOf("BasisSleeve"), "pairCarry", [0n]);
    expect(carry > 0n, `carry ${carry}`);
    return `pairCarry ${Number(carry) / 1e18} USD`;
  });
  await r.send("crowd flips: the long closes", A.longT, { address: tslaM, abi: PM, functionName: "close" });
  await r.send("crowd flips: the short closes", A.shortT, { address: tslaM, abi: PM, functionName: "close" });
  await r.send("crowd flips: a 150k short (shorts pay now)", A.shortT, { address: tslaM, abi: PM, functionName: "open", args: [false, 150_000n * U, 30_000n * U, 100n] });
  await r.send("crowd flips: a small long", A.longT, { address: tslaM, abi: PM, functionName: "open", args: [true, 10_000n * U, 2_000n * U, 100n] });
  const open = await desk.openPairId(0, tsla);
  const i1 = await inputs(open);
  await r.check("basis desk decides to close on the funding flip", async () => {
    const d = decideBasis(i1, {});
    expect(d.action === "close" && i1.fundingRate < 0n, j(d));
    return `${d.reason}, funding ${i1.fundingRate} /s`;
  }, "basis desk");
  await r.external("basis desk closes the pair; realised carry counts in NAV", "basis desk", async () => {
    const c = await desk.close(open!);
    expect(c.ok, j(c));
    const rep = basisPeriodReport(await desk.pairs(), t0, (await r.now()) + 1n);
    expect(rep.pairsClosed === 1, j(rep));
    return { tx: (c as { tx: Hex }).tx, assertion: `1 pair closed; realised carry ${Number(rep.navContributionUsd) / 1e18} USD (NAV, never a rate)` };
  });
  await r.send("crowd: the TSLA short closes", A.shortT, { address: tslaM, abi: PM, functionName: "close" });
  await r.send("crowd: the TSLA long closes", A.longT, { address: tslaM, abi: PM, functionName: "close" });

  // PositionMirror: a fresh controller snapshot allows new margin at the off-chain venue; a stale one refuses it.
  const mirror = t.mirror!;
  const controller = key(ROLE.controller);
  const post = async (label: string) => {
    const ts = await r.now();
    const s = await signSnapshot(controller, FORK_CHAIN_ID, mirror, t.mirrorVenue!, { positions: [], equityUsd: 0n, flowInSeen: await r.read<bigint>(t.mirrorVenue!, abiOf("MirroredPerpVenue"), "flowIn") }, ts);
    return r.send(label, A.controller, { address: mirror, abi: abiOf("PositionMirror"), functionName: "post", args: [s.venue, s.positions, s.equityUsd, s.flowInSeen, s.ts, s.signature] }, async () => `snapshot at ${ts}`);
  };
  await post("controller posts a signed PositionMirror snapshot for the off-chain venue");
  const dep = (amt: bigint) => ({
    address: t.account!,
    abi: abiOf("TreasuryAccount"),
    functionName: "execute",
    args: [stringToHex("hedge", { size: 32 }), t.perp!, encodeAbiParameters([{ type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, { type: "bytes" }], [[{ token: usdg, amount: amt }], encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "bytes" }], [0, 1n, encodeAbiParameters([{ type: "uint256" }], [amt])])]), packProofs([venueProof(t.mirrorVenue!)]), `0x${"0".repeat(64)}`],
  }) as const;
  await r.send("hedge desk posts 1,000 USDG margin to the off-chain venue (mirror fresh)", A.hedgeDesk, dep(1_000n * U), async () => `flowIn ${(await r.read<bigint>(t.mirrorVenue!, abiOf("MirroredPerpVenue"), "flowIn")) / U} USDG`);
  await r.check("warp 11 minutes: the mirror goes stale", async () => {
    await r.warp(11n * 60n);
    expect(await r.read<boolean>(mirror, abiOf("PositionMirror"), "isStale", [t.mirrorVenue!]), "not stale");
    return "isStale = true";
  });
  await r.reverts("a stale mirror blocks new margin at that venue", A.hedgeDesk, dep(500n * U), "GuardRejected(16)");
  await post("controller posts a fresh snapshot (venue usable again)");

  // Reconciler: the in-house hedge venue vs the fill ledger; an order the ledger never saw is a break, and an
  // open break makes the close service refuse the period close.
  const recCfg = join(PATHS.treasury, "reconcile.json");
  writeFileSync(recCfg, JSON.stringify({ account: t.account, mirror, venues: [{ kind: "inhouse", venue: t.hedgeVenue, valuer, usdg }] }, null, 2));
  await r.check("reconciler: venue statement == fill ledger (no break)", async () => {
    const run = await runOnce("src/bin/treasury-reconciler.ts", ["--once"], treasuryEnv({ TREASURY_RECONCILE_CONFIG: recCfg }));
    expect(run.code === 0 && /0 break/.test(run.out), `exit ${run.code}: ${run.out.slice(-400)}`);
    return run.out.split("\n").find((l) => l.includes("pass done")) ?? "clean";
  }, "reconciler");
  await r.external("hedge desk places an order whose fill never reaches the ledger", "hedge desk", async () => {
    const o = await hedge.placeOrder({ underlying: tsla, side: "sell", tokens: E18 / 10n, reduceOnly: false, maxSlippageBps: 100 });
    return { tx: o.id as Hex, assertion: "0.1 TSLA short added at the venue, not recorded" };
  });
  await r.check("reconciler opens a break", async () => {
    const run = await runOnce("src/bin/treasury-reconciler.ts", ["--once"], treasuryEnv({ TREASURY_RECONCILE_CONFIG: recCfg }));
    expect(run.code === 2 && /1 new/.test(run.out), `exit ${run.code}: ${run.out.slice(-400)}`);
    const n = await breakGate(new PgExceptionStore(db().db), FORK_CHAIN_ID, t.account!).count();
    expect(n >= 1, `open breaks ${n}`);
    return `${n} open break(s) in the exceptions table`;
  }, "reconciler");
  await r.check("the close service refuses to close while a reconciliation break is open", async () => {
    const before = await r.read<bigint>(t.close!, abiOf("PeriodClose"), "closeCount");
    const run = await runOnce("src/bin/treasury-close.ts", ["--once"], treasuryEnv({ TREASURY_PERIOD_CLOSE: t.close! }));
    const after = await r.read<bigint>(t.close!, abiOf("PeriodClose"), "closeCount");
    expect(after === before && /break|reconcil/i.test(run.out), `exit ${run.code}, closes ${before} -> ${after}: ${run.out.slice(-400)}`);
    return run.out.split("\n").find((l) => /break|reconcil/i.test(l))?.slice(0, 180) ?? "refused";
  }, "close service");
}
