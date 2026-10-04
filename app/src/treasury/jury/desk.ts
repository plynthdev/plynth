// Wiring for the desk runner: when an operation's simulation fails on rule 9 (needs the board), read the
// book and policy from the chain, ask the jury, and open the board ticket with the verdict attached.
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { periodCloseAbi } from "@/abi/treasury-close";
import { accountAbi, guardAbi, policyAbi } from "@/abi/treasury-desks";
import type { Rejection } from "@/treasury/desks/errors";
import { deskIdBytes, type DeskContext, type Op } from "@/treasury/desks/runner";
import { juryAccountAbi } from "@/abi/treasury-jury";
import type { JuryService } from "./service";
import type { JuryStore } from "./store";
import type { ExceptionRequest } from "./types";

export const R9_APPROVAL = 11;
export const DEDUPE_MS = 24 * 3600 * 1000; // BoardApprovals.TTL

/** The ExceptionRequest for an operation on `account`, read from the chain at the latest block. */
export async function exceptionFromChain(
  pub: PublicClient,
  a: { account: Address; desk: string; opHash: Hex; intent: ExceptionRequest["intent"]; guard: Rejection },
): Promise<ExceptionRequest> {
  const [guard, policyAddr, approvals, pc, block, chainId] = await Promise.all([
    pub.readContract({ address: a.account, abi: accountAbi, functionName: "guard" }),
    pub.readContract({ address: a.account, abi: accountAbi, functionName: "policy" }),
    pub.readContract({ address: a.account, abi: juryAccountAbi, functionName: "approvals" }),
    pub.readContract({ address: a.account, abi: juryAccountAbi, functionName: "periodClose" }),
    pub.getBlock({ blockTag: "latest" }),
    pub.getChainId(),
  ]);
  const [snap, cur, dayUsed, startNav] = await Promise.all([
    pub.readContract({ address: guard as Address, abi: guardAbi, functionName: "snapshot", args: [a.account] }),
    pub.readContract({ address: policyAddr as Address, abi: policyAbi, functionName: "current" }),
    pub.readContract({ address: guard as Address, abi: guardAbi, functionName: "dayTotal", args: [a.account] }),
    pc === zeroAddress ? Promise.resolve(0n) : pub.readContract({ address: pc, abi: periodCloseAbi, functionName: "periodStartNav" }) as Promise<bigint>,
  ]);
  const [p, hash, version] = cur;
  return {
    chainId,
    account: a.account.toLowerCase(),
    approvals: (approvals as string).toLowerCase(),
    desk: a.desk,
    opHash: a.opHash,
    intent: a.intent,
    policy: {
      hash,
      version: Number(version),
      cash: { minBps: p.cash.minBps, maxBps: p.cash.maxBps },
      equity: { minBps: p.equity.minBps, maxBps: p.equity.maxBps },
      perOrderCapUsd: p.perOrderCapUsd.toString(),
      perDayCapUsd: p.perDayCapUsd.toString(),
      approvalAboveUsd: p.approvalAboveUsd.toString(),
      noNewRiskOffHours: p.noNewRiskOffHours,
      pauseNewRiskAtDrawdownBps: p.pauseNewRiskAtDrawdownBps,
      deriskAtDrawdownBps: p.deriskAtDrawdownBps,
    },
    weights: { navUsd: snap.nav.toString(), cashUsd: snap.cashUsd.toString(), equityUsd: snap.equityUsd.toString() },
    guard: { code: a.guard.code, reason: a.guard.reason },
    market: { timestamp: Number(block.timestamp), equityHold: snap.equityHold, dayUsedUsd: (dayUsed as bigint).toString(), periodStartNavUsd: (startNav as bigint).toString() },
  };
}

/** DeskContext.onException handler: files rule-9 rejections with the jury, at most once per opHash per TTL. */
export function juryExceptionHandler(jury: JuryService, store: JuryStore) {
  return async (ctx: DeskContext, op: Op, rejection: Rejection) => {
    if (rejection.code !== R9_APPROVAL) return;
    const deskId = op.desk === "cash" ? ctx.cfg.cashDeskId : ctx.cfg.equityDeskId;
    const opHash = (await ctx.pub.readContract({ address: ctx.cfg.account, abi: juryAccountAbi, functionName: "opHashOf", args: [deskIdBytes(deskId), op.adapter, op.data] })) as Hex;
    if (await store.requestedSince(opHash, new Date(Date.now() - DEDUPE_MS))) return;
    const req = await exceptionFromChain(ctx.pub, {
      account: ctx.cfg.account,
      desk: op.desk,
      opHash,
      intent: { action: op.action, asset: op.asset.toLowerCase(), amount: op.amount.toString(), notionalUsd: op.usd.toString() },
      guard: rejection,
    });
    const d = op.desk === "cash" ? ctx.cash : ctx.equity;
    await jury.file(req, { pub: ctx.pub, wallet: d.wallet, account: d.account, chain: ctx.chain });
  };
}
