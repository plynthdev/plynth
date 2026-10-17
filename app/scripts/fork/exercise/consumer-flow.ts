// Timelocks (48h warp), round-up accrual from real USDG spends through the running indexer + keeper, Permit2
// top-ups, statement import through the API, withdrawals; then Crowd Buy on the real v4 pools and real feeds
// (keeper sweep, commit/reveal, execution, claims, deliveries, cancel, slippage) and Quiet delivery claimed
// through the running relayer.
import { announcementEvent, decodeAnnouncementLog, keyForHit, scan, signClaim, type StealthKeys } from "@plynth/sdk/stealth";
import { bytesToHex, encodeAbiParameters, getAddress, keccak256, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { roundupMessage } from "@/api/routes/roundups";
import { sha256Hex } from "@/keeper/sources/types";
import { offsetOf } from "@/keeper/jobs/beacon";
import { parseSecretKey, Sealer } from "@/keeper/seal";
import { FORK_CHAIN_ID, PORTS, secrets } from "../lib";
import { db } from "./services";
import { expect, j } from "./core";
import { api, balanceOf, DAY, erc20Abi, events, HOUR, U, usdgOf, type Ctx } from "./context";

/** CrowdBuy.beaconKey = keccak256(abi.encode(asset, uint64 windowStart)). */
const crowdKey = (asset: Address, start: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [asset, start]));
const routerAbi = parseAbi(["function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient) returns (uint256)", "function sell(address stockToken, uint256 rawIn, uint16 maxSlippageBps, address recipient) returns (uint256)"]);

// ---------------------------------------------------------------- timelocks

export async function timelocks(x: Ctx) {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const P = x.abi("ShieldedPool");
  const T = x.abi("ShieldedTrade");
  const caps = [x.addr("usdg"), x.addr("steakUsdg"), ...Object.values(x.dep.stocks).map((s) => getAddress(s.token))];
  await r.reverts("Hidden Vault cap cannot apply before its 48h timelock", A.deployer, { address: pool, abi: P, functionName: "applyCap", args: [x.addr("usdg")] }, "TooEarly");
  await r.reverts("park adapter cannot apply before its 48h timelock", A.deployer, { address: x.addr("shieldedTrade"), abi: T, functionName: "applyAdapter", args: [x.addr("steakUsdg")] }, "TooEarly");
  if (x.state.policy) await r.reverts("treasury policy v2 cannot activate before its 48h timelock", A.deployer, { address: x.state.policy, abi: x.abi("TreasuryPolicy"), functionName: "activate" }, "TimelockActive");
  await r.check("warp 48h (evm_increaseTime) past every timelock", async () => {
    const t0 = await r.now();
    await r.warp(48n * HOUR + 120n);
    const t1 = await r.now();
    return `chain time ${t0} -> ${t1}`;
  });
  for (const a of caps) {
    await r.send(`apply Hidden Vault cap for ${r.who(a)}`, A.deployer, { address: pool, abi: P, functionName: "applyCap", args: [a] }, async () => {
      const c = await r.read<bigint>(pool, P, "cap", [a]);
      expect(c > 0n, "cap still 0");
      return `cap(${r.who(a)}) = ${c}`;
    });
  }
  await r.send("apply the steakUSDG park adapter (real Morpho vault)", A.deployer, { address: x.addr("shieldedTrade"), abi: T, functionName: "applyAdapter", args: [x.addr("steakUsdg")] }, async () => {
    const ad = await r.read<Address>(x.addr("shieldedTrade"), T, "adapterOf", [x.addr("steakUsdg")]);
    expect(getAddress(ad) === x.addr("parkAdapter"), `adapterOf = ${ad}`);
    return "adapterOf(steakUSDG) = ERC4626Park";
  });
  if (x.state.policy) {
    await r.send("activate treasury policy v2 (T2: perps, basis band) after 48h", A.deployer, { address: x.state.policy, abi: x.abi("TreasuryPolicy"), functionName: "activate" }, async () => {
      const [, , v] = await r.read<[unknown, Hex, number]>(x.state.policy, x.abi("TreasuryPolicy"), "current");
      expect(v === 2, `version ${v}`);
      return "current() version = 2";
    });
  }
  // The equity desk commits tomorrow's beacon now, so its rebalance falls in the same day as the crowd window.
  if (x.state.deskPass) await x.state.deskPass("commit");
}

