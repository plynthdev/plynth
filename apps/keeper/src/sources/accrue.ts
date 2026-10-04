// One vault.accrue for one spend, shared by every source. Pre-simulated as the keeper: AlreadyAccrued (the
// vault's replay guard) means some earlier pass already did it, so it is done, not failed.
import { decodeEventLog, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { vaultAbi } from "../abi";
import { simulate, type Ctx } from "../context";

export type AccrueOutcome =
  | { status: "done"; added?: bigint; tx?: Hex; reason?: string }
  | { status: "failed"; reason: string };

/** `beforeSend` runs after a clean simulation, right before broadcasting (e.g. to record "pending"). */
export async function accrueSpend(ctx: Ctx, user: Address, sourceTx: Hex, logIndex: number, units: bigint, beforeSend?: () => Promise<void>): Promise<AccrueOutcome> {
  const args = [getAddress(user), sourceTx, logIndex, units] as const;
  const sim = await simulate(ctx, ctx.dep.vault, vaultAbi, "accrue", args);
  if (!sim.ok) {
    if (sim.errorName === "AlreadyAccrued") return { status: "done", reason: "already accrued" };
    return { status: "failed", reason: sim.errorName };
  }
  await beforeSend?.();
  const r = await ctx.sender.sendCall(ctx.dep.vault, vaultAbi, "accrue", args, "accrue");
  return { status: "done", added: addedFromReceipt(r, ctx.dep.vault), tx: r.transactionHash };
}

/** The `added` amount from the vault's Accrued event in a receipt. */
export function addedFromReceipt(r: TransactionReceipt, vault: string): bigint | undefined {
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Accrued") return (ev.args as { added: bigint }).added;
    } catch {
      // another vault event
    }
  }
  return undefined;
}

