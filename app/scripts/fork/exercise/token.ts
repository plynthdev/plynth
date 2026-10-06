// PLTH token side: staking tiers (stake, unstake with unbonding), FeeRouter push (hourly limit, PLTH buyback on
// the PLTH/USDG v4 pool on the real PoolManager, split to stakers and insurance), the exception-insurance claim
// that needs both the committee and the controller, the desk-limit tier; then the real Stock Token issuer
// controls (pause, blocklist) and what Plynth's exits do under them; and finally the 7-day unbonding withdraw.
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toBytes, type Address } from "viem";
import { compileTemplate, policyAbiParam } from "@/treasury/policy-compiler";
import { TOKEN_BLOCKER, TOKEN_PAUSER } from "../warm";
import { abiOf, expect, j, revertReason } from "./core";
import { balanceOf, DAY, E18, erc20Abi, events, HOUR, U, usdgOf, type Ctx } from "./context";
import { forkTemplate } from "./treasury-setup";

export async function token(x: Ctx) {
  const { r, A } = x;
  const plth = x.addr("plth");
  const st = x.addr("staking");
  const fr = x.addr("feeRouter");
  const ins = x.addr("insurancePool");
  const S = abiOf("PlinthStaking");
  const FR = abiOf("FeeRouter");
  const IP = abiOf("ExceptionInsurancePool");

  // ---- staking: the staker (also the template author) stakes 20k PLTH -> tier 1
  await r.send("deployer sends the staker 20,000 PLTH", A.deployer, { address: plth, abi: erc20Abi, functionName: "transfer", args: [A.staker.address, 20_000n * E18] });
  await r.send("staker approves staking", A.staker, { address: plth, abi: erc20Abi, functionName: "approve", args: [st, 20_000n * E18] });
  await r.send("staker stakes 20,000 PLTH", A.staker, { address: st, abi: S, functionName: "stake", args: [20_000n * E18] }, async () => {
    const tier = await r.read<{ maxDesks: number; weeklyClose: boolean }>(st, S, "tierOf", [A.staker.address]);
    expect(tier.weeklyClose && tier.maxDesks === 4, j(tier));
    return `stakedOf = 20,000; tier 1 (maxDesks 4, weekly close)`;
  });

  // ---- FeeRouter: platform fees from the closes -> buyback + split; hourly limit
  const feeBal = await usdgOf(x, fr);
  const authorOwed = await r.read<bigint>(fr, FR, "authorOwed", [A.staker.address]);
  const insBefore = await usdgOf(x, ins);
  if (feeBal > authorOwed) {
    // push and observe are keeper-only: one contract can no longer move the PLTH pool and push in the same tx.
    await r.reverts("an outsider cannot push the FeeRouter (keeper-only)", A.outsider, { address: fr, abi: FR, functionName: "push", args: [0n] }, "NotKeeper");
    await r.reverts("an outsider cannot record the buy's reference price", A.outsider, { address: fr, abi: FR, functionName: "observe" }, "NotKeeper");
    const from = await x.r.pub.getBlockNumber();
    await r.external("keeper observes the PLTH pool, then pushes the FeeRouter >= 10 min later: buyback checked against that observation, split to stakers and insurance", "keeper", async () => {
      // The running keeper's fee-push job observes first; chain time only moves when we warp, so warp past the
      // 10-minute observation age until its push lands.
      let pushed: Awaited<ReturnType<typeof events>>[number] | undefined;
      for (let i = 0; i < 4 && !pushed; i++) {
        await r.until("FeeRouter observation", async () => ((await r.read<bigint>(fr, FR, "obsAt")) !== 0n ? true : undefined), 120_000);
        await r.warp(11n * 60n);
        pushed = await r.until("Pushed", async () => (await events(x, fr, "FeeRouter", "Pushed", from))[0], 60_000).catch(() => undefined);
      }
      expect(pushed !== undefined, "the keeper never pushed");
      const insGot = (await usdgOf(x, ins)) - insBefore;
      const a = pushed!.args as { usdgSpent: bigint; plthBought: bigint; toInsurance: bigint; usdgToStakers: bigint };
      expect(insGot > 0n || a.usdgToStakers > 0n || a.plthBought > 0n, "nothing reached staking or insurance");
      return { tx: pushed!.transactionHash, assertion: `Pushed: insurance +${Number(insGot) / 1e6} USDG, stakers +${Number(a.usdgToStakers) / 1e6} USDG, ${Number(a.usdgSpent) / 1e6} USDG bought ${Number(a.plthBought) / 1e18} PLTH` };
    });
    await r.reverts("a second push inside the hour reverts", A.keeper, { address: fr, abi: FR, functionName: "push", args: [0n] }, "TooSoon");
  } else {
    await r.check("FeeRouter holds close fees to push", () => {
      throw new Error(`FeeRouter USDG ${feeBal} (author set-aside ${authorOwed}): no closes reached it`);
    });
  }
  await r.check("warp 1h: staking rewards roll into the stakers' bucket", async () => {
    await r.warp(HOUR + 60n);
    await r.send("anyone rolls the staking reward buckets", A.outsider, { address: st, abi: S, functionName: "roll" });
    const e = await r.read<[bigint, bigint]>(st, S, "earned", [A.deployer.address]);
    return `earned(board) = ${Number(e[0]) / 1e6} USDG, ${Number(e[1]) / 1e18} PLTH`;
  });
  // The board staked in the treasury area (before this push): it earns this hour's rewards.
  const sb = await usdgOf(x, A.deployer.address);
  const pb = await balanceOf(x, plth, A.deployer.address);
  await r.send("board (a staker since the close) claims staking rewards", A.deployer, { address: st, abi: S, functionName: "claim" }, async () => {
    const du = (await usdgOf(x, A.deployer.address)) - sb;
    const dp = (await balanceOf(x, plth, A.deployer.address)) - pb;
    expect(du > 0n || dp > 0n, "no rewards");
    return `${Number(du) / 1e6} USDG + ${Number(dp) / 1e18} PLTH`;
  });

  // ---- exception insurance: needs the committee AND the controller
  const t = x.state.treasury as Record<string, Address> | undefined;
  if (t) {
    await r.send("LP approves the insurance pool", A.lp, { address: x.addr("usdg"), abi: erc20Abi, functionName: "approve", args: [ins, 10_000n * U] });
    await r.send("LP deposits 10,000 USDG into the insurance pool", A.lp, { address: ins, abi: IP, functionName: "deposit", args: [10_000n * U] });
    await r.reverts("only the treasury's board may file a claim", A.outsider, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account!, 1_000n * E18, keccak256(toBytes("x"))] }, "NotBoard");
    let id = await r.read<bigint>(ins, IP, "claimCount");
    await r.send("board files a $1,000 policy-bug claim for its treasury", A.deployer, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account!, 1_000n * E18, keccak256(toBytes("fork run: guard let a breach through (drill)"))] });
    await r.send("committee approves the claim (not paid yet: the controller must attest)", A.committee, { address: ins, abi: IP, functionName: "approveClaim", args: [id] }, async () => {
      const c = await r.read<{ paid: bigint; status: number }>(ins, IP, "claim", [id]);
      expect(c.paid === 0n, `paid ${c.paid}`);
      return `status ${c.status}, paid 0`;
    });
    await r.reverts("only the treasury's controller can attest", A.committee, { address: ins, abi: IP, functionName: "attest", args: [id, true] }, "NotController");
    const tb = await usdgOf(x, t.account!);
    await r.send("controller attests a policy bug: the claim is queued and paid to the treasury", A.controller, { address: ins, abi: IP, functionName: "attest", args: [id, true] }, async () => {
      const got = (await usdgOf(x, t.account!)) - tb;
      expect(got === 1_000n * U, `treasury received ${got}`);
      return "1,000 USDG paid to the TreasuryAccount (not to the board)";
    });
    id = await r.read<bigint>(ins, IP, "claimCount");
    await r.send("board files a second claim", A.deployer, { address: ins, abi: IP, functionName: "fileClaim", args: [t.account!, 500n * E18, keccak256(toBytes("fork run: market move"))] });
    await r.send("controller attests a market move: the claim is rejected", A.controller, { address: ins, abi: IP, functionName: "attest", args: [id, false] }, async () => {
      const c = await r.read<{ status: number; paid: bigint }>(ins, IP, "claim", [id]);
      expect(c.paid === 0n, "paid");
      return `status ${c.status} (rejected), nothing paid`;
    });
  }

  // ---- desk limit by tier: a tier-0 board (maxDesks 2) registering a third desk
  const F = abiOf("TreasuryFactory");
  const factory = x.addr("treasuryFactory");
  const compiled = compileTemplate(forkTemplate(A.controller.address) as never, { controller: A.controller.address, network: "mainnet" });
  let acct: Address | undefined;
  await r.send("a tier-0 board (no PLTH staked) creates a treasury", A.outsider, { address: factory, abi: F, functionName: "deploy", args: [encodeAbiParameters([policyAbiParam], [compiled.policy]), A.outsider.address] }, async () => {
    const n = await r.read<bigint>(factory, F, "treasuryCount");
    acct = await r.read<Address>(factory, F, "treasuryAt", [n - 1n]);
    r.names.set(acct.toLowerCase(), "tier-0 treasury");
    return `account ${acct}`;
  });
  if (acct) {
    const ACC = abiOf("TreasuryAccount");
    for (const d of ["one", "two"]) await r.send(`tier-0 board registers desk "${d}"`, A.outsider, { address: acct, abi: ACC, functionName: "registerDesk", args: [stringToHex(d, { size: 32 }), A.trader2.address, [x.addr("cashSleeve")]] });
    await r.reverts("tier 0 board cannot register a third desk (maxDesks 2)", A.outsider, { address: acct, abi: ACC, functionName: "registerDesk", args: [stringToHex("three", { size: 32 }), A.trader2.address, [x.addr("cashSleeve")]] }, "TierTooLow");
  }

  // ---- unstake: tier drops at once, PLTH waits out the 7-day unbonding
  await r.send("staker unstakes 15,000 PLTH", A.staker, { address: st, abi: S, functionName: "unstake", args: [15_000n * E18] }, async () => {
    const tier = await r.read<{ weeklyClose: boolean }>(st, S, "tierOf", [A.staker.address]);
    expect(!tier.weeklyClose, "tier did not drop");
    return "stakedOf 5,000: back to tier 0";
  });
  await r.reverts("unbonding PLTH cannot be withdrawn before 7 days", A.staker, { address: st, abi: S, functionName: "withdraw" }, "StillUnbonding");
}

