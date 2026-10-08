// Instant parts of the complete testnet run: a liquidation set up on the perp
// venue, the first treasury period close, the exception-insurance pool and the FeeRouter fee path, and the issuer
// controls the testnet mocks have (USDG freeze, Stock Token uiMultiplier). What waits on real time is scheduled
// (exercise/more-scheduled.ts).
import { getAddress, keccak256, maxUint256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { buildClose, signClose } from "@/treasury/close/service";
import { CloseStore } from "@/treasury/close/store";
import { abiOf, expect, j } from "../../fork/exercise/core";
import { TESTNET_CHAIN_ID } from "../lib";
import { erc20Abi } from "./areas";
import { api, chainNow, dur, E18, events, HOUR, timers, U, type TCtx } from "./ctx";
import { db } from "./services";

/** Perp parameters in setParams order. */
export const PERP_PARAMS = ["takerFeeBps", "makerFeeBps", "offHoursSpreadBps", "borrowBpsPerHour", "fundingK", "oiCapBps", "maxProfitBps", "liquidationFee"] as const;

// ---------------------------------------------------------------- perps: liquidation (set up now, liquidated later)

/** PerpMarket.MAINTENANCE_BPS and the headroom left above it plus the opening taker fee. */
export const MAINTENANCE_BPS = 100n;
export const LIQ_HEADROOM_BPS = 150n;

/**
 * Collateral for a position that opens healthy but a 1%/h borrow fee pushes under maintenance in about
 * LIQ_HEADROOM_BPS / 100 hours: maintenance + the taker fee (taken from collateral) + the headroom.
 */
export function liquidationCollateral(size: bigint, takerFeeBps: bigint): bigint {
  return (size * (MAINTENANCE_BPS + takerFeeBps + LIQ_HEADROOM_BPS)) / 10_000n;
}

export async function liquidation(x: TCtx) {
  const { r, A } = x;
  const pool = x.addr("perpPool");
  const PM = abiOf("PerpMarket");
  const m = getAddress((x.dep.perpMarkets as Record<string, string>).mAAPL!);
  const usdg = x.addr("usdg");
  const t = A.quiet; // the trader who gets liquidated; the Open saver liquidates (a third party)
  const params = await Promise.all(PERP_PARAMS.map((f) => r.read<bigint>(m, PM, f)));
  x.data.perpParams = params.map(String);
  const size = 1_000n * U;
  // Collateral just above maintenance (1%) + the taker fee: ~1.5% of headroom, which a 1%/h borrow fee eats in
  // about 1.5 h (testnet has no time travel, and the frozen off-hours price does not move it).
  const collateral = liquidationCollateral(size, params[0]!);
  if ((await r.read<bigint>(usdg, erc20Abi, "balanceOf", [t.address])) < collateral) {
    await r.send("deployer mints the quiet saver 100 mUSDG of perp collateral", A.deployer, { address: usdg, abi: erc20Abi, functionName: "mint", args: [t.address, 100n * U] });
  }
  await r.send("quiet (perp trader) approves the perp pool for collateral", t, { address: usdg, abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] });
  const lev = Number((size * 10n) / collateral) / 10;
  await r.send(`quiet opens a ${lev}x long mAAPL (1,000 mUSDG on ${Number(collateral) / 1e6})`, t, { address: m, abi: PM, functionName: "open", args: [true, size, collateral, 100n] }, async () => {
    const p = await r.until("the position on a node that has the block", async () => {
      const q = await r.read<{ size: bigint }>(m, PM, "position", [t.address]);
      return q.size > 0n ? q : undefined;
    }, 30_000, 2000);
    return `size ${Number(p.size) / 1e6} mUSDG`;
  });
  await r.reverts("a healthy position cannot be liquidated", A.open, { address: m, abi: PM, functionName: "liquidate", args: [t.address] }, "NotLiquidatable");
  await r.reverts("a trader cannot liquidate itself", t, { address: m, abi: PM, functionName: "liquidate", args: [t.address] }, "NotAuthorized");
  await r.reverts("only the market owner may change its parameters", A.open, { address: m, abi: PM, functionName: "setParams", args: params }, "OwnableUnauthorizedAccount");
  const raised = [...params];
  raised[3] = 100n; // borrowBpsPerHour: the contract's maximum (1%/h)
  const rc = await r.send("market owner raises the mAAPL borrow fee to 1%/h (the contract maximum)", A.deployer, { address: m, abi: PM, functionName: "setParams", args: raised }, async () => {
    expect((await r.read<bigint>(m, PM, "borrowBpsPerHour")) === 100n, "borrow not raised");
    return "borrowBpsPerHour = 100";
  });
  if (rc) {
    const at = Number((await r.pub.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    x.schedule({ id: "perp-liquidation", handler: "perp-liquidation", area: "perps", title: "a third party liquidates the 1%/h-borrow-eaten mAAPL long and earns the fee; the owner restores the borrow fee", dueAt: at + HOUR, args: { market: m, trader: t.address } });
  }
}

// ---------------------------------------------------------------- treasury: the first period close

export async function close(x: TCtx) {
  const { r, A } = x;
  const t = x.data.treasury as Record<string, Address> | undefined;
  if (!t?.close) throw new Error("no treasury: run the treasury area first");
  const pc = getAddress(t.close);
  const PC = abiOf("PeriodClose");
  const store = new CloseStore(db().db);
  const ctx = { chain: r.c.chain, pub: r.pub, periodClose: pc, store } as const;
  const start = await r.read<bigint>(pc, PC, "startTime");
  // The close service targets startTime + one policy period (1 day). The contract accepts any first periodEnd
  // between startTime and now: a short first period, built and signed with the service's own code.
  const build = async () => {
    const periodEnd = BigInt(await chainNow(x)) - 2n;
    expect(periodEnd >= start, `periodEnd ${periodEnd} before startTime ${start}`);
    const b = await buildClose(ctx as never, periodEnd);
    expect(b.holdToken === zeroAddress, `a held feed: ${b.holdToken}`);
    return b;
  };
  let b = await build();
  // A 1-day period is a weekly-or-faster close: the board must hold the staking tier for it (10,000 PLTH on
  // testnet). The token area left the board at 8,000 (it unstaked 2,000), so the contract refuses first.
  const S = abiOf("PlinthStaking");
  const st = x.addr("staking");
  const tier = await r.read<{ weeklyClose: boolean }>(st, S, "tierOf", [A.deployer.address]);
  if (!tier.weeklyClose) {
    const sig0 = await signClose(A.controller, TESTNET_CHAIN_ID, pc, b.close);
    await r.reverts("a 1-day period close is refused while the board is below the weekly-close tier", A.controller, { address: pc, abi: PC, functionName: "commit", args: [b.close, sig0] }, "TierTooLow");
    const staked = await r.read<bigint>(st, S, "stakedOf", [A.deployer.address]);
    const need = 10_000n * E18 - staked;
    await r.send(`board approves staking for ${Number(need / E18)} PLTH`, A.deployer, { address: x.addr("plth"), abi: erc20Abi, functionName: "approve", args: [st, need] });
    await r.send(`board stakes ${Number(need / E18)} PLTH back up to the weekly-close tier (10,000)`, A.deployer, { address: st, abi: S, functionName: "stake", args: [need] }, async () => {
      const t2 = await r.until("tier 1", async () => {
        const v = await r.read<{ weeklyClose: boolean; maxDesks: number }>(st, S, "tierOf", [A.deployer.address]);
        return v.weeklyClose ? v : undefined;
      }, 30_000, 2000);
      return `tierOf(board): weeklyClose, maxDesks ${t2.maxDesks}`;
    });
    b = await build();
  }
  const forged = await signClose(A.cashDesk, TESTNET_CHAIN_ID, pc, b.close);
  await r.reverts("a close signed by anyone but the policy controller is refused", A.cashDesk, { address: pc, abi: PC, functionName: "commit", args: [b.close, forged] }, "BadSignature");
  await r.reverts("a close for a period end in the future is refused", A.controller, { address: pc, abi: PC, functionName: "commit", args: [{ ...b.close, periodEnd: b.close.periodEnd + 3_600n }, await signClose(A.controller, TESTNET_CHAIN_ID, pc, { ...b.close, periodEnd: b.close.periodEnd + 3_600n })] }, "PeriodInFuture");
  const fr0 = await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [x.addr("feeRouter")]);
  let sent = false;
  for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
    if (attempt > 1) b = await build(); // the NAV moved between build and commit (a desk trade): rebuild
    const sig = await signClose(A.controller, TESTNET_CHAIN_ID, pc, b.close);
    const id = await store.insertSigned({ chainId: TESTNET_CHAIN_ID, periodClose: pc, account: b.bundle.account, periodEnd: b.close.periodEnd, navUsd: b.close.navUsd, bundleHash: b.close.bundleHash, bundleJson: b.json, signature: sig, lastDeskActionId: b.lastDeskActionId });
    const nav = b.close.navUsd;
    const rc = await r.send(`controller commits the first period close (NAV $${(Number(nav / 10n ** 14n) / 1e4).toFixed(2)}, recomputed on-chain)${attempt > 1 ? ` (attempt ${attempt})` : ""}`, A.controller, { address: pc, abi: PC, functionName: "commit", args: [b.close, sig] }, async (rc) => {
      expect((await r.read<bigint>(pc, PC, "closeCount")) === 1n, "closeCount != 1");
      const ev = (await events(x, pc, "PeriodClose", "PeriodClosed", rc.blockNumber))[0];
      expect(!!ev, "no PeriodClosed");
      return `closeCount 1, bundle ${b.close.bundleHash.slice(0, 10)}…, fee ${Number(ev!.args.feePaid) / 1e6} mUSDG paid to the FeeRouter`;
    });
    if (rc) {
      await store.markCommitted(id, { txHash: rc.transactionHash, blockNumber: rc.blockNumber, closeIndex: 0 });
      sent = true;
    } else await store.markStatus(id, "stale", "commit failed in the exercise");
  }
  if (!sent) return;
  await r.reverts("the same period cannot be closed twice", A.controller, { address: pc, abi: PC, functionName: "commit", args: [b.close, await signClose(A.controller, TESTNET_CHAIN_ID, pc, b.close)] }, "PeriodTooEarly");
  await r.check("the close fee reached the FeeRouter", async () => {
    const got = (await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [x.addr("feeRouter")])) - fr0;
    expect(got >= 0n, `FeeRouter balance fell by ${-got}`);
    return `FeeRouter +${Number(got) / 1e6} mUSDG (management fee on a $1,000 treasury for a short first period)`;
  });
  await r.check("API: the committed close is listed with its bundle", async () => {
    const res = await r.until("closes list", async () => {
      const a = await api(`/v1/treasury/${t.account}/closes`);
      return a.status === 200 && j(a.body).includes(b.close.bundleHash) ? a : undefined;
    }, 120_000, 5000);
    return `HTTP 200: ${j(res.body).slice(0, 120)}`;
  }, "api");
}