// ---------------------------------------------------------------- spends

/** (ceil(spend / roundTo) * roundTo - spend) * multiplier, USDG base units. */
export function roundUp(spend: bigint, roundTo: number, mult: number): bigint {
  const u = BigInt(roundTo) * U;
  const up = ((spend + u - 1n) / u) * u;
  return (up - spend) * BigInt(mult);
}

export async function spends(x: Ctx) {
  const { r, A } = x;
  const vault = x.addr("savingsVault");
  const usdg = x.addr("usdg");
  const V = x.abi("SavingsVault");
  const from = BigInt(x.dep.deployBlock); // the keeper may act as soon as settings allow it (e.g. the top-up)
  const plan: [user: keyof typeof A, wallet: keyof typeof A, spend: bigint, roundTo: number, mult: number][] = [
    ["open", "wOpen", 5_500_000n, 10, 1],
    ["quiet", "wQuiet", 3_200_000n, 5, 2],
    ["hidden", "wHidden", 7_250_000n, 1, 3],
    ["fourth", "wFourth", 1_000_000n, 10, 1],
    ["slipA", "wSlipA", 1_000_000n, 10, 3],
    ["slipB", "wSlipB", 1_000_000n, 10, 3],
    ["slipC", "wSlipC", 1_000_000n, 10, 3],
    ["saver", "wSaver", 1_000_000n, 10, 3],
  ];
  const sent: { user: keyof typeof A; tx: Hex; spend: bigint; want: bigint }[] = [];
  for (const [u, w, spend, roundTo, mult] of plan) {
    const want = u === "saver" ? 20n * U : roundUp(spend, roundTo, mult); // saver: 27 clipped to the 20 USDG weekly cap
    const rc = await r.send(`${w}: spend ${Number(spend) / 1e6} USDG at a merchant`, A[w], { address: usdg, abi: erc20Abi, functionName: "transfer", args: [A.merchant.address, spend] });
    if (rc) sent.push({ user: u, tx: rc.transactionHash, spend, want });
  }
  const second = await r.send("wSaver: second spend 2 USDG (weekly cap already used)", A.wSaver, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [A.merchant.address, 2_000_000n] });
  if (second) sent.push({ user: "saver", tx: second.transactionHash, spend: 2_000_000n, want: 0n });

  // The running indexer sees the transfers out of linked wallets; the running keeper accrues each once.
  for (const s of sent) {
    if (s.want === 0n) {
      // Audit M-7: a spend the vault would credit 0 for (weekly cap reached) is skipped by the keeper, not accrued:
      // no transaction, no gas. The row says why; no Accrued event exists for it.
      await r.external(`keeper skips ${r.who(A[s.user])}'s round-up of ${Number(s.spend) / 1e6} USDG (weekly cap reached: the vault would add 0)`, "keeper", async () => {
        const row = await r.until(`keeper_roundups row for ${s.tx}`, async () => {
          const rows = (await db().sql`select status, reason from keeper_roundups where chain_id = ${FORK_CHAIN_ID} and tx_hash = ${s.tx.toLowerCase()} and status = 'skipped'`) as { status: string; reason: string | null }[];
          return rows[0];
        }, 120_000);
        expect(/weekly cap/.test(row.reason ?? ""), `skip reason ${row.reason}`);
        const accrued = (await events(x, vault, "SavingsVault", "Accrued", from, { user: A[s.user].address })).some((e) => e.args.sourceTx === s.tx);
        expect(!accrued, "no Accrued event for the capped spend");
        return { tx: s.tx, assertion: `skipped (${row.reason}); no Accrued event` };
      });
      continue;
    }
    await r.external(`keeper accrues ${r.who(A[s.user])}'s round-up of ${Number(s.spend) / 1e6} USDG`, "keeper", async () => {
      const ev = await r.until(`Accrued for ${s.tx}`, async () => {
        const e = (await events(x, vault, "SavingsVault", "Accrued", from, { user: A[s.user].address })).find((e) => e.args.sourceTx === s.tx);
        return e;
      }, 120_000);
      expect(ev.args.added === s.want, `added ${ev.args.added}, want ${s.want}`);
      x.state[`accrual:${s.tx}`] = ev.args.logIndex;
      return { tx: ev.transactionHash, assertion: `Accrued(added = ${Number(ev.args.added) / 1e6} USDG) = round-up${s.user === "saver" ? " clipped to the weekly cap" : ""}` };
    });
  }
  const first = sent[0];
  if (first) {
    const logIndex = x.state[`accrual:${first.tx}`];
    await r.reverts("replaying an accrued spend reverts (keeper)", A.keeper, { address: vault, abi: V, functionName: "accrue", args: [A.open.address, first.tx, logIndex, first.spend] }, "AlreadyAccrued");
  }
  await r.reverts("only the keeper may accrue", A.open, { address: vault, abi: V, functionName: "accrue", args: [A.open.address, `0x${"ab".repeat(32)}`, 0, 1_000_000n] }, "NotKeeper");

  // Fixed top-up through the saver's Permit2 allowance, pulled by the keeper's topups job.
  await r.external("keeper pulls the 25 USDG fixed top-up through Permit2", "keeper", async () => {
    const e = await r.until("TopUpPulled(saver)", async () => (await events(x, vault, "SavingsVault", "TopUpPulled", from, { user: A.saver.address }))[0], 120_000);
    expect(e.args.amount === 25n * U, `amount ${e.args.amount}`);
    return { tx: e.transactionHash, assertion: "TopUpPulled(saver, 25 USDG)" };
  });
  await r.reverts("a second top-up inside 7 days reverts", A.keeper, { address: vault, abi: V, functionName: "pullFixedTopUp", args: [A.saver.address] }, "TopUpTooSoon");

  // Statement import (CSV) through the API: the keeper accrues the imported spend for the Open saver.
  const today = new Date(Number(await r.now()) * 1000).toISOString().slice(0, 10);
  const csv = `Date,Description,Amount\n${today},Coffee roasters,-12.30\n${today},Salary,2500.00\n`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const sig = await r.wallet(A.open).signMessage({ message: roundupMessage({ action: "import", user: A.open.address, chainId: FORK_CHAIN_ID, subject: sha256Hex(csv), issuedAt }) });
  const imported = await r.check("open: statement import (CSV) through the API", async () => {
    const res = await api("/v1/roundups/import", { method: "POST", body: JSON.stringify({ user: A.open.address, content: csv, format: "csv", issuedAt, signature: sig }) });
    expect(res.status === 200 && res.body.imported === 1, `answer ${res.status} ${j(res.body)}`);
    return `layout ${res.body.layout}, ${res.body.rows} rows, ${res.body.imported} spend imported, credits skipped`;
  }, "open");
  if (imported) {
    await r.external("keeper accrues the imported statement spend (12.30 -> 7.70 USDG)", "keeper", async () => {
      const e = await r.until("Accrued for the statement row", async () => (await events(x, vault, "SavingsVault", "Accrued", from, { user: A.open.address })).find((e) => e.args.spend === 12_300_000n), 120_000);
      expect(e.args.added === 7_700_000n, `added ${e.args.added}`);
      return { tx: e.transactionHash, assertion: "Accrued(spend 12.30, added 7.70)" };
    });
  }

  // Withdraw from available and then pending (the no-mix saver keeps pending).
  const [avail, pend] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [A.saver.address]);
  await r.check("saver balances after deposit, top-up and capped accrual", async () => {
    expect(avail === 105n * U && pend === 20n * U, `available ${avail}, pending ${pend}`);
    return "available 105 USDG, pending 20 USDG";
  });
  const before = await usdgOf(x, A.saver.address);
  await r.send("saver withdraws 115 USDG: 105 from available, 10 from pending", A.saver, { address: vault, abi: V, functionName: "withdraw", args: [115n * U, A.saver.address] }, async (rc) => {
    const e = (await events(x, vault, "SavingsVault", "Withdrawn", rc.blockNumber, { user: A.saver.address }))[0];
    expect(e?.args.fromAvailable === 105n * U && e?.args.fromPending === 10n * U, j(e?.args));
    expect((await usdgOf(x, A.saver.address)) - before === 115n * U, "USDG not received");
    return "Withdrawn(fromAvailable 105, fromPending 10), 115 USDG received";
  });
  await r.reverts("withdrawing more than available + pending reverts", A.saver, { address: vault, abi: V, functionName: "withdraw", args: [11n * U, A.saver.address] }, "InsufficientBalance");
  await r.send("saver unlinks the spending wallet", A.saver, { address: vault, abi: V, functionName: "unlinkSpendingWallet", args: [A.wSaver.address] }, async () => {
    const l = await r.read<Address>(vault, V, "linkedUser", [A.wSaver.address]);
    expect(BigInt(l) === 0n, "still linked");
    return "linkedUser(wSaver) = 0";
  });
}

