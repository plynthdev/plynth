// Unsigned transaction builders for ShieldedPool, and the relayer client for gasless withdraws.
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { shieldedPoolAbi } from "./abi";
import { encryptNote } from "./ecies";
import { MAX_RAW, commitmentOf, randomField, toBytes32 } from "./note";
import type { PublicTransfer, PublicWithdraw, Recipient } from "./prover";

export type UnsignedTx = { to: Address; data: Hex };

/** approve(pool, raw) on the token: the pool pulls exactly `raw` on deposit. */
export function approveTx(asset: Address, pool: Address, raw: bigint): UnsignedTx {
  return { to: getAddress(asset), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(pool), raw] }) };
}

/** Deposit `raw` of `asset` as a note owned by `to` (yourself or anyone's registered keys). */
export function depositTx(pool: Address, asset: Address, raw: bigint, to: Recipient): UnsignedTx & { commitment: bigint; blinding: bigint } {
  if (raw <= 0n || raw > MAX_RAW) throw new Error("raw out of range");
  const blinding = randomField();
  const a = getAddress(asset);
  const data = encodeFunctionData({
    abi: shieldedPoolAbi,
    functionName: "deposit",
    args: [a, raw, toBytes32(to.ownerPk), toBytes32(blinding), encryptNote({ asset: a, raw, blinding }, to.viewingPub)],
  });
  return { to: getAddress(pool), data, commitment: commitmentOf(BigInt(a), raw, to.ownerPk, blinding), blinding };
}

export function refundPendingTx(pool: Address, pendingId: bigint): UnsignedTx {
  return { to: getAddress(pool), data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "refundPending", args: [pendingId] }) };
}

export function insertPendingTx(pool: Address, maxCount: bigint): UnsignedTx {
  return { to: getAddress(pool), data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "insertPending", args: [maxCount] }) };
}

export function transferTx(pool: Address, t: { proof: Hex; pub: PublicTransfer; encryptedNotes: readonly [Hex, Hex] }): UnsignedTx {
  return { to: getAddress(pool), data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "transfer", args: [t.proof, t.pub, t.encryptedNotes] }) };
}

export function withdrawTx(pool: Address, w: { proof: Hex; pub: PublicWithdraw }): UnsignedTx {
  return { to: getAddress(pool), data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "withdraw", args: [w.proof, w.pub] }) };
}

// The relayer client lives in @plynth/sdk/relayer; re-exported here so existing vault imports keep working.
export { submitWithdraw, withdrawRequest } from "../relayer";