// ---------------------------------------------------------------- token: insurance pool + FeeRouter fees

export async function insurance(x: TCtx) {
  const { r, A } = x;
  const t = x.data.treasury as Record<string, Address> | undefined;
  if (!t?.account) throw new Error("no treasury: run the treasury area first");
  const usdg = x.addr("usdg");
  const ins = x.addr("insurancePool");
  const fr = x.addr("feeRouter");
  const IP = abiOf("ExceptionInsurancePool");
  const FR = abiOf("FeeRouter");
  const lp = A.deployer; // the testnet LP, board and committee
  await r.send("LP approves the insurance pool for 2,000 mUSDG", lp, { address: usdg, abi: erc20Abi, functionName: "approve", args: [ins, 2_000n * U] });
  await r.send("LP deposits 2,000 mUSDG into the exception-insurance pool", lp, { address: ins, abi: IP, functionName: "deposit", args: [2_000n * U] }, async () => {
    const s = await r.read<bigint>(ins, IP, "sharesOf", [lp.address]);
    expect(s > 0n, "no shares");
    return `sharesOf(LP) = ${s}, activeShares ${await r.read<bigint>(ins, IP, "activeShares")}`;
  });
  await r.reverts("an outsider cannot pay fees into the insurance pool (router-only)", A.quiet, { address: ins, abi: IP, functionName: "depositFees", args: [1n] }, "NotFeeRouter");
  await r.reverts("only the treasury's board may file a claim", A.quiet, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account, 100n * E18, keccak256(toBytes("x"))] }, "NotBoard");

  let id = await r.read<bigint>(ins, IP, "claimCount");
  await r.send("board files a $100 policy-bug claim for its treasury", A.deployer, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account, 100n * E18, keccak256(toBytes("testnet drill: the guard let a breach through"))] });
  await r.reverts("only the committee may approve a claim", A.quiet, { address: ins, abi: IP, functionName: "approveClaim", args: [id] }, "NotCommittee");
  await r.send("committee approves the claim (not paid yet: the controller must attest)", A.deployer, { address: ins, abi: IP, functionName: "approveClaim", args: [id] }, async () => {
    const c = await r.read<{ paid: bigint; status: number }>(ins, IP, "claim", [id]);
    expect(c.paid === 0n, `paid ${c.paid}`);
    return `status ${c.status}, paid 0`;
  });
  await r.reverts("only the treasury's controller can attest", A.deployer, { address: ins, abi: IP, functionName: "attest", args: [id, true] }, "NotController");
  const tb = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [t.account]);
  await r.send("controller attests a policy bug: the claim is queued and paid to the treasury", A.controller, { address: ins, abi: IP, functionName: "attest", args: [id, true] }, async () => {
    const got = await r.until("the paid claim", async () => {
      const d = (await r.read<bigint>(usdg, erc20Abi, "balanceOf", [t.account])) - tb;
      return d === 100n * U ? d : undefined;
    }, 30_000, 2000);
    return `${Number(got) / 1e6} mUSDG paid to the TreasuryAccount (not to the board)`;
  });
  id = await r.read<bigint>(ins, IP, "claimCount");
  await r.send("board files a second claim ($50)", A.deployer, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account, 50n * E18, keccak256(toBytes("testnet drill: a market move"))] });
  await r.send("controller attests a market move: the claim is rejected, nothing paid", A.controller, { address: ins, abi: IP, functionName: "attest", args: [id, false] }, async () => {
    const c = await r.read<{ status: number; paid: bigint }>(ins, IP, "claim", [id]);
    expect(c.paid === 0n, "paid");
    return `status ${c.status} (rejected), paid 0`;
  });

  // LP exit: half the shares become a fixed liability payable after WITHDRAW_DELAY; the other half stays active,
  // so the next fee push still pays the pool its half.
  const shares = await r.read<bigint>(ins, IP, "sharesOf", [lp.address]);
  const delay = (await timers(x)).insuranceDelay;
  const rc = await r.send(`LP requests to withdraw half its shares (${dur(delay)} delay)`, lp, { address: ins, abi: IP, functionName: "requestWithdraw", args: [shares / 2n] }, async () => {
    const [requested, value, readyAt] = await r.read<[bigint, bigint, bigint]>(ins, IP, "pendingOf", [lp.address]);
    expect(requested === value && value > 900n * U, `requested ${requested} value ${value}`);
    return `pending ${Number(value) / 1e6} mUSDG, ready ${new Date(Number(readyAt) * 1000).toISOString()}`;
  });
  await r.reverts(`the LP cannot withdraw before the ${dur(delay)} delay`, lp, { address: ins, abi: IP, functionName: "withdraw" }, "NotReady");
  if (rc) {
    const [, , readyAt] = await r.read<[bigint, bigint, bigint]>(ins, IP, "pendingOf", [lp.address]);
    x.schedule({ id: "insurance-withdraw", handler: "insurance-withdraw", area: "token", title: `the LP withdraws its pending insurance value after the ${dur(delay)} delay`, dueAt: Number(readyAt) + 30 });
  }

  // Fees: the treasury close paid its fee to the FeeRouter; platform fees from the other sources arrive the same
  // way (the deployer stands in for them here). The running keeper observes the PLTH pool and pushes hourly.
  await r.reverts("an outsider cannot push the FeeRouter (keeper-only)", A.quiet, { address: fr, abi: FR, functionName: "push", args: [0n] }, "NotKeeper");
  await r.reverts("an outsider cannot record the buy's reference price (keeper-only)", A.quiet, { address: fr, abi: FR, functionName: "observe" }, "NotKeeper");
  const from = await r.pub.getBlockNumber();
  await r.send("platform fees: 20 mUSDG arrive at the FeeRouter", A.deployer, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [fr, 20n * U] }, async () => `FeeRouter holds ${Number(await r.read<bigint>(usdg, erc20Abi, "balanceOf", [fr])) / 1e6} mUSDG`);
  x.schedule({ id: "fee-push", handler: "fee-push", area: "token", title: "the running keeper pushes the FeeRouter (observation >= 10 min old, hourly): PLTH buyback, half to stakers, half to the insurance pool", dueAt: (await chainNow(x)) + 60, args: { from: String(from) } });
}

