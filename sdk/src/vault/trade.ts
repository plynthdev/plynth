// Private sell / buy / park / unpark (ShieldedTrade, todo 25): swap and settle proofs, tx builders, park value.
//
// A swap spends one note (v1 or v2) of `assetIn`, keeps a v1 change note, and fixes the output note except its
// amount (`outPartial = H(assetOut, ownerPk, blinding)`); ShieldedTrade appends the amount it received and
// emits PartialNoteFilled, so the owner finds the note with syncPool(..., { trade }) + myNotes. A v2 note can be
// swapped again directly; transfer/withdraw need it settled into a v1 note first (proveSettle).
import { encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import settleArtifact from "./artifacts/settle.json" with { type: "json" };
import swapArtifact from "./artifacts/swap.json" with { type: "json" };
import { shieldedTradeAbi } from "./abi";
import { NOTE_VERSION_PARTIAL, encryptNote } from "./ecies";
import type { VaultKeys } from "./keys";
import { MAX_RAW, commitmentOf, nullifierOf, partialCommitmentOf, randomField, toBytes32 } from "./note";
import { encodeTwoNotes, extHashOf, proveCircuit, spendable, type Recipient } from "./prover";
import type { OwnedNote } from "./sync";
import type { NoteTree } from "./tree";
import type { UnsignedTx } from "./tx";

export type PublicSwap = {
  root: Hex;
  nullifier: Hex;
  changeCommitment: Hex;
  assetIn: Address;
  amountIn: bigint;
  relayerFee: bigint;
  assetOut: Address;
  minOut: bigint;
  outPartial: Hex;
  deadline: bigint;
};
export type SwapProof = { proof: Hex; pub: PublicSwap; encryptedChange: Hex; encryptedOut: Hex; out: { ownerPk: bigint; blinding: bigint; partial: bigint } };
export type SettleProof = { proof: Hex; root: Hex; nullifier: Hex; outCommitment: Hex; encryptedOut: Hex; out: { raw: bigint; blinding: bigint } };

/** ShieldedTrade.Kind */
export const TradeKind = { Buy: 0, Sell: 1, Park: 2, Unpark: 3 } as const;

const f = (x: bigint) => toBytes32(x);

/**
 * Swap proof: spend `note` (v1 or v2, owned by `keys`), trade `amountIn` (incl. `relayerFee`, paid in the input
 * asset to whoever submits) for at least `minOut` of `assetOut` before `deadline` (unix seconds). The output note
 * goes to `to` (default: yourself); the change stays with `keys`.
 */
export async function proveSwap(p: {
  keys: VaultKeys;
  tree: NoteTree;
  note: OwnedNote;
  amountIn: bigint;
  assetOut: Address;
  minOut: bigint;
  deadline: bigint;
  relayerFee?: bigint;
  to?: Recipient;
}): Promise<SwapProof> {
  const { keys, tree, note } = p;
  spendable(note, tree, true);
  const fee = p.relayerFee ?? 0n;
  if (p.amountIn <= 0n || p.amountIn > note.raw || p.amountIn > MAX_RAW) throw new Error(`cannot swap ${p.amountIn} from ${note.raw}`);
  if (fee < 0n || fee >= p.amountIn) throw new Error("relayer fee must be below amountIn");
  if (p.minOut < 0n || p.minOut > MAX_RAW) throw new Error("minOut out of range");
  if (p.deadline < 0n || p.deadline >= 1n << 64n) throw new Error("deadline out of range");
  const assetIn = getAddress(note.asset);
  const assetOut = getAddress(p.assetOut);
  if (assetIn === assetOut) throw new Error("same asset");
  const to = p.to ?? keys;
  const root = tree.root();
  const nullifier = nullifierOf(note.commitment, keys.spendingSecret, BigInt(note.leafIndex));
  const change = note.raw - p.amountIn;
  const changeBlinding = randomField();
  const changeCommitment = commitmentOf(BigInt(assetIn), change, keys.ownerPk, changeBlinding);
  const outBlinding = randomField();
  const partial = partialCommitmentOf(BigInt(assetOut), to.ownerPk, outBlinding);
  // Encrypted before proving: the proof binds both (ext_hash), so a relayer cannot replace them.
  const encryptedChange = encryptNote({ asset: assetIn, raw: change, blinding: changeBlinding }, keys.viewingPub);
  const encryptedOut = encryptNote({ asset: assetOut, raw: p.minOut, blinding: outBlinding }, to.viewingPub, NOTE_VERSION_PARTIAL);
  const { proof } = await proveCircuit(swapArtifact, {
    root: f(root),
    nullifier_hash: f(nullifier),
    change_commitment: f(changeCommitment),
    asset_in: f(BigInt(assetIn)),
    amount_in: f(p.amountIn),
    relayer_fee: f(fee),
    asset_out: f(BigInt(assetOut)),
    min_out: f(p.minOut),
    out_partial: f(partial),
    deadline: f(p.deadline),
    ext_hash: f(extHashOf(encodeTwoNotes(encryptedChange, encryptedOut))),
    in_is_v2: note.version === 2,
    in_amount: f(note.raw),
    in_secret: f(keys.spendingSecret),
    in_blinding: f(note.blinding),
    in_index: f(BigInt(note.leafIndex)),
    in_path: tree.path(note.leafIndex).map(f),
    change_amount: f(change),
    change_owner_pk: f(keys.ownerPk),
    change_blinding: f(changeBlinding),
    out_owner_pk: f(to.ownerPk),
    out_blinding: f(outBlinding),
  });
  return {
    proof,
    pub: { root: f(root), nullifier: f(nullifier), changeCommitment: f(changeCommitment), assetIn, amountIn: p.amountIn, relayerFee: fee, assetOut, minOut: p.minOut, outPartial: f(partial), deadline: p.deadline },
    encryptedChange,
    encryptedOut,
    out: { ownerPk: to.ownerPk, blinding: outBlinding, partial },
  };
}

/** Settle proof: one v2 note (swap output) -> a v1 note of the same asset and amount, owned by `keys`. */
export async function proveSettle(p: { keys: VaultKeys; tree: NoteTree; note: OwnedNote }): Promise<SettleProof> {
  const { keys, tree, note } = p;
  if (note.version !== 2) throw new Error("only v2 notes (swap outputs) need settling");
  spendable(note, tree, true);
  const asset = getAddress(note.asset);
  const root = tree.root();
  const nullifier = nullifierOf(note.commitment, keys.spendingSecret, BigInt(note.leafIndex));
  const blinding = randomField();
  const outCommitment = commitmentOf(BigInt(asset), note.raw, keys.ownerPk, blinding);
  const encryptedOut = encryptNote({ asset, raw: note.raw, blinding }, keys.viewingPub);
  const { proof } = await proveCircuit(settleArtifact, {
    root: f(root),
    nullifier_hash: f(nullifier),
    out_commitment: f(outCommitment),
    ext_hash: f(extHashOf(encryptedOut)),
    asset_id: f(BigInt(asset)),
    amount: f(note.raw),
    in_secret: f(keys.spendingSecret),
    in_blinding: f(note.blinding),
    in_index: f(BigInt(note.leafIndex)),
    in_path: tree.path(note.leafIndex).map(f),
    out_owner_pk: f(keys.ownerPk),
    out_blinding: f(blinding),
  });
  return {
    proof,
    root: f(root),
    nullifier: f(nullifier),
    outCommitment: f(outCommitment),
    encryptedOut,
    out: { raw: note.raw, blinding },
  };
}

/** ShieldedTrade.swap. `maxSlippageBps` is StockRouter's oracle guard for buy/sell (max 500); the proof's minOut always binds. */
export function swapTx(trade: Address, s: SwapProof, maxSlippageBps = 100): UnsignedTx {
  return {
    to: getAddress(trade),
    data: encodeFunctionData({ abi: shieldedTradeAbi, functionName: "swap", args: [s.proof, s.pub, maxSlippageBps, s.encryptedChange, s.encryptedOut] }),
  };
}

export function settleTx(trade: Address, s: SettleProof): UnsignedTx {
  return {
    to: getAddress(trade),
    data: encodeFunctionData({ abi: shieldedTradeAbi, functionName: "settle", args: [s.proof, s.root, s.nullifier, s.outCommitment, s.encryptedOut] }),
  };
}

/** USDG value of `shares` of a park share token (ERC-4626 convertToAssets / Morpho share price incl. accrued interest). */
export async function parkValue(pub: PublicClient, trade: Address, shareToken: Address, shares: bigint): Promise<bigint> {
  return (await pub.readContract({ address: getAddress(trade), abi: shieldedTradeAbi, functionName: "parkValue", args: [getAddress(shareToken), shares] })) as bigint;
}

/** Minimum output for a swap given a quote and a slippage tolerance in bps (rounded down). */
export function minOutFor(quote: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new Error("slippage out of range");
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}
