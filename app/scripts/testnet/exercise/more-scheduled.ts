// Scheduled steps of the complete testnet run: the liquidation, the insurance LP's withdraw, the
// keeper's FeeRouter push and the stakers' claim, and E1 (a failed Quiet deliver followed by an open claim).
import { generateKeys, KEY_DERIVATION_MESSAGE, metaAddress, registerTx } from "@plynth/sdk/stealth";
import { getAddress, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { abiOf, expect, j } from "../../fork/exercise/core";
import { erc20Abi } from "./areas";
import { chainNow, dur, events, HOUR, timers, U, type TCtx } from "./ctx";
import { failingDeliverPass, planKey, planRow, startKeeper, stopKeeper, type Plan } from "./e1";
import type { Outcome, Scheduled } from "./state";

type Handler = (x: TCtx, item: Scheduled) => Promise<Outcome>;
const registryAbi = parseAbi(["function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)"]);
const creditedEvent = parseAbiItem("event Credited(address indexed token, address indexed stealth, uint256 raw)");

const perpLiquidation: Handler = async (x, item) => {
  const { r, A } = x;
  const m = getAddress(item.args!.market as string);
  const trader = getAddress(item.args!.trader as string);
  const PM = abiOf("PerpMarket");
  const p = await r.read<{ size: bigint }>(m, PM, "position", [trader]);
  if (p.size > 0n && !(await r.read<boolean>(m, PM, "isLiquidatable", [trader]))) return { status: "later", dueAt: (await chainNow(x)) + 600, detail: "still above maintenance" };
  if (p.size > 0n) {
    const l0 = await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.open.address]);
    await r.send("a third party (the Open saver) liquidates the borrow-eaten mAAPL long and earns the fee", A.open, { address: m, abi: PM, functionName: "liquidate", args: [trader] }, async (rc) => {
      const e = (await events(x, m, "PerpMarket", "Liquidated", rc.blockNumber))[0];
      expect(!!e, "no Liquidated event");
      const got = await r.until("the liquidator's fee", async () => {
        const d = (await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.open.address])) - l0;
        return d > 0n ? d : undefined;
      }, 30_000, 2000).catch(() => 0n);
      const after = await r.read<{ size: bigint }>(m, PM, "position", [trader]);
      expect(after.size === 0n, "position still open");
      return `position gone; liquidator earned ${Number(got) / 1e6} mUSDG`;
    });
  }
  const params = (x.data.perpParams as string[]).map(BigInt);
  if ((await r.read<bigint>(m, PM, "borrowBpsPerHour")) !== params[3]) {
    await r.send("market owner restores the mAAPL borrow fee", A.deployer, { address: m, abi: PM, functionName: "setParams", args: params }, async () => `borrowBpsPerHour = ${await r.read<bigint>(m, PM, "borrowBpsPerHour")}`);
  }
  return { status: "done" };
};

const insuranceWithdraw: Handler = async (x) => {
  const { r, A } = x;
  const ins = x.addr("insurancePool");
  const IP = abiOf("ExceptionInsurancePool");
  const [, value, readyAt] = await r.read<[bigint, bigint, bigint]>(ins, IP, "pendingOf", [A.deployer.address]);
  const now = await chainNow(x);
  if (now < Number(readyAt)) return { status: "later", dueAt: Number(readyAt) + 30, detail: "not ready yet" };
  const b0 = await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.deployer.address]);
  await r.send(`LP withdraws its pending insurance value after the ${dur((await timers(x)).insuranceDelay)} delay`, A.deployer, { address: ins, abi: IP, functionName: "withdraw" }, async () => {
    const got = await r.until("the withdrawn value", async () => {
      const d = (await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.deployer.address])) - b0;
      return d > 0n ? d : undefined;
    }, 30_000, 2000);
    expect(got <= value && got * 1000n >= value * 999n, `got ${got}, pending value ${value}`);
    return `${Number(got) / 1e6} mUSDG out (pending value ${Number(value) / 1e6})`;
  });
  await r.reverts("nothing pending any more", A.deployer, { address: ins, abi: IP, functionName: "withdraw" }, "ZeroAmount");
  return { status: "done" };
};