// ---------------------------------------------------------------- issuer controls on the testnet mocks

export async function issuer(x: TCtx) {
  const { r, A } = x;
  const usdg = x.addr("usdg");
  const vault = x.addr("savingsVault");
  const V = x.abi("SavingsVault");
  const M = abiOf("MockUSDG");
  const u = A.open;
  const [avail] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [u.address]);
  expect(avail >= 2n * U, `open has only ${avail} available in the vault`);
  await r.send("USDG issuer (mock) freezes the Open saver", A.deployer, { address: usdg, abi: M, functionName: "freeze", args: [u.address] }, async () => {
    expect(await r.read<boolean>(usdg, M, "frozen", [u.address]), "not frozen");
    return "frozen(open) = true";
  });
  await r.reverts("a frozen saver's vault withdraw reverts in the token (AccountFrozen), nothing moves", u, { address: vault, abi: V, functionName: "withdraw", args: [1n * U, u.address] }, "AccountFrozen");
  await r.send("USDG issuer (mock) unfreezes the Open saver", A.deployer, { address: usdg, abi: M, functionName: "unfreeze", args: [u.address] });
  const b0 = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [u.address]);
  await r.send("the unfrozen saver withdraws 1 mUSDG from the vault (the exit is never gated)", u, { address: vault, abi: V, functionName: "withdraw", args: [1n * U, u.address] }, async () => {
    const got = await r.until("the withdrawn balance", async () => {
      const d = (await r.read<bigint>(usdg, erc20Abi, "balanceOf", [u.address])) - b0;
      return d === 1n * U ? d : undefined;
    }, 30_000, 2000);
    return `${Number(got) / 1e6} mUSDG received`;
  });

  // Stock Token uiMultiplier (dividend-style drift): the Valuer prices a per-share feed times the live multiplier.
  const aapl = x.token("mAAPL");
  const S = abiOf("MockStockToken");
  const feed = getAddress((x.dep.stocks as Record<string, { feed: string }>).mAAPL!.feed);
  const F = abiOf("MockFeed");
  const m0 = await r.read<bigint>(aapl, S, "uiMultiplier");
  const m1 = (m0 * 10_030n) / 10_000n; // +0.3%: under the keeper's 50 bps pool-realign threshold
  const quote = async () => {
    const a0 = await r.read<bigint>(feed, F, "latestAnswer");
    const q = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [aapl]);
    const a1 = await r.read<bigint>(feed, F, "latestAnswer");
    return { q: q.priceUsdPerToken, answer: a0 === a1 ? a0 : undefined };
  };
  await r.reverts("only the issuer (token owner) may change the multiplier", u, { address: aapl, abi: S, functionName: "setUiMultiplier", args: [m1] }, "OwnableUnauthorizedAccount");
  await r.send("Stock Token issuer (mock) raises the mAAPL uiMultiplier by 0.3%", A.deployer, { address: aapl, abi: S, functionName: "setUiMultiplier", args: [m1] }, async () => {
    const got = await r.until("the new multiplier on a node that has the block", async () => ((await r.read<bigint>(aapl, S, "uiMultiplier")) === m1 ? true : undefined), 30_000, 2000);
    expect(got, "multiplier not set");
    const { q, answer } = await quote();
    expect(answer !== undefined, "the feed moved during the read");
    // Valuer: per-share answer (8 dp) x multiplier (1e18) -> 1e18 USD per token.
    const want = (answer! * 10n ** 10n * m1) / E18;
    const diff = q > want ? q - want : want - q;
    expect(diff * 1_000_000n <= want, `Valuer ${q} vs feed x new multiplier ${want}`);
    return `Valuer.quote(mAAPL) = $${(Number(q / 10n ** 14n) / 1e4).toFixed(4)} = feed ${Number(answer) / 1e8} x ${Number(m1) / 1e18}`;
  });
  await r.send("issuer (mock) restores the mAAPL multiplier", A.deployer, { address: aapl, abi: S, functionName: "setUiMultiplier", args: [m0] }, async () => {
    await r.until("the restored multiplier", async () => ((await r.read<bigint>(aapl, S, "uiMultiplier")) === m0 ? true : undefined), 30_000, 2000);
    return `uiMultiplier = ${Number(m0) / 1e18}`;
  });
  await r.check("API: holdings show the multiplier-adjusted value (raw units stored)", async () => {
    const res = await api(`/v1/account/${u.address}/overview`);
    expect(res.status === 200, `HTTP ${res.status}`);
    return `HTTP 200: ${j(res.body).slice(0, 120)}`;
  }, "api");
  x.notes.push("Issuer pause and blocklist are not exercised on testnet: the testnet mocks have neither (the real Stock Tokens do); the mainnet-fork runs drive the real issuer roles (pause, blockAccounts) and Plynth's exits under them.");
}
