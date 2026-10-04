// Receipt lookups for the API: the root of one hour and the inclusion proof of one desk action. Every answer is
// recomputed from the desk_actions rows and checked against the stored root and, when the Receipts contract is
// known, against the root on-chain (Receipts.verify), so a rewritten row shows up as `verified: false`.
import type { Address, Hex, PublicClient } from "viem";
import { receiptsAbi } from "@/abi/treasury-receipts";
import type { ReceiptStore } from "./store";
import { hourOf, leafOfRow, merkleProof, merkleRoot, rowHash, rowJson, verifyProof } from "./tree";

export class ReceiptNotFound extends Error {}

async function onchainReceipt(pub: PublicClient, receipts: Address | undefined, account: Address, hour: bigint) {
  if (!receipts) return null;
  const r = await pub.readContract({ address: receipts, abi: receiptsAbi, functionName: "receipt", args: [account, hour] });
  return r.postedAt === 0n ? null : { root: r.root, leafCount: r.leafCount, postedAt: Number(r.postedAt) };
}

export async function receiptRoot(d: { pub: PublicClient; store: ReceiptStore; chainId: number; receipts?: Address | undefined }, account: Address, hour: bigint) {
  const row = await d.store.get(d.chainId, account, hour);
  if (!row) throw new ReceiptNotFound(`no receipt for hour ${hour}`);
  const rows = await d.store.actionsByIds(row.actionIds);
  const recomputed = merkleRoot(rows.map(leafOfRow));
  const onchain = await onchainReceipt(d.pub, d.receipts, account, hour);
  return {
    account,
    hour: hour.toString(),
    hourStart: new Date(Number(hour) * 3600 * 1000).toISOString(),
    root: row.root,
    leafCount: row.leafCount,
    actionIds: row.actionIds,
    status: row.status,
    txHash: row.txHash,
    onchain,
    matchesRows: rows.length === row.leafCount && recomputed.toLowerCase() === row.root.toLowerCase(),
    matchesChain: onchain !== null && onchain.root.toLowerCase() === row.root.toLowerCase() && onchain.leafCount === row.leafCount,
  };
}

export async function receiptProof(d: { pub: PublicClient; store: ReceiptStore; chainId: number; receipts?: Address | undefined }, account: Address, actionId: number) {
  const action = await d.store.action(d.chainId, actionId);
  if (!action || action.account !== account.toLowerCase()) throw new ReceiptNotFound(`no desk action #${actionId} for ${account}`);
  const hour = hourOf(action.createdAt);
  const row = await d.store.get(d.chainId, account, hour);
  if (!row) throw new ReceiptNotFound(`hour ${hour} of desk action #${actionId} has no receipt yet`);
  const index = row.actionIds.indexOf(actionId);
  if (index < 0) throw new ReceiptNotFound(`desk action #${actionId} is not in the receipt of hour ${hour} (inserted late)`);
  const rows = await d.store.actionsByIds(row.actionIds);
  const leaves = rows.map(leafOfRow);
  const leaf = leaves[index]!;
  const proof = merkleProof(leaves, index);
  const localOk = verifyProof(proof, row.root as Hex, leaf);
  let onchainOk: boolean | null = null;
  if (d.receipts && row.status === "posted") {
    onchainOk = await d.pub.readContract({ address: d.receipts, abi: receiptsAbi, functionName: "verify", args: [account, hour, leaf, proof] });
  }
  return {
    account,
    actionId,
    hour: hour.toString(),
    root: row.root,
    leafCount: row.leafCount,
    index,
    row: JSON.parse(rowJson(action)),
    rowHash: rowHash(action),
    leaf,
    proof,
    status: row.status,
    txHash: row.txHash,
    receipts: d.receipts ?? null,
    verified: localOk && onchainOk !== false,
    verifiedOnchain: onchainOk,
  };
}
