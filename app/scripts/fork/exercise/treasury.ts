// Treasury on the real assets: desk passes (cash sweep into real steakUSDG, equity rebalance on the real pools at
// the beacon time), guard rejections (order cap, band, not allowed, off-hours, drawdown PAUSED / DERISK), the
// board approval ticket path with the model jury (local Ollama), period close with the exact on-chain NAV, the
// CFO pack, hourly receipts with an on-chain proof, the marketplace author fee share, MCP tools through a
// board-issued token, and withdrawToBoard in PAUSED and DERISK.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, getAddress, stringToHex, toFunctionSelector, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { issueMessage } from "@/api";
import { beaconKey, dayStart, offsetOf, secretFor } from "@/treasury/desks/beacon";
import { exceptionFromChain, JuryService, PgJuryStore } from "@/treasury/jury";
import { packProofs } from "@/treasury/desks/runner";
import { devAccount, FORK_CHAIN_ID, PATHS, PORTS } from "../lib";
import { abiOf, expect, j } from "./core";
import { api, DAY, E18, erc20Abi, HOUR, U, usdgOf, weekendBookReason, type Ctx } from "./context";
import { db, runOnce, treasuryEnv } from "./services";
import { receiptsOnce } from "@/treasury/receipts/service";
import { ReceiptStore } from "@/treasury/receipts/store";
import type { Compiled } from "@/treasury/policy-compiler";

