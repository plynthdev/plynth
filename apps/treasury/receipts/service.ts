// The receipts service (todo 30). Once an hour is over (plus a grace period for late inserts), it builds the
// Merkle tree over that hour's desk_actions rows for each treasury, stores it (treasury_receipts) and posts the
// root with the controller key: Receipts.post(account, hour, root, leafCount). Hours without desk actions are
// not posted (nothing to prove). A root already on-chain is never re-posted; if it differs from the stored one
// the row is marked failed so a human looks at it.
import { BaseError, ContractFunctionRevertedError, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { receiptsAbi } from "./abi";
import type { ReceiptStore } from "./store";
import { HOUR, leafOfRow, merkleRoot } from "./tree";

export type ReceiptsContext = {
  chain: Chain;
  pub: PublicClient;
  wallet: WalletClient;
  controller: PrivateKeyAccount;
  receipts: Address;
  store: ReceiptStore;
  accounts: Address[];
  /** Seconds after an hour ends before it is closed (rows are stamped by the DB clock). Default 300. */
  graceSeconds?: number;
  now?: () => Date;
  say?: (m: string) => void;
};

export type ReceiptOutcome = { account: Address; hour: bigint; root: Hex; leafCount: number; status: "posted" | "failed"; txHash?: Hex; error?: string };

/** Builds and stores the tree of one hour (idempotent: an hour already stored is returned as is). */
export async function buildHour(store: ReceiptStore, chainId: number, account: Address, hour: bigint) {
  const existing = await store.get(chainId, account, hour);
  if (existing) return existing;
  const rows = await store.actionsInHour(chainId, account, hour);
  const leaves = rows.map(leafOfRow);
  return store.insertBuilt({ chainId, account, hour, root: merkleRoot(leaves), leafCount: rows.length, actionIds: rows.map((r) => r.id) });
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export async function receiptsOnce(ctx: ReceiptsContext): Promise<ReceiptOutcome[]> {
  const say = ctx.say ?? (() => {});
  const chainId = ctx.chain.id;
  const grace = BigInt(ctx.graceSeconds ?? 300);
  const wall = BigInt(Math.floor((ctx.now?.() ?? new Date()).getTime() / 1000));
  const chainTs = (await ctx.pub.getBlock({ blockTag: "latest" })).timestamp;
  // Only hours that are over by both clocks (the contract checks chain time, the rows carry DB time).
  const cutoff = (wall < chainTs ? wall : chainTs) - grace;
  const beforeHour = cutoff / BigInt(HOUR);
  const out: ReceiptOutcome[] = [];

  for (const account of ctx.accounts) {
    const last = await ctx.store.lastHour(chainId, account);
    for (const hour of await ctx.store.hoursWithActions(chainId, account, last ?? -1n, beforeHour)) {
      const r = await buildHour(ctx.store, chainId, account, hour);
      say(`${account} hour ${hour}: ${r.leafCount} actions, root ${r.root}`);
    }
    for (const r of await ctx.store.unposted(chainId, account)) {
      const base = { account, hour: r.hour, root: r.root as Hex, leafCount: r.leafCount };
      try {
        const onchain = await ctx.pub.readContract({ address: ctx.receipts, abi: receiptsAbi, functionName: "receipt", args: [account, r.hour] });
        if (onchain.postedAt !== 0n) {
          if (onchain.root.toLowerCase() === r.root.toLowerCase() && onchain.leafCount === r.leafCount) {
            await ctx.store.markPosted(r.id, r.txHash, r.blockNumber);
            out.push({ ...base, status: "posted" });
          } else {
            const error = `on-chain root ${onchain.root} (${onchain.leafCount}) differs from stored ${r.root} (${r.leafCount})`;
            await ctx.store.markFailed(r.id, error);
            out.push({ ...base, status: "failed", error });
            say(`${account} hour ${r.hour}: ${error}`);
          }
          continue;
        }
        const { request } = await ctx.pub.simulateContract({
          address: ctx.receipts,
          abi: receiptsAbi,
          functionName: "post",
          args: [account, r.hour, r.root as Hex, r.leafCount],
          account: ctx.controller,
          chain: ctx.chain,
        });
        const txHash = await ctx.wallet.writeContract({ ...request, account: ctx.controller, chain: ctx.chain });
        const rc = await ctx.pub.waitForTransactionReceipt({ hash: txHash });
        if (rc.status !== "success") throw new Error(`post reverted in ${txHash}`);
        await ctx.store.markPosted(r.id, txHash, rc.blockNumber);
        out.push({ ...base, status: "posted", txHash });
        say(`${account} hour ${r.hour}: posted ${r.root} in ${txHash}`);
      } catch (e) {
        const error = revertName(e);
        await ctx.store.markFailed(r.id, error);
        out.push({ ...base, status: "failed", error });
        say(`${account} hour ${r.hour}: post failed: ${error}`);
      }
    }
  }
  return out;
}