const feePush: Handler = async (x, item) => {
  const { r, A } = x;
  const fr = x.addr("feeRouter");
  const FR = abiOf("FeeRouter");
  const from = BigInt(item.args!.from as string);
  const pushed = (await events(x, fr, "FeeRouter", "Pushed", from)).find((e) => BigInt(e.args.fees) > 0n);
  const now = await chainNow(x);
  if (!pushed) {
    const lastPush = Number(await r.read<bigint>(fr, FR, "lastPush"));
    const obsAt = Number(await r.read<bigint>(fr, FR, "obsAt"));
    if (now < item.dueAt + 3 * HOUR) return { status: "later", dueAt: now + 600, detail: `no push yet (lastPush ${lastPush ? new Date(lastPush * 1000).toISOString() : "never"}, observation ${obsAt ? new Date(obsAt * 1000).toISOString() : "none"})` };
    return { status: "failed", detail: "the running keeper did not push the FeeRouter within 3 h" };
  }
  const a = pushed.args as { fees: bigint; toInsurance: bigint; usdgToStakers: bigint; usdgSpent: bigint; plthBought: bigint };
  await r.external("keeper pushes the FeeRouter: PLTH buyback against its >= 10 min old observation, split to stakers and the insurance pool", "keeper", async () => {
    expect(a.toInsurance > 0n || a.usdgToStakers > 0n || a.plthBought > 0n, j(a));
    const ins = (await events(x, x.addr("insurancePool"), "ExceptionInsurancePool", "FeesDeposited", pushed.blockNumber)).find((e) => e.transactionHash === pushed.transactionHash);
    return { tx: pushed.transactionHash, assertion: `fees ${Number(a.fees) / 1e6} mUSDG: insurance +${Number(a.toInsurance) / 1e6}${ins ? " (FeesDeposited)" : ""}, stakers +${Number(a.usdgToStakers) / 1e6} mUSDG, ${Number(a.usdgSpent) / 1e6} mUSDG bought ${Number(a.plthBought) / 1e18} PLTH` };
  });
  const lastPush = await r.read<bigint>(fr, FR, "lastPush");
  if (BigInt(now) < lastPush + 3600n) await r.reverts("a second push inside the hour reverts (even for the keeper)", A.keeper, { address: fr, abi: FR, functionName: "push", args: [0n] }, "TooSoon");
  // Staking rewards land in the current hourly bucket and become claimable once it rolls over.
  const bucketEnd = (Math.floor(Number((await r.pub.getBlock({ blockNumber: pushed.blockNumber })).timestamp) / HOUR) + 1) * HOUR;
  x.schedule({ id: "staking-claim", handler: "staking-claim", area: "token", title: "stakers claim the pushed rewards once the hourly bucket rolls over", dueAt: bucketEnd + 60 });
  return { status: "done", detail: `pushed in ${pushed.transactionHash}` };
};

const stakingClaim: Handler = async (x) => {
  const { r, A } = x;
  const st = x.addr("staking");
  const S = abiOf("PlinthStaking");
  const e = await r.read<[bigint, bigint]>(st, S, "earned", [A.deployer.address]);
  if (e[0] === 0n && e[1] === 0n) return { status: "later", dueAt: (await chainNow(x)) + 900, detail: "nothing earned yet" };
  const usdg = x.addr("usdg");
  const plth = x.addr("plth");
  const u0 = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.deployer.address]);
  const p0 = await r.read<bigint>(plth, erc20Abi, "balanceOf", [A.deployer.address]);
  await r.send("board (a staker) claims its share of the pushed fees", A.deployer, { address: st, abi: S, functionName: "claim" }, async () => {
    const du = (await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.deployer.address])) - u0;
    const dp = (await r.read<bigint>(plth, erc20Abi, "balanceOf", [A.deployer.address])) - p0;
    expect(du > 0n || dp > 0n, "no rewards received");
    return `${Number(du) / 1e6} mUSDG + ${Number(dp) / 1e18} PLTH (earned() said ${Number(e[0]) / 1e6} / ${Number(e[1]) / 1e18})`;
  });
  return { status: "done" };
};