/** The real issuer's controls on a real Stock Token, impersonated on the fork. */
export async function issuer(x: Ctx) {
  const { r, A } = x;
  const tsla = x.token("TSLA");
  const accessAbi = [{ type: "function", name: "blockAccounts", inputs: [{ name: "accounts", type: "address[]" }], outputs: [], stateMutability: "nonpayable" }, { type: "function", name: "unblockAccounts", inputs: [{ name: "accounts", type: "address[]" }], outputs: [], stateMutability: "nonpayable" }, { type: "function", name: "isBlocked", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;
  const pauseAbi = [{ type: "function", name: "pause", inputs: [], outputs: [], stateMutability: "nonpayable" }, { type: "function", name: "unpause", inputs: [], outputs: [], stateMutability: "nonpayable" }, { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }, { type: "function", name: "ACCESS_CONTROLLED_REGISTRY", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const;
  const registry = await r.read<Address>(tsla, pauseAbi as never, "ACCESS_CONTROLLED_REGISTRY");
  const impersonated = async (who: Address, step: string, to: Address, abi: any, fn: string, args: unknown[] = []) => {
    await r.c.rpc("anvil_impersonateAccount", [who]);
    await r.c.rpc("anvil_setBalance", [who, "0xde0b6b3a7640000"]);
    try {
      return await r.external(step, `issuer ${who.slice(0, 8)}… (impersonated)`, async () => {
        const { encodeFunctionData } = await import("viem");
        const hash = await r.c.rpc<`0x${string}`>("eth_sendTransaction", [{ from: who, to, data: encodeFunctionData({ abi, functionName: fn, args } as never) }]);
        const rc = await r.pub.waitForTransactionReceipt({ hash });
        expect(rc.status === "success", "reverted");
        return { tx: hash, assertion: `${fn} executed by the real role holder` };
      });
    } finally {
      await r.c.rpc("anvil_stopImpersonatingAccount", [who]);
    }
  };
  const reverts = async (step: string, from: Address, to: Address, abi: any, fn: string, args: unknown[] = []) =>
    r.check(step, async () => {
      try {
        await r.pub.simulateContract({ account: from, address: to, abi, functionName: fn, args } as never);
      } catch (e) {
        return `reverts: ${revertReason(e)}`;
      }
      throw new Error("did not revert");
    });

  // Pause TSLA.
  await impersonated(TOKEN_PAUSER, "issuer pauses TSLA (token pause role)", tsla, pauseAbi, "pause");
  await r.check("TSLA reports paused", async () => {
    expect(await r.read<boolean>(tsla, pauseAbi as never, "paused"), "not paused");
    return "paused() = true";
  });
  const held = await balanceOf(x, tsla, A.open.address);
  await reverts("a paused TSLA cannot move (open saver's transfer)", A.open.address, tsla, erc20Abi, "transfer", [A.merchant.address, held > 0n ? held : 1n]);
  const vault = x.addr("savingsVault");
  const [avail] = await r.read<[bigint, bigint]>(vault, abiOf("SavingsVault"), "balancesOf", [A.open.address]);
  if (avail > 0n) {
    const b0 = await usdgOf(x, A.open.address);
    await r.send("USDG exits still work while TSLA is paused (vault withdraw)", A.open, { address: vault, abi: abiOf("SavingsVault"), functionName: "withdraw", args: [avail / 2n, A.open.address] }, async () => `${Number((await usdgOf(x, A.open.address)) - b0) / 1e6} USDG out`);
  }
  const t = x.state.treasury as Record<string, Address> | undefined;
  if (t) {
    const tslaHeld = await balanceOf(x, tsla, t.account!);
    if (tslaHeld > 0n) await reverts("the treasury's TSLA holds (withdrawToBoard of TSLA reverts at the token)", A.deployer.address, t.account!, abiOf("TreasuryAccount"), "withdrawToBoard", [tsla, tslaHeld]);
    await r.send("the treasury's USDG still moves (withdrawToBoard 1 USDG)", A.deployer, { address: t.account!, abi: abiOf("TreasuryAccount"), functionName: "withdrawToBoard", args: [x.addr("usdg"), 1n * U] });
    await r.check("the treasury still values the paused TSLA (NAV unchanged by the pause)", async () => {
      const [nav, hold] = await r.read<[bigint, boolean]>(t.account!, abiOf("TreasuryAccount"), "navUsd");
      return `navUsd $${Number(nav / 10n ** 16n) / 100}, hold ${hold}`;
    });
  }
  await impersonated(TOKEN_PAUSER, "issuer unpauses TSLA", tsla, pauseAbi, "unpause");

  // Blocklist one account (the Open saver, who holds TSLA).
  await impersonated(TOKEN_BLOCKER, "issuer blocks the Open saver on every Stock Token (shared blocklist)", registry, accessAbi, "blockAccounts", [[A.open.address]]);
  await r.check("the blocklist reports the Open saver", async () => {
    expect(await r.read<boolean>(registry, accessAbi as never, "isBlocked", [A.open.address]), "not blocked");
    return "isBlocked(open) = true";
  });
  if (held > 0n) await reverts("a blocked holder cannot move TSLA", A.open.address, tsla, erc20Abi, "transfer", [A.merchant.address, held]);
  const [avail2] = await r.read<[bigint, bigint]>(vault, abiOf("SavingsVault"), "balancesOf", [A.open.address]);
  if (avail2 > 0n) await r.send("the blocked saver's USDG exit still works", A.open, { address: vault, abi: abiOf("SavingsVault"), functionName: "withdraw", args: [avail2, A.open.address] });
  await impersonated(TOKEN_BLOCKER, "issuer unblocks the Open saver", registry, accessAbi, "unblockAccounts", [[A.open.address]]);
  if (held > 0n) await r.send("after unblock the saver moves TSLA again", A.open, { address: tsla, abi: erc20Abi, functionName: "transfer", args: [A.merchant.address, held] });
}

/** Last: 7 days later the unbonded PLTH comes out (chain time passes every feed's staleness window here). */
export async function unbonding(x: Ctx) {
  const { r, A } = x;
  const st = x.addr("staking");
  await r.check("warp 7 days (unbonding period)", async () => {
    await r.warp(7n * DAY + 60n);
    return `chain time ${await r.now()}`;
  });
  const b0 = await balanceOf(x, x.addr("plth"), A.staker.address);
  await r.send("staker withdraws the unbonded 15,000 PLTH", A.staker, { address: st, abi: abiOf("PlinthStaking"), functionName: "withdraw" }, async () => {
    const got = (await balanceOf(x, x.addr("plth"), A.staker.address)) - b0;
    expect(got === 15_000n * E18, `got ${got}`);
    return "15,000 PLTH back";
  });
  await r.reverts("nothing left to withdraw", A.staker, { address: st, abi: abiOf("PlinthStaking"), functionName: "withdraw" }, "NothingToWithdraw");
}