// ---------------------------------------------------------------- crowd

export async function crowd(x: Ctx) {
  const { r, A } = x;
  const vault = x.addr("savingsVault");
  const crowd = x.addr("crowdBuy");
  const beacon = x.addr("jitterBeacon");
  const C = x.abi("CrowdBuy");
  const V = x.abi("SavingsVault");
  const B = x.abi("JitterBeacon");
  const [TSLA, AAPL, NVDA, MSFT] = ["TSLA", "AAPL", "NVDA", "MSFT"].map((s) => x.token(s)) as [Address, Address, Address, Address];
  const assets = [TSLA, AAPL, NVDA];
  const from = BigInt(x.dep.deployBlock);

  // Keeper sweep: every saver with pending joins (open, quiet, hidden, fourth -> 3 books; slip* -> MSFT).
  await r.external("keeper sweeps pending round-ups into the TSLA / AAPL / NVDA books (4 savers each)", "keeper", async () => {
    await r.until("4 accounts in each book", async () => {
      for (const a of assets) if ((await r.read<[bigint, { accounts: number }]>(crowd, C, "openBook", [a]))[1].accounts !== 4) return undefined;
      return true;
    }, 120_000);
    const e = (await events(x, crowd, "CrowdBuy", "Joined", from, { asset: TSLA }))[0];
    return { tx: e?.transactionHash, assertion: "openBook(TSLA/AAPL/NVDA).accounts = 4" };
  });
  await r.check("orders split by the mix weights (50/25/25, last entry takes the remainder)", async () => {
    const [, b] = await r.read<[bigint, { usdgTotal: bigint }]>(crowd, C, "openBook", [TSLA]);
    const id = (await r.read<[bigint]>(crowd, C, "openBook", [TSLA]))[0];
    const o = await Promise.all(assets.map((a) => r.read<bigint>(crowd, C, "orderOf", [a, id, A.open.address])));
    // Each sweep splits floor(amount x weight) per entry, the last one takes the remainder; one sweep here.
    const total = o[0]! + o[1]! + o[2]!;
    expect(total >= 4_500_000n && o[0] === total / 2n && o[1] === (total * 2500n) / 10_000n, `orders ${o.join("/")}`);
    return `open's orders ${o.map((v) => Number(v) / 1e6).join(" / ")} USDG, TSLA book total ${Number(b.usdgTotal) / 1e6}`;
  });
  await r.external("keeper sweeps the three slippage savers into the MSFT book", "keeper", async () => {
    await r.until("3 accounts in MSFT", async () => ((await r.read<[bigint, { accounts: number }]>(crowd, C, "openBook", [MSFT]))[1].accounts === 3 ? true : undefined), 120_000);
    return { assertion: "openBook(MSFT).accounts = 3" };
  });

  // Commit: the keeper commits the next windows' beacons for every asset with an open book.
  const genesis = await r.read<bigint>(crowd, C, "GENESIS");
  const now0 = await r.now();
  const wStart = genesis + ((now0 - genesis) / DAY + 1n) * DAY;
  x.state.crowdWindow = wStart;
  for (const a of [...assets, MSFT]) {
    await r.external(`keeper commits the ${r.who(a)} beacon for the next window`, "keeper", async () => {
      const key = crowdKey(a, wStart);
      const e = await r.until(`Committed ${r.who(a)}`, async () => (await events(x, beacon, "JitterBeacon", "Committed", from, { key }))[0], 120_000);
      return { tx: e.transactionHash, assertion: `Committed(key(${r.who(a)}, ${wStart}))` };
    });
  }
  // The current (uncommitted) window falls back to public execution from windowEnd - GRACE (audit L-1): if real time
  // already sits in that last hour, move to the committed next window so the timing checks below are deterministic.
  const grace = await r.read<bigint>(beacon, x.abi("JitterBeacon"), "GRACE");
  if ((await r.now()) >= wStart - grace) {
    await r.check("warp to the committed window (now is inside the current window's public fallback hour)", async () => {
      await r.warp(wStart + 1n - (await r.now()));
      return `chain time ${await r.now()}`;
    });
  }
  await r.reverts("execute before the window's beacon time reverts (keeper)", A.keeper, { address: crowd, abi: C, functionName: "execute", args: [TSLA] }, "TooEarly");
  await r.reverts("an outsider cannot execute a book (keeper-only until windowEnd - GRACE)", A.outsider, { address: crowd, abi: C, functionName: "execute", args: [TSLA] }, "NotKeeper");

  // Revoked user: buys refused, exits still work.
  const fourth = A.fourth;
  await r.send("attester revokes the fourth saver's attestation", A.attester, { address: x.addr("eligibilityRegistry"), abi: x.abi("EligibilityRegistry"), functionName: "revoke", args: [fourth.address] }, async () => {
    expect(!(await r.read<boolean>(x.addr("eligibilityRegistry"), x.abi("EligibilityRegistry"), "isEligible", [fourth.address])), "still eligible");
    return "isEligible(fourth) = false";
  });
  await r.reverts("revoked saver cannot set a new mix", fourth, { address: vault, abi: V, functionName: "setMix", args: [[{ stockToken: TSLA, weightBps: 10_000 }]] }, "NotEligible");
  for (const a of assets) {
    const id = (await r.read<[bigint]>(crowd, C, "openBook", [a]))[0];
    const order = await r.read<bigint>(crowd, C, "orderOf", [a, id, fourth.address]);
    await r.send(`revoked saver cancels the ${r.who(a)} order before execution (exit never gated)`, fourth, { address: crowd, abi: C, functionName: "cancel", args: [a, id] }, async () => {
      const [, b] = await r.read<[bigint, { accounts: number }]>(crowd, C, "openBook", [a]);
      expect(b.accounts === 3, `accounts ${b.accounts}`);
      return `order ${Number(order) / 1e6} USDG back to the vault, book accounts 3`;
    });
  }
  const [fa, fp] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [fourth.address]);
  const fBefore = await usdgOf(x, fourth.address);
  await r.send("revoked saver withdraws everything from the vault", fourth, { address: vault, abi: V, functionName: "withdraw", args: [fa + fp, fourth.address] }, async () => {
    expect((await usdgOf(x, fourth.address)) - fBefore === fa + fp, "not received");
    return `${Number(fa + fp) / 1e6} USDG received`;
  });

  // The keeper reveals each beacon only at the execution time it sets (an earlier reveal would publish the time),
  // so nothing on-chain says when a book runs. The harness, on the same machine, opens the keeper's sealed
  // secret (keeper_jobs.secret_enc, KEEPER_SECRET_KEY) to know when to move chain time.
  const sealer = await Sealer.create(parseSecretKey(secrets().keeperSecretKey));
  const keeperRevealAt = async (a: Address): Promise<bigint> => {
    const key = crowdKey(a, wStart);
    const row = (await db().sql`select secret_enc from keeper_jobs where kind = 'beacon' and job_key = ${key.toLowerCase()}`)[0] as { secret_enc: string } | undefined;
    if (!row) throw new Error(`no keeper beacon secret for ${r.who(a)}`);
    const secret = bytesToHex(await sealer.open(row.secret_enc, `beacon:${FORK_CHAIN_ID}:${key.toLowerCase()}`));
    return wStart + offsetOf(secret, key, wStart, wStart + DAY, HOUR);
  };
  const router = x.addr("stockRouter");
  const whale = A.deployer;

  // Slippage case, prepared before the window: a whale pushes the real MSFT pool up through the router (5% guard)
  // until a 1% buy fails, so the MSFT book's execution will hit the oracle slippage guard.
  let pushed = 0n;
  await r.send("whale approves the router", whale, { address: x.addr("usdg"), abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
  for (let i = 0; i < 12; i++) {
    try {
      await r.pub.simulateContract({ account: whale.address, address: router, abi: routerAbi, functionName: "buy", args: [MSFT, 100n * U, 100, whale.address] });
    } catch {
      break; // a 1% buy now fails: the pool is more than 1% above the oracle
    }
    const rc = await r.send(`whale buys 25k USDG of MSFT on the real pool (push ${i + 1})`, whale, { address: router, abi: routerAbi, functionName: "buy", args: [MSFT, 25_000n * U, 500, whale.address] });
    if (!rc) break;
    pushed += 25_000n * U;
  }

  // Into the window: no beacon is revealed yet; the equity desk runs (it reveals its own day beacon at its time).
  await r.check("warp to the crowd window start", async () => {
    await r.warpTo(wStart + 60n);
    return `chain time ${await r.now()} (window ${wStart})`;
  });
  if (x.state.deskPass) await x.state.deskPass("reveal");
  const execAt: Record<string, bigint> = {};
  for (const a of [...assets, MSFT]) {
    await r.check(`${r.who(a)}: the execution time is not public at the window start (beacon still at its fallback)`, async () => {
      const key = crowdKey(a, wStart);
      const b = await r.read<{ executeAt: bigint }>(beacon, x.abi("JitterBeacon"), "beacon", [key]);
      expect(BigInt(b.executeAt) === 0n, `revealed early: ${b.executeAt}`);
      execAt[a] = await keeperRevealAt(a);
      return `not revealed; the keeper will reveal at window + ${(Number(execAt[a]! - wStart) / 3600).toFixed(2)}h`;
    });
  }

  // Book ids now, before any execution opens the next book.
  x.state.books = {} as Record<string, bigint>;
  for (const a of [...assets, MSFT]) x.state.books[a] = (await r.read<[bigint]>(crowd, C, "openBook", [a]))[0];

  const revealed = async (a: Address) => {
    await r.external(`keeper reveals the ${r.who(a)} beacon at its execution time`, "keeper", async () => {
      const key = crowdKey(a, wStart);
      const e = await r.until(`Revealed ${r.who(a)}`, async () => (await events(x, beacon, "JitterBeacon", "Revealed", from, { key }))[0], 120_000);
      expect(BigInt(e.args.executeAt) === execAt[a], `executeAt ${e.args.executeAt} != ${execAt[a]}`);
      const blk = await r.pub.getBlock({ blockNumber: e.blockNumber });
      expect(blk.timestamp >= execAt[a]!, `revealed at ${blk.timestamp}, before its time ${execAt[a]}`);
      return { tx: e.transactionHash, assertion: `executeAt = window + ${(Number(execAt[a]! - wStart) / 3600).toFixed(2)}h, revealed at/after it` };
    });
  };

  const slippage = async () => {
    await r.check("the keeper's MSFT execution did not happen against the pushed pool (book stays open)", async () => {
      await Bun.sleep(8_000); // a few keeper passes
      const b = await r.read<{ executed: boolean }>(crowd, C, "book", [MSFT, x.state.books[MSFT]]);
      expect(!b.executed, "MSFT book executed against the pushed pool");
      return "book not executed";
    });
    await r.reverts("MSFT execution (as the keeper) reverts on the oracle slippage guard", A.keeper, { address: crowd, abi: C, functionName: "execute", args: [MSFT] }, "Slippage");
    for (const s of ["slipA", "slipB", "slipC"] as const) {
      const id = x.state.books[MSFT];
      await r.send(`${s} cancels the unexecuted MSFT order`, A[s], { address: crowd, abi: C, functionName: "cancel", args: [MSFT, id] }, async () => {
        expect((await r.read<bigint>(crowd, C, "orderOf", [MSFT, id, A[s].address])) === 0n, "order still there");
        const [av] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [A[s].address]);
        return `order cleared, vault available ${Number(av) / 1e6} USDG`;
      });
    }
    const held = await balanceOf(x, MSFT, whale.address);
    if (pushed > 0n && (await r.read<bigint>(MSFT, erc20Abi, "allowance", [whale.address, router])) < held) {
      // The setup approves the router of the default stack only; a beta deploy has its own router.
      await r.send("whale approves the router for its MSFT", whale, { address: MSFT, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
    }
    if (pushed > 0n) await r.send("whale sells the MSFT back (pool returns toward the oracle)", whale, { address: router, abi: routerAbi, functionName: "sell", args: [MSFT, held, 500, whale.address] });
  };

  // In beacon order: each TSLA/AAPL/NVDA book revealed and executed by the running keeper with a REAL v4 swap at
  // a REAL feed price; the MSFT book is the slippage case.
  const timeline = [...assets, MSFT].sort((a, b) => (execAt[a]! < execAt[b]! ? -1 : 1));
  const order = timeline.filter((a) => a !== MSFT);
  for (const a of timeline) {
    const at = execAt[a]!;
    const id = x.state.books[a];
    if ((await r.now()) < at - 1n) await r.reverts(`${r.who(a)}: execute one second before its beacon time reverts`, A.keeper, { address: crowd, abi: C, functionName: "execute", args: [a] }, "TooEarly", { blockOverrides: { time: at - 1n } });
    if ((await r.now()) < at) await r.warpTo(at + 1n);
    await revealed(a);
    if (a === MSFT) {
      await slippage();
      continue;
    }
    await r.external(`keeper executes the ${r.who(a)} book on the real v4 pool`, "keeper", async () => {
      const e = await r.until(`Executed ${r.who(a)}`, async () => (await events(x, crowd, "CrowdBuy", "Executed", from, { asset: a, bookId: id }))[0], 120_000);
      const q = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [a]);
      const usdIn = BigInt(e.args.usdgTotal) * 10n ** 12n;
      const fair = (BigInt(e.args.rawOut) * q.priceUsdPerToken) / 10n ** 18n;
      expect(fair * 10_000n >= usdIn * 9_900n, `filled ${fair} USD of tokens for ${usdIn} (worse than the 1% guard)`);
      return { tx: e.transactionHash, assertion: `${Number(e.args.usdgTotal) / 1e6} USDG -> ${Number(e.args.rawOut) / 1e18} ${r.who(a)} (round ${e.args.roundId}), within 1% of the feed` };
    });
  }
  await r.reverts("the next book cannot execute in the same window (no crowd yet)", A.outsider, { address: crowd, abi: C, functionName: "execute", args: [order[0]!] }, "CrowdTooSmall");

  // Settlement: Open claims, the keeper delivers Quiet and Hidden; allocations + dust == rawOut exactly.
  for (const a of order) {
    const id = x.state.books[a];
    if (id === undefined) continue;
    const alloc = await r.read<bigint>(crowd, C, "allocationOf", [a, id, A.open.address]);
    const b0 = await balanceOf(x, a, A.open.address);
    await r.send(`open claims the ${r.who(a)} allocation`, A.open, { address: crowd, abi: C, functionName: "claimOpen", args: [a, id] }, async () => {
      expect((await balanceOf(x, a, A.open.address)) - b0 === alloc && alloc > 0n, "wrong amount");
      return `${alloc} raw ${r.who(a)} received`;
    });
    await r.reverts(`open cannot claim ${r.who(a)} twice`, A.open, { address: crowd, abi: C, functionName: "claimOpen", args: [a, id] }, "AlreadySettled");
  }
  for (const a of order) {
    const id = x.state.books[a];
    if (id === undefined) continue;
    for (const u of ["quiet", "hidden"] as const) {
      await r.external(`keeper delivers ${u}'s ${r.who(a)} allocation (${u === "quiet" ? "to StealthClaims" : "as a pending shielded note"})`, "keeper", async () => {
        const e = await r.until(`Delivered ${u}`, async () => (await events(x, crowd, "CrowdBuy", "Delivered", from, { asset: a, bookId: id, user: A[u].address }))[0], 120_000);
        return { tx: e.transactionHash, assertion: `Delivered(${e.args.raw} raw)` };
      });
    }
    await r.check(`${r.who(a)} book: allocations + dust == rawOut exactly`, async () => {
      const b = await r.read<{ rawOut: bigint; accounts: number }>(crowd, C, "book", [a, id]);
      const s = await r.read<{ settledAccounts: number; settledRaw: bigint }>(crowd, C, "settlement", [a, id]);
      const d = (await events(x, crowd, "CrowdBuy", "DustSettled", from, { asset: a, bookId: id }))[0];
      expect(s.settledAccounts === b.accounts && d !== undefined, `settled ${s.settledAccounts}/${b.accounts}`);
      expect(s.settledRaw + BigInt(d!.args.raw) === b.rawOut, `${s.settledRaw} + ${d!.args.raw} != ${b.rawOut}`);
      return `${s.settledRaw} allocated + ${d!.args.raw} dust = ${b.rawOut} rawOut`;
    });
  }
  x.state.crowdOrder = order;
}

// ---------------------------------------------------------------- quiet

export async function quiet(x: Ctx) {
  const { r, A } = x;
  const keys = x.state.stealthKeys as StealthKeys | undefined;
  if (!keys) throw new Error("no stealth keys (savings setup failed)");
  const crowdAddr = x.addr("crowdBuy");
  const sc = x.addr("stealthClaims");
  const S = x.abi("StealthClaims");
  const from = BigInt(x.dep.deployBlock);
  // Parts are released one more crowd execution apart (SPLIT_PARTS = 2): the first executed book's two parts
  // are out after the three executions of this window.
  let hits: Awaited<ReturnType<typeof scan>> = [];
  const found = await r.check("keeper releases the Quiet saver's split stealth parts (announced on the real ERC-5564 announcer)", async () => {
    hits = await r.until("two announced stealth parts for the Quiet saver", async () => {
      const logs = await r.pub.getLogs({ address: x.addr("erc5564Announcer"), event: announcementEvent, args: { caller: crowdAddr }, fromBlock: from, toBlock: "latest" });
      const h = scan(logs.map((l) => decodeAnnouncementLog(l as never)), keys.viewingPrivateKey, keys.spendingPublicKey, { callers: [crowdAddr] });
      return h.length >= 2 ? h : undefined;
    }, 180_000);
    return `${hits.length} announcements match the Quiet saver's viewing key`;
  }, "keeper");
  if (!found) return;
  await r.check("SDK scan finds the Quiet saver's split stealth parts", async () => {
    const byToken = new Map<string, bigint>();
    for (const h of hits) byToken.set(h.token!, (byToken.get(h.token!) ?? 0n) + h.amount!);
    return `${hits.length} parts over ${[...byToken.entries()].map(([t, v]) => `${r.who(t as Address)} ${v} raw`).join(", ")}`;
  }, "quiet");
  const relayer = A.relayer.address;
  for (const [i, h] of hits.entries()) {
    const to = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    r.names.set(to.toLowerCase(), `fresh address ${i + 1}`);
    const nonce = await r.read<bigint>(sc, S, "nonces", [h.stealthAddress]);
    const signed = await signClaim(keyForHit(h, keys), FORK_CHAIN_ID, sc, { token: h.token!, to, raw: h.amount!, nonce, deadline: (await r.now()) + 3600n });
    const body = { token: signed.message.token, stealth: signed.message.stealth, to, raw: signed.message.raw.toString(), deadline: signed.message.deadline.toString(), sig: signed.sig };
    await r.external(`relayer claims stealth part ${i + 1} gaslessly to a fresh address`, "relayer", async () => {
      const res = await api("/claim", { method: "POST", port: PORTS.relayer, body: JSON.stringify(body) });
      expect(res.status === 200 && res.body.txHash, `relayer ${res.status} ${j(res.body)}`);
      const rc = await r.pub.waitForTransactionReceipt({ hash: res.body.txHash });
      expect(getAddress(rc.from) === relayer, "not paid by the relayer");
      expect((await balanceOf(x, h.token!, to)) === h.amount!, "fresh address did not receive the part");
      expect((await r.pub.getBalance({ address: h.stealthAddress })) === 0n, "stealth address holds gas");
      return { tx: res.body.txHash, assertion: `fresh address holds ${h.amount} raw ${r.who(h.token!)}; relayer paid gas; stealth address never funded` };
    });
    await r.reverts(`replaying part ${i + 1}'s claim signature reverts`, A.outsider, { address: sc, abi: S, functionName: "claim", args: [body.token, body.stealth, to, BigInt(body.raw), BigInt(body.deadline), body.sig] }, "BadSignature");
    await r.check(`relayer refuses the replayed claim ${i + 1}`, async () => {
      const res = await api("/claim", { method: "POST", port: PORTS.relayer, body: JSON.stringify(body) });
      expect(res.status >= 400, `relayer accepted a replay: ${res.status} ${j(res.body)}`);
      return `HTTP ${res.status}: ${res.body.error}`;
    });
  }
}