const e1Replay: Handler = async (x, item) => {
  const { r, A } = x;
  const crowd = x.addr("crowdBuy");
  const C = x.abi("CrowdBuy");
  const V = x.abi("SavingsVault");
  const vault = x.addr("savingsVault");
  const sc = x.addr("stealthClaims");
  const asset = getAddress(item.args!.asset as string);
  const bookId = BigInt(item.args!.bookId as string);
  const u = A.open;
  const key = planKey(asset, bookId, u.address);
  const cur = await r.read<{ roundTo: number; multiplier: number; weeklyCap: bigint; fixedTopUp: bigint; mode: number }>(vault, V, "settingsOf", [u.address]);
  const settings0 = { roundTo: cur.roundTo, multiplier: cur.multiplier, weeklyCap: cur.weeklyCap, fixedTopUp: cur.fixedTopUp, mode: cur.mode };
  const book = await r.read<{ executed: boolean }>(crowd, C, "book", [asset, bookId]);
  expect(book.executed, "book not executed");
  if (await r.read<boolean>(crowd, C, "settled", [asset, bookId, u.address])) return { status: "failed", detail: "the open saver's allocation is already settled: nothing to replay" };
  const alloc = await r.read<bigint>(crowd, C, "allocationOf", [asset, bookId, u.address]);
  expect(alloc > 0n, "no allocation");

  x.notes.push("E1 replay (quiet area): the running keeper was stopped for a few minutes; one keeper pass ran in the exercise process with the keeper's key and code, its Sender given a too-low gas estimate for the open saver's crowd.deliver only, so that deliver mined and reverted (out of gas) after the plan and the signed transaction were stored. The saver then claimed openly and the restarted keeper service (with the delivery-proof fix) had to skip the plan.");
  await r.check("E1 replay: the running keeper is stopped (one in-process keeper pass replaces it)", async () => {
    const pid = await stopKeeper();
    return pid ? `keeper pid ${pid} stopped` : "keeper was not running";
  }, "operator");
  let restarted = false;
  try {
    const meta = await r.read<Hex>(x.addr("erc6538Registry"), registryAbi, "stealthMetaAddressOf", [u.address, 1n]);
    if (meta.length !== 2 + 132) {
      const keys = generateKeys(await r.wallet(u).signMessage({ message: KEY_DERIVATION_MESSAGE }));
      const tx = registerTx(metaAddress(keys), x.addr("erc6538Registry"));
      await r.sendRaw("E1 replay: open saver registers a stealth meta-address on the real ERC-6538 registry", u, { to: tx.to, data: tx.data });
    }
    await r.send("E1 replay: open saver switches to Quiet mode (its executed mSPY allocation is still unsettled)", u, { address: vault, abi: V, functionName: "setSettings", args: [{ ...settings0, mode: 1 }] }, async () => {
      const s = await r.until("mode 1", async () => ((await r.read<{ mode: number }>(vault, V, "settingsOf", [u.address])).mode === 1 ? true : undefined), 30_000, 2000);
      return `settingsOf(open).mode = 1 (${s})`;
    });
    const pooled0 = await r.read<bigint>(sc, x.abi("StealthClaims"), "pooled", [asset]);
    const fromBlock = await r.pub.getBlockNumber();
    let plan: Plan | undefined;
    let deliverHash: Hex | undefined;
    await r.external("E1 replay: one keeper pass (keeper key + keeper code) plans the Quiet delivery, then its deliver fails on chain (gas limit too low: out of gas)", "keeper (in-process)", async () => {
      const out = await failingDeliverPass(x, { asset, bookId, user: u.address });
      const row = await planRow(key);
      expect(!!row, `no quiet-plan row (pass error: ${out.error ?? "none"}, notes ${j(out.res?.notes ?? [])})`);
      plan = row!.payload as Plan;
      expect(row!.status === "planned", `plan status ${row!.status}`);
      deliverHash = plan.deliverTx?.hash;
      expect(!!deliverHash, "no deliver transaction stored with the plan");
      const rc = await r.pub.waitForTransactionReceipt({ hash: deliverHash!, timeout: 120_000 }).catch(() => undefined);
      expect(!rc || rc.status === "reverted", `the deliver ${deliverHash} succeeded: nothing failed`);
      const parts = plan.parts.length;
      return { tx: rc ? deliverHash : undefined, assertion: `plan 'planned' with ${parts} stealth part(s) and deliver ${deliverHash!.slice(0, 12)}… ${rc ? `reverted on chain (gas limit ${rc.gasUsed === undefined ? "?" : `${out.limit}, used ${rc.gasUsed}`})` : "never mined"}; keeper notes: ${(out.res?.notes ?? []).filter((n) => n.includes(u.address)).join("; ") || out.error || "none"}` };
    });
    await r.check("E1 replay: the failed deliver settled nothing and pooled nothing", async () => {
      expect(!(await r.read<boolean>(crowd, C, "settled", [asset, bookId, u.address])), "settled after a failed deliver");
      const pooled = await r.read<bigint>(sc, x.abi("StealthClaims"), "pooled", [asset]);
      expect(pooled === pooled0, `pooled ${pooled0} -> ${pooled}`);
      return `settled(open) false; StealthClaims.pooled(mSPY) still ${pooled}`;
    });
    const b0 = await r.read<bigint>(asset, erc20Abi, "balanceOf", [u.address]);
    await r.send("E1 replay: the saver claims its allocation openly (the ungated exit)", u, { address: crowd, abi: C, functionName: "claimOpen", args: [asset, bookId] }, async () => {
      const got = await r.until("the claimed balance", async () => {
        const d = (await r.read<bigint>(asset, erc20Abi, "balanceOf", [u.address])) - b0;
        return d === alloc ? d : undefined;
      }, 30_000, 2000);
      return `${got} raw mSPY received (= allocationOf)`;
    });
    await r.check("E1 replay: the keeper service starts again with the fixed code", async () => `pid ${await startKeeper()}`, "operator");
    restarted = true;
    await r.check("E1 replay: the keeper's next pass marks the plan skipped ('claimed openly') and releases nothing", async () => {
      const row = await r.until("plan skipped", async () => {
        const w = await planRow(key);
        return w && w.status !== "planned" ? w : undefined;
      }, 240_000, 5000);
      expect(row.status === "skipped", `plan status ${row.status}`);
      const reason = String((row.payload as { reason?: string }).reason ?? "");
      expect(/claimed openly/.test(reason), `reason ${reason}`);
      return `quiet-plan ${row.status}: ${reason}`;
    }, "keeper");
    // Two more keeper passes, then: none of the plan's stealth addresses was ever credited.
    await Bun.sleep(70_000);
    await r.check("E1 replay: no stealth credit for the claimed allocation (no Credited to any planned stealth address, none holds mSPY)", async () => {
      const stealths = (plan?.parts ?? []).map((p) => getAddress(p.stealth));
      expect(stealths.length > 0, "no planned parts to check");
      const logs = await r.pub.getLogs({ address: sc, event: creditedEvent, args: { token: asset }, fromBlock, toBlock: "latest" });
      const hit = logs.filter((l) => stealths.includes(getAddress(l.args.stealth!)));
      expect(hit.length === 0, `credited: ${hit.map((l) => l.transactionHash).join(", ")}`);
      for (const s of stealths) expect((await r.read<bigint>(asset, erc20Abi, "balanceOf", [s])) === 0n, `${s} holds mSPY`);
      const row = await planRow(key);
      return `${stealths.length} planned stealth address(es): 0 Credited logs since the plan, 0 balance; plan still ${row?.status}; ${logs.length} other mSPY credit(s) in the same blocks`;
    }, "keeper");
  } finally {
    if (!restarted) await startKeeper().catch((e) => x.notes.push(`E1 replay: keeper restart failed: ${(e as Error).message}`));
  }
  await r.send("E1 replay: the open saver switches back to Open mode", u, { address: vault, abi: V, functionName: "setSettings", args: [{ ...settings0, mode: 0 }] });
  return { status: "done", detail: `plan ${key} skipped after the open claim` };
};

export const MORE_HANDLERS: Record<string, Handler> = {
  "perp-liquidation": perpLiquidation,
  "insurance-withdraw": insuranceWithdraw,
  "fee-push": feePush,
  "staking-claim": stakingClaim,
  "e1-replay": e1Replay,
};

export { U };