const PULLS = { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] } as const;
const wrap = (token: Address, amount: bigint, run: Hex) => encodeAbiParameters([PULLS, { type: "bytes" }], [[{ token, amount }], run]);
const cashRun = (op: number, vault: Address, amount: bigint, minOut: bigint) => encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [op, vault, amount, minOut]);
const equityRun = (op: number, token: Address, amount: bigint, slip: number) => encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint16" }], [op, token, amount, slip]);
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export async function treasury(x: Ctx) {
  const { r, A } = x;
  const t = x.state.treasury as Record<string, Address> | undefined;
  if (!t) throw new Error("no treasury (treasury-setup failed)");
  const ACC = abiOf("TreasuryAccount");
  const PC = abiOf("PeriodClose");
  const usdg = x.addr("usdg");
  const steak = x.addr("steakUsdg");
  const cashSleeve = x.addr("cashSleeve");
  const equitySleeve = x.addr("equitySleeve");
  const guard = x.addr("policyGuard");
  const t1 = x.state.t1 as Compiled;
  const proofOf = (asset: Address) => t1.instruments.find((i) => getAddress(i.asset) === getAddress(asset))?.proof ?? [];
  const snapshot = () => r.read<{ nav: bigint; cashUsd: bigint; equityUsd: bigint }>(guard, abiOf("PolicyGuard"), "snapshot", [t.account!]);
  const weights = async () => {
    const s = await snapshot();
    return { nav: s.nav, cash: Number((s.cashUsd * 10_000n) / s.nav), equity: Number((s.equityUsd * 10_000n) / s.nav) };
  };
  const exec = (deskId: string, adapter: Address, data: Hex, proofs: Hex[][], ticket: Hex = ZERO32) => ({ address: t.account!, abi: ACC, functionName: "execute", args: [stringToHex(deskId, { size: 32 }), adapter, data, packProofs(proofs), ticket] }) as const;
  // Slippage the sleeve accepts: at most the guard's maxOpLossBps (200 on the default fork stack, 50 on v2 MainnetBeta).
  const slip = Number(await r.read<number>(guard, abiOf("PolicyGuard"), "maxOpLossBps", []));
  const sharesFor = async (usd: bigint) => r.read<bigint>(steak, abiOf("ERC4626"), "convertToShares", [usd * U]);

  // ---- desk passes until the equity desk has rebalanced at its beacon time. The desk reveals only at that time
  // (its secret is a signature with its own key, which the harness can re-derive: dev account 5).
  const rows: { desk: string; action: string; status: string; asset: string | null }[] = [];
  const equityKey = devAccount(5);
  for (let i = 0; i < 3; i++) {
    const day = dayStart(await r.now());
    const key = beaconKey(t.account!, day);
    const b = await r.read<{ windowStart: bigint; windowEnd: bigint; executeAt: bigint }>(t.beacon!, abiOf("JitterBeacon"), "beacon", [key]);
    let at = await r.read<bigint>(t.beacon!, abiOf("JitterBeacon"), "executeAfter", [key]);
    if (BigInt(b.windowEnd) !== 0n && BigInt(b.executeAt) === 0n) {
      const secret = await secretFor((k) => equityKey.signMessage({ message: { raw: k } }), key);
      const revealAt = BigInt(b.windowStart) + offsetOf(secret, key, BigInt(b.windowStart), BigInt(b.windowEnd), HOUR);
      if ((await r.now()) < BigInt(b.windowEnd) - HOUR) at = revealAt; // still revealable: go to the reveal time
    }
    if (at !== 2n ** 64n - 1n && (await r.now()) < at) await r.warpTo(at);
    rows.push(...(await x.state.deskPass(`day ${(day - dayStart(BigInt(x.dep.genesis as number))) / DAY}`)));
    if (rows.some((w) => w.action === "rebalance_done")) break;
    // No beacon was committed for today before it began (this pass committed the next ones): today has no
    // rebalance time, so go to tomorrow, whose beacon now exists, instead of passing again on the same day.
    if (at === 2n ** 64n - 1n) await r.warpTo(day + DAY + 60n);
  }
  const sent = rows.filter((w) => w.status === "sent");
  // A weekend fork: names the desk could not fill at the guard's slippage (rebalance_partial) leave the book under
  // its band; the steps that depend on the full rebalance are then SKIPs with that reason (core.ts closedMarket).
  const partial = (await db().sql`select detail from desk_actions where lower(account) = ${t.account!.toLowerCase()} and action = 'rebalance_partial' order by id desc limit 1`) as unknown as { detail: { unfilled?: { token: string }[] } | null }[];
  const unfilled = (partial[0]?.detail?.unfilled ?? []).map((u) => r.who(u.token as Address));
  if (unfilled.length) x.state.weekendUnfilled = unfilled;
  // Cleared at the end of this area (the perps area sets its own hook and clears it).
  r.closedMarket = () => weekendBookReason(x);
  await r.check("equity desk bought real Stock Tokens on the real pools", async () => {
    const bought = new Set(sent.filter((w) => w.action === "buy").map((w) => w.asset));
    expect(bought.size >= 3, `bought ${bought.size} names: ${j(rows.filter((w) => w.action === "buy"))}`);
    return `${bought.size} names bought; rows: ${rows.length}`;
  }, "equity desk");
  await r.check("cash desk swept idle USDG into the real steakUSDG vault", async () => {
    expect(sent.some((w) => w.desk === "cash" && w.action === "deposit"), j(rows.filter((w) => w.desk === "cash")));
    const sh = await r.read<bigint>(steak, erc20Abi, "balanceOf", [t.account!]);
    return `treasury holds ${Number(sh) / 1e18} steakUSDG shares`;
  }, "cash desk");
  await r.check("weights inside the policy bands after the rebalance", async () => {
    const w = await weights();
    expect(w.cash >= 4000 && w.cash <= 7000 && w.equity >= 3000 && w.equity <= 6000, j(w));
    return `NAV $${Number(w.nav / 10n ** 16n) / 100}, cash ${w.cash / 100}%, equity ${w.equity / 100}%`;
  });
  // Review v2 V2-L15: treasury reads are default-deny. NAV and positions are chain-derived and public; the desk list
  // (last actions) needs the treasury's MCP token, read with it further down once the board has issued one.
  await r.check("API: nav and positions are public; the desk list needs the treasury's MCP token", async () => {
    const nav = await api(`/v1/treasury/${t.account}/nav`);
    const pos = await api(`/v1/treasury/${t.account}/positions`);
    const desks = await api(`/v1/treasury/${t.account}/desks`);
    expect(nav.status === 200 && pos.status === 200 && desks.status === 401, `${nav.status}/${pos.status}/${desks.status} ${j(nav.body).slice(0, 200)}`);
    return `nav ${j(nav.body).slice(0, 80)}…, ${(pos.body.positions ?? pos.body).length ?? "?"} positions; desks without a token: 401`;
  });

  // ---- guard rejections (simulated from the desk keys; nothing is sent)
  const T2 = x.state.t2 as Compiled | undefined;
  await r.reverts("guard: an order above the per-order cap (redeem $45k > $40k)", A.cashDesk, exec("cash", cashSleeve, wrap(steak, await sharesFor(45_000n), cashRun(1, steak, await sharesFor(45_000n), 0n)), [proofOf(usdg)]), "GuardRejected(4)");
  const meta = x.token("META");
  await r.reverts("guard: buying a Stock Token the policy does not allow (META)", A.equityDesk, exec("equity", equitySleeve, wrap(usdg, 100n * U, equityRun(0, meta, 100n * U, slip)), [[]]), "GuardRejected(2)");
  const offAt = (await r.now()) + 8n * DAY;
  await r.reverts("guard: off-hours (every held feed stale, simulated 8 days later) refuses a cash move", A.cashDesk, exec("cash", cashSleeve, wrap(steak, await sharesFor(500n), cashRun(1, steak, await sharesFor(500n), 0n)), [proofOf(usdg)]), "GuardRejected(8)", { blockOverrides: { time: offAt } });
  await r.reverts("an unregistered key cannot run a desk (rule 1: desk scope)", A.outsider, exec("cash", cashSleeve, wrap(steak, 1n, cashRun(1, steak, 1n, 0n)), []), "GuardRejected(1)");

  // ---- board approval ticket, with the model jury's verdict attached
  const appr = t.approvals!;
  const BA = abiOf("BoardApprovals");
  const shares25 = await sharesFor(25_000n);
  const big = wrap(steak, shares25, cashRun(1, steak, shares25, 0n));
  const bigCall = exec("cash", cashSleeve, big, [proofOf(usdg)]);
  await r.reverts("guard: a $25k redeem (above the $20k approval line) needs a board ticket", A.cashDesk, bigCall, "GuardRejected(11)");
  const opHash = await r.read<Hex>(t.account!, ACC, "opHashOf", [stringToHex("cash", { size: 32 }), cashSleeve, big]);
  let ticket: Hex | undefined;
  const ollama = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (!ollama) x.notes.push("Ollama was not running: the jury ran with the rule juror only (model jurors skipped).");
  await r.external(`model jury deliberates on the exception (${ollama ? "3 local Ollama models + rule juror" : "rule juror only"}) and the desk opens the ticket`, "cash desk + jury", async () => {
    const store = new PgJuryStore(db().db);
    const jury = new JuryService({ store, log: () => {} });
    const req = await exceptionFromChain(r.pub, { account: t.account!, desk: "cash", opHash, intent: { action: "redeem", asset: steak.toLowerCase(), amount: shares25.toString(), notionalUsd: (25_000n * E18).toString() }, guard: { code: 11, reason: "R9_APPROVAL" } });
    const filed = await jury.file(req, { pub: r.pub, wallet: r.wallet(A.cashDesk) as never, account: A.cashDesk, chain: r.c.chain });
    ticket = filed.ticket;
    const cid = await r.read<Hex>(appr, BA, "juryVerdictCidOf", [ticket]);
    expect(cid.toLowerCase() === filed.hash.toLowerCase(), "verdict hash not attached on-chain");
    const v = filed.bundle.verdict;
    const votes = filed.bundle.jurors.map((jj) => ("recommend" in jj ? `${jj.model}:${jj.recommend}` : `${jj.model}:abstain`)).join(", ");
    return { tx: filed.txHash, assertion: `ticket ${BigInt(ticket)}; verdict ${v.recommend} (${v.why}); rules ${filed.bundle.rules.recommend}; jurors ${votes || "none"}; bundle hash on-chain` };
  });
  if (ticket) {
    await r.reverts("only the board can approve a ticket", A.cashDesk, { address: appr, abi: BA, functionName: "approve", args: [ticket] }, "NotBoard");
    await r.send("board approves the ticket", A.deployer, { address: appr, abi: BA, functionName: "approve", args: [ticket] }, async () => {
      expect(await r.read<boolean>(appr, BA, "isValid", [ticket, opHash, t.account]), "ticket not valid");
      return "isValid(ticket, opHash, account) = true";
    });
    const before = await usdgOf(x, t.account!);
    await r.send("cash desk runs the $25k redeem with the approved ticket", A.cashDesk, exec("cash", cashSleeve, big, [proofOf(usdg)], ticket), async () => {
      const got = (await usdgOf(x, t.account!)) - before;
      expect(got > 24_900n * U, `received ${got}`);
      return `${Number(got) / 1e6} USDG redeemed from steakUSDG; ticket consumed`;
    });
    await r.reverts("the consumed ticket cannot be used again", A.cashDesk, exec("cash", cashSleeve, big, [proofOf(usdg)], ticket), "GuardRejected(11)");
  }
  // Over band (after the $25k redeem left idle USDG): the deepest-supply allowed name, $20k (equity ~45% -> ~65%).
  let bandToken = x.token("SPY");
  let best = 0n;
  for (const n of ["TSLA", "AAPL", "NVDA", "SPY"]) {
    const cap = await r.read<bigint>(equitySleeve, abiOf("EquitySleeve"), "floatCapRaw", [x.token(n), t1.policy.perNameFloatCapBps]);
    const q = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [x.token(n)]);
    const room = (cap * q.priceUsdPerToken) / E18;
    if (room > best) [best, bandToken] = [room, x.token(n)];
  }
  // The buy is sized from the live book so it always crosses the equity band's top (the rebalance above depends on
  // real pool depth: a name whose pool is off the oracle that day is skipped, leaving equity lower), and stays at or
  // under the $20k approval line so the band rule (6), not the ticket rule (9), is what refuses it.
  const snap = await r.read<{ nav: bigint; equityUsd: bigint }>(x.addr("policyGuard"), abiOf("PolicyGuard"), "snapshot", [t.account!]);
  const overUsd = (snap.nav * BigInt(t1.policy.equity.maxBps + 500)) / 10_000n - snap.equityUsd; // 1e18 USD
  const need = overUsd > 0n ? overUsd / 10n ** 12n : 0n;
  const bandBuy = need + 1_000n * U;
  if (bandBuy > 20_000n * U) {
    // Not reachable without a board ticket today (a name the rebalance skipped left equity low); rule 4 itself is
    // covered by the forge suite (PolicyGuardTest). Recorded, not faked.
    await r.check("guard: band breach not reachable under the approval line at this fork block", async () => `equity needs +$${need / U} to cross the top; skipped`);
  } else
  await r.reverts(`guard: a $${bandBuy / U} ${r.who(bandToken)} buy that takes equity above its band`, A.equityDesk, exec("equity", equitySleeve, wrap(usdg, bandBuy, equityRun(0, bandToken, bandBuy, slip)), [proofOf(bandToken)]), "GuardRejected(6)");

  // ---- period close: refused below the weekly-close tier, committed after the board stakes PLTH
  const pc = t.close!;
  const closeEnv = treasuryEnv({ TREASURY_PERIOD_CLOSE: pc, TREASURY_CLOSE_SKIP_RECONCILE: "1" });
  const tiered = await r.read<{ weeklyClose: boolean }>(x.addr("staking"), abiOf("PlinthStaking"), "tierOf", [A.deployer.address]);
  if (!tiered.weeklyClose) {
    await r.check("close service refuses a 1-day period while the board has no staking tier (TierTooLow)", async () => {
      const out = await runOnce("src/bin/treasury-close.ts", ["--once"], closeEnv);
      const sel = toFunctionSelector("TierTooLow(address)");
      expect((out.out.includes("TierTooLow") || out.out.includes(sel)) && (await r.read<bigint>(pc, PC, "closeCount")) === 0n, `exit ${out.code}: ${out.out.slice(-400)}`);
      return "no close committed; the service reports TierTooLow";
    }, "close service");
    await stake(x, A.deployer, 10_000n * E18, "board");
  }
  // steakUSDG accrues every second and the close commits an exact NAV: same-timestamp blocks around the commit,
  // as on Robinhood Chain (several blocks per second).
  await r.c.rpc("anvil_setBlockTimestampInterval", [0]);
  try {
    await r.external("close service commits the period with the on-chain NAV", "close service (controller)", async () => {
      const out = await runOnce("src/bin/treasury-close.ts", ["--once"], closeEnv);
      expect(out.out.includes('"status":"committed"'), `exit ${out.code}: ${out.out.slice(-600)}`);
      const c = await r.read<{ navUsd: bigint; periodEnd: bigint; bundleHash: Hex }>(pc, PC, "latest");
      const tx = (await db().sql`select tx_hash from closes where lower(period_close) = ${pc.toLowerCase()} and status = 'committed' order by id desc limit 1`.catch(() => [])) as unknown as { tx_hash: Hex }[];
      return { tx: tx[0]?.tx_hash, assertion: `period ending ${c.periodEnd}: NAV $${Number(c.navUsd / 10n ** 16n) / 100}, bundle ${c.bundleHash.slice(0, 10)}…` };
    });
  } finally {
    await r.c.rpc("anvil_removeBlockTimestampInterval", []).catch(() => r.c.rpc("anvil_setBlockTimestampInterval", [1]));
  }
  const closes = await r.read<bigint>(pc, PC, "closeCount");
  if (closes > 0n) {
    const c = await r.read<{ navUsd: bigint; bundleHash: Hex; periodEnd: bigint }>(pc, PC, "latest");
    await r.check("committed NAV equals the guard's NAV at that block (within steakUSDG accrual)", async () => {
      const w = await weights();
      const diff = w.nav > c.navUsd ? w.nav - c.navUsd : c.navUsd - w.nav;
      expect(diff * 10_000n <= w.nav, `${c.navUsd} vs ${w.nav}`);
      return `close NAV ${c.navUsd} vs now ${w.nav}`;
    });
    await r.check("platform fee paid to the FeeRouter in real USDG", async () => {
      const bal = await usdgOf(x, x.addr("feeRouter"));
      expect(bal > 0n, "FeeRouter holds no USDG");
      return `FeeRouter holds ${Number(bal) / 1e6} USDG of close fees`;
    });
    const out = mkdtempSync(join(tmpdir(), "plynth-fork-cfo-"));
    await r.check("CFO pack renders and matches the on-chain close", async () => {
      const run = await runOnce("scripts/cfo-pack.ts", ["--index", String(closes - 1n), "--from-block", String(x.dep.treasuryFactoryBlock ?? x.dep.deployBlock), "--out", out], treasuryEnv({ TREASURY_PERIOD_CLOSE: pc }));
      expect(run.code === 0, `exit ${run.code}: ${run.out.slice(-400)}`);
      const s = JSON.parse(readFileSync(join(out, "statement.json"), "utf8"));
      expect(s.statement.navUsd === c.navUsd.toString() && s.statement.bundleHash === c.bundleHash, "statement.json differs from the chain");
      const html = readFileSync(join(out, "statement.html"), "utf8");
      expect(!/<script|https?:\/\//i.test(html), "statement.html is not self-contained");
      return `statement.json NAV + bundle hash = on-chain; ${s.positions.length} positions; statement.html self-contained`;
    }, "cfo-pack");
    x.state.lastClose = { bundleHash: c.bundleHash, periodEnd: c.periodEnd };
    await r.check("API: the closes list without a token is refused (default-deny)", async () => {
      const l = await api(`/v1/treasury/${t.account}/closes`);
      expect(l.status === 401, `HTTP ${l.status} ${j(l.body).slice(0, 200)}`);
      return "HTTP 401";
    });
  }

  // ---- hourly receipts: post the finished hours, then prove one desk action against the on-chain root
  await r.check("warp past the receipts grace period", async () => {
    await r.warp(HOUR + 400n);
    return `chain time ${await r.now()}`;
  });
  const rec = x.addr("receipts");
  // Desk rows carry the DB (wall) clock, which a fork cannot warp: run the receipts service in-process with its
  // clock two hours ahead, so the hours that are over on chain time are over by both clocks.
  await r.external("receipts service posts the finished hours' roots (controller)", "receipts service (controller)", async () => {
    const out = await receiptsOnce({ chain: r.c.chain, pub: r.pub, wallet: r.wallet(A.controller) as never, controller: A.controller as unknown as PrivateKeyAccount, receipts: rec, store: new ReceiptStore(db().db), accounts: [t.account!], graceSeconds: 60, now: () => new Date(Date.now() + 2 * 3600_000) });
    const posted = out.filter((o) => o.status === "posted");
    expect(posted.length > 0 && out.every((o) => o.status === "posted"), JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return { tx: posted[0]!.txHash, assertion: `${posted.length} hour root(s) posted: ${posted.map((o) => `hour ${o.hour} (${o.leafCount} actions)`).join(", ")}` };
  });
  // ---- MCP: the board issues a token through the API; an agent reads the treasury over MCP HTTP
  const issuedAt = Math.floor(Date.now() / 1000);
  const mreq = { label: "fork agent", issuedAt, expiresAt: issuedAt + 7 * 86400 };
  const sig = await r.wallet(A.deployer).signMessage({ message: issueMessage({ chainId: FORK_CHAIN_ID, account: t.account!, ...mreq }) });
  let token: string | undefined;
  await r.check("board issues an MCP token through the API (signed request)", async () => {
    const res = await api(`/v1/treasury/${t.account}/mcp-tokens`, { method: "POST", body: JSON.stringify({ ...mreq, signature: sig }) });
    expect(res.status === 200 && typeof res.body.token === "string", `HTTP ${res.status} ${j(res.body)}`);
    token = res.body.token;
    return `token issued (jti ${res.body.id ?? res.body.jti})`;
  }, "board");
  const action = (await db().sql`select id, tx_hash from desk_actions where lower(account) = ${t.account!.toLowerCase()} and status = 'sent' order by id limit 1`) as unknown as { id: number }[];
  // A decision's receipt proof carries the decision row: read with the treasury's MCP token (audit L-14).
  const lastClose = x.state.lastClose as { bundleHash: Hex; periodEnd: bigint } | undefined;
  if (token) {
    await r.check("API with the MCP token: desks, closes list and CFO pack endpoint", async () => {
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const d = await api(`/v1/treasury/${t.account}/desks`, auth);
      expect(d.status === 200, `desks HTTP ${d.status} ${j(d.body).slice(0, 200)}`);
      if (!lastClose) return `desks 200 (${(d.body.desks ?? d.body).length ?? "?"}); no close yet`;
      const l = await api(`/v1/treasury/${t.account}/closes`, auth);
      expect(l.status === 200 && JSON.stringify(l.body).includes(lastClose.bundleHash.slice(2, 12)), `HTTP ${l.status} ${j(l.body).slice(0, 200)}`);
      const p = await api(`/v1/treasury/${t.account}/cfo-pack/${lastClose.periodEnd}`, auth);
      expect(p.status === 200, `cfo-pack HTTP ${p.status} ${j(p.body).slice(0, 200)}`);
      return "desks 200; closes list has the bundle; cfo-pack 200";
    });
  }
  if (action[0] && token) {
    await r.check("API proof of a desk action verifies against the posted root (Receipts.verify)", async () => {
      const p = await api(`/v1/treasury/${t.account}/actions/${action[0]!.id}/proof`, { headers: { authorization: `Bearer ${token}` } });
      expect(p.status === 200, `HTTP ${p.status} ${j(p.body)}`);
      const ok = await r.read<boolean>(rec, abiOf("Receipts"), "verify", [t.account, BigInt(p.body.hour), p.body.leaf, p.body.proof]);
      expect(ok, `Receipts.verify false for ${j(p.body).slice(0, 200)}`);
      return `hour ${p.body.hour}, leaf ${String(p.body.leaf).slice(0, 10)}…, ${p.body.proof.length}-node proof verifies on-chain`;
    });
  }

  if (token) {
    await r.check("MCP tools over HTTP: nav, positions, policy, close_latest, exceptions_request", async () => {
      const c = new Client({ name: "plynth-fork", version: "1.0.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORTS.mcp}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as Parameters<Client["connect"]>[0]);
      const data = (res: any) => JSON.parse(res.content[0].text);
      const nav = data(await c.callTool({ name: "nav", arguments: {} }));
      const pos = data(await c.callTool({ name: "positions", arguments: {} }));
      const pol = data(await c.callTool({ name: "policy", arguments: {} }));
      const cl = data(await c.callTool({ name: "close_latest", arguments: {} }));
      const ex = await c.callTool({ name: "exceptions_request", arguments: { action: "raise_cap", reason: "fork run: the agent asks the board to review the per-order cap" } });
      await c.close();
      expect(!!nav && !!pos && !!pol, "empty tool answers");
      return `nav ${j(nav).slice(0, 60)}…; policy v${pol.version ?? "?"}; close_latest ${cl ? "present" : "none"}; exceptions_request ${ex.isError ? "error" : "filed"}`;
    }, "MCP agent");
    await r.check("a forged MCP token is refused", async () => {
      const res = await fetch(`http://127.0.0.1:${PORTS.mcp}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token!.slice(0, -4)}AAAA`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(res.status === 401 || res.status === 403, `HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    });
  }

  // ---- drawdown: withdrawToBoard into PAUSED, then DERISK; the guard holds new risk; board withdrawals always work
  if (closes > 0n) {
    const start = await r.read<bigint>(pc, PC, "periodStartNav");
    const w0 = await weights();
    const ddBps = () => weights().then((w) => Number(((w.nav - start) * 10_000n) / start));
    const idle = await usdgOf(x, t.account!);
    const toPaused = (start * 500n) / 10_000n / 10n ** 12n; // ~5% of NAV in USDG
    const pull1 = toPaused < idle ? toPaused : idle;
    await r.send("board withdraws ~5% of NAV (withdrawToBoard is never gated)", A.deployer, { address: t.account!, abi: ACC, functionName: "withdrawToBoard", args: [usdg, pull1] }, async () => `drawdown ${(await ddBps()) / 100}% vs period start (PAUSED below -4%)`);
    const tsla = x.token("TSLA");
    await r.reverts("PAUSED: buying a Stock Token is refused", A.equityDesk, exec("equity", equitySleeve, wrap(usdg, 100n * U, equityRun(0, tsla, 100n * U, slip)), [proofOf(tsla)]), "GuardRejected(9)");
    await r.check("risk service reports the PAUSED drawdown state", async () => {
      const run = await runOnce("src/bin/treasury-risk.ts", [], treasuryEnv({ TREASURY_ACCOUNT: t.account!, RISK_ONCE: "1", TREASURY_POSITION_MIRROR: t.mirror }));
      expect(/PAUSED/i.test(run.out), `exit ${run.code}: ${run.out.slice(-500)}`);
      return run.out.split("\n").find((l) => /PAUSED/i.test(l))?.slice(0, 160) ?? "PAUSED";
    }, "risk service");
    // DERISK: redeem vault shares to idle USDG first, then withdraw to ~-9%.
    const redeem = await sharesFor(5_000n);
    await r.send("PAUSED: the cash desk moves $5k from steakUSDG back to USDG (cash -> cash)", A.cashDesk, exec("cash", cashSleeve, wrap(steak, redeem, cashRun(1, steak, redeem, 0n)), [proofOf(usdg)]));
    // DERISK: the board takes ~4.5% more, as vault shares (withdrawToBoard works for any token).
    const more = await sharesFor((start * 450n) / 10_000n / 10n ** 18n);
    await r.send("board withdraws ~4.5% more as steakUSDG shares (withdrawToBoard in PAUSED)", A.deployer, { address: t.account!, abi: ACC, functionName: "withdrawToBoard", args: [steak, more] }, async () => `drawdown ${(await ddBps()) / 100}% (DERISK below -8%)`);
    const dd = await ddBps();
    if (dd <= -800) {
      await r.reverts("DERISK: a cash -> vault deposit (cash weight not up) is refused", A.cashDesk, exec("cash", cashSleeve, wrap(usdg, 100n * U, cashRun(0, steak, 100n * U, 0n)), [proofOf(steak)]), "GuardRejected(10)");
      const bal = await r.read<bigint>(tsla, erc20Abi, "balanceOf", [t.account!]);
      if (bal > 0n) {
        // The sell, like the desk's own orders, stays inside the guard's slippage: halve it until the pool takes it.
        let part = bal / 4n;
        let fits = false;
        const sell = (a: bigint) => exec("equity", equitySleeve, wrap(tsla, a, equityRun(1, tsla, a, slip)), [proofOf(usdg)]);
        for (let k = 0; k < 4 && !fits; k++) {
          try {
            await r.pub.simulateContract({ account: A.equityDesk.address, ...sell(part) } as never);
            fits = true;
          } catch {
            part /= 2n;
          }
        }
        const step = "DERISK: selling a Stock Token toward cash is allowed";
        // A fork taken while the market is closed carries feeds frozen at the last close while the pools kept
        // trading: no sell is inside the guard's slippage of that stale oracle. That is the closed market working,
        // not a guard failure, so the step is skipped with the reason (a weekday fork runs it).
        const forkTs = (await r.pub.getBlock({ blockNumber: BigInt(readFileSync(PATHS.forkBlock, "utf8").trim()) })).timestamp;
        if (!fits && (await r.read<boolean>(x.addr("valuer"), abiOf("Valuer"), "isClosedAt", [forkTs]))) {
          r.skip(step, `the fork block (${new Date(Number(forkTs) * 1000).toISOString()}) is inside a market closure: feeds are frozen at the last close and the TSLA pool is more than ${slip} bps away even for 1/32 of the position`, "equity desk");
        } else {
          await r.send(step, A.equityDesk, sell(part), async () => `sold ${Number((part * 10_000n) / bal) / 100}% of the TSLA position`);
        }
      }
      const idle3 = await usdgOf(x, t.account!);
      await r.send("board withdraws in DERISK (never gated)", A.deployer, { address: t.account!, abi: ACC, functionName: "withdrawToBoard", args: [usdg, idle3 / 10n] });
    } else {
      await r.check("drawdown reached DERISK (-8%)", () => {
        throw new Error(`drawdown only ${dd / 100}%`);
      });
    }
    // Restore: the board sends the USDG back so later areas trade from a normal state.
    const back = w0.nav / 10n ** 12n - (await weights()).nav / 10n ** 12n;
    await r.send("board returns the withdrawn USDG to the treasury", A.deployer, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [t.account!, back + 1_000n * U] }, async () => `drawdown ${(await ddBps()) / 100}%`);
  }

  // ---- marketplace treasury: close it (board2 stakes for the weekly-close tier) -> author fee share
  const m = x.state.market as Record<string, any> | undefined;
  if (m) {
    await r.check("a treasury holding cash but no desks reports that cash in its NAV", async () => {
      const [nav] = await r.read<[bigint, boolean]>(m.account, ACC, "navUsd");
      expect(nav === 50_000n * E18, `navUsd ${nav} while it holds 50,000 USDG`);
      const [assets] = await r.read<[Address[], number[], number[]]>(m.account, ACC, "trackedAssets");
      expect(assets.length === 1 && getAddress(assets[0]!) === getAddress(x.addr("usdg")), `trackedAssets ${assets.join(",")}`);
      return "navUsd = $50,000; trackedAssets = [USDG] (loose cash)";
    });
    await r.send("second board registers a cash desk (its USDG moves from loose cash to the cash sleeve)", A.board2, { address: m.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("cash", { size: 32 }), A.trader2.address, [cashSleeve]] }, async () => {
      const [nav] = await r.read<[bigint, boolean]>(m.account, ACC, "navUsd");
      expect(nav >= 50_000n * E18, `navUsd ${nav}`);
      const [loose] = await r.read<[Address, bigint]>(m.account, ACC, "looseCash");
      expect(loose === zeroAddress, `looseCash ${loose}`);
      return `navUsd = $${Number(nav / 10n ** 16n) / 100}`;
    });
    await stake(x, A.board2, 10_000n * E18, "board2");
    const fr = x.addr("feeRouter");
    const owedBefore = await r.read<bigint>(fr, abiOf("FeeRouter"), "authorOwed", [A.staker.address]).catch(() => 0n);
    await r.c.rpc("anvil_setBlockTimestampInterval", [0]);
    try {
      await r.check("close service commits the marketplace treasury's period", async () => {
        const out = await runOnce("src/bin/treasury-close.ts", ["--once"], treasuryEnv({ TREASURY_PERIOD_CLOSE: m.close, TREASURY_CLOSE_SKIP_RECONCILE: "1" }));
        expect(out.out.includes('"status":"committed"'), `exit ${out.code}: ${out.out.slice(-600)}`);
        return "committed";
      }, "close service (controller)");
    } finally {
      await r.c.rpc("anvil_removeBlockTimestampInterval", []).catch(() => undefined);
    }
    const owed = await r.read<bigint>(fr, abiOf("FeeRouter"), "authorOwed", [A.staker.address]).catch(() => 0n);
    await r.check("FeeRouter set aside the template author's share of the close fee", async () => {
      expect(owed > owedBefore, `authorOwed ${owed}`);
      return `authorOwed(author) = ${Number(owed) / 1e6} USDG`;
    });
    const b0 = await usdgOf(x, A.staker.address);
    await r.send("template author claims the fee share", A.staker, { address: fr, abi: abiOf("FeeRouter"), functionName: "claimAuthor" }, async () => {
      const got = (await usdgOf(x, A.staker.address)) - b0;
      expect(got === owed && got > 0n, `got ${got}`);
      return `${Number(got) / 1e6} USDG to the author`;
    });
  }
  r.closedMarket = undefined;
}

/** Stakes PLTH for `who` (the deployer funds it), so its tier allows weekly closes. */
export async function stake(x: Ctx, who: Ctx["A"]["deployer"], amount: bigint, label: string) {
  const { r, A } = x;
  const plth = x.addr("plth");
  const st = x.addr("staking");
  const S = abiOf("PlinthStaking");
  if (who.address !== A.deployer.address) await r.send(`deployer sends ${label} ${amount / E18} PLTH`, A.deployer, { address: plth, abi: erc20Abi, functionName: "transfer", args: [who.address, amount] });
  await r.send(`${label} approves staking`, who, { address: plth, abi: erc20Abi, functionName: "approve", args: [st, amount] });
  await r.send(`${label} stakes ${amount / E18} PLTH`, who, { address: st, abi: S, functionName: "stake", args: [amount] }, async () => {
    const tier = await r.read<{ weeklyClose: boolean; maxDesks: number }>(st, S, "tierOf", [who.address]);
    expect(tier.weeklyClose, `tier ${j(tier)}`);
    return `tierOf(${label}): weeklyClose, maxDesks ${tier.maxDesks}`;
  });
}
