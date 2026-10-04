// Viewing-key statements: decrypt the user's notes from ShieldedPool events, then report for a block period
// the balance per asset at period end (raw, and valued with the Stock Token multiplier and price read at the
// period's last block), the opening balance, and every movement inside the period.
//
// What a viewing key can and cannot see:
//   - viewingSecret + ownerPk open every note sent to the user (deposits, received transfers, change).
//   - Spends are only visible with the spending secret, because a nullifier is Poseidon2(commitment,
//     spendingSecret, leafIndex). A statement built from the viewing key alone lists every note received and
//     marks spent status "unknown" (spendsVisible = false); the owner's own statement passes spendingSecret.
import { erc20Abi, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { decryptNote } from "../vault/ecies";
import type { VaultKeys } from "../vault/keys";
import { commitmentOf, nullifierOf } from "../vault/note";
import { atOrBefore, scanPool, type PoolHistory } from "./scan";

export const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote q)",
  "function value(address token, uint256 rawUnits) view returns (uint256 usd, bool hold)",
]);

/** What a statement needs. A full VaultKeys also works (it has all three fields). */
export type ViewingKey = { viewingSecret: Uint8Array; ownerPk: bigint; spendingSecret?: bigint };

/** Only the viewing part of the keys: what a user hands an accountant. It cannot spend and cannot see spends. */
export const viewingKeyOf = (k: VaultKeys): ViewingKey => ({ viewingSecret: k.viewingSecret, ownerPk: k.ownerPk });

/** Inclusive block range. */
export type Period = { fromBlock: bigint; toBlock: bigint };

export type StatementOptions = {
  chainId: number;
  pool: Address;
  /** The pool's deploy block: history is scanned from here (leaves must be complete to know leaf indexes). */
  deployBlock: bigint;
  /** Values Stock Tokens (raw x multiplier x price) at period end. Without it only stables are valued. */
  valuer?: Address;
  /** Tokens valued at 1 USD per whole token (USDG). */
  stables?: Address[];
  symbols?: Record<string, string>;
  chunk?: bigint;
  /** Reuse a scan that already covers [deployBlock, period.toBlock]. */
  history?: PoolHistory;
};

export type NoteStatus = "unspent" | "spent" | "pending" | "refunded" | "unknown";

export type StatementNote = {
  commitment: bigint;
  asset: Address;
  raw: bigint;
  blinding: bigint;
  ownerPk: bigint;
  /** deposit = queued by a deposit (incl. Hidden delivery); change = output of the user's own spend; received = from someone else. */
  source: "deposit" | "change" | "received";
  depositOrigin: Address | null;
  createdBlock: bigint;
  createdTx: Hex;
  leafIndex: number | null;
  insertedBlock: bigint | null;
  insertedTx: Hex | null;
  nullifier: bigint | null;
  spentBlock: bigint | null;
  spentTx: Hex | null;
  refundedBlock: bigint | null;
  /** At period end. */
  status: NoteStatus;
};

export type Movement = {
  block: bigint;
  logIndex: number;
  timestamp: bigint;
  txHash: Hex;
  /** in = a note entered the tree; out = a note was spent; queued/refunded = pending deposits (not balance). */
  type: "in" | "out" | "queued" | "refunded";
  kind: StatementNote["source"] | "spent" | "refund";
  asset: Address;
  symbol: string;
  raw: bigint;
  commitment: bigint;
};

export type AssetBalance = {
  asset: Address;
  symbol: string;
  decimals: number;
  opening: bigint;
  in: bigint;
  out: bigint;
  /** Unspent notes in the tree at period end (= opening + in - out). */
  closing: bigint;
  /** Queued deposits not yet in the tree at period end. */
  pending: bigint;
  /** USD 1e18 of `closing` at period end, or null when there is no price we can stand behind. */
  usd18: bigint | null;
  priceUsd18: bigint | null;
  multiplier18: bigint | null;
  hold: boolean;
};

export type Statement = {
  version: 1;
  kind: "plynth.statement";
  chainId: number;
  pool: Address;
  ownerPk: bigint;
  period: Period & { start: bigint; end: bigint };
  spendsVisible: boolean;
  balances: AssetBalance[];
  movements: Movement[];
  notes: StatementNote[];
  totalUsd18: bigint;
  generatedAt: string;
};

/** The user's notes as of `toBlock` (status at that block), from a scan. */
export function notesAt(h: PoolHistory, key: ViewingKey, toBlock: bigint): StatementNote[] {
  const leafOf = new Map<bigint, (typeof h.leaves)[number]>();
  for (const l of h.leaves) if (l.block <= toBlock && !leafOf.has(l.commitment)) leafOf.set(l.commitment, l);
  const mine: StatementNote[] = [];
  const seen = new Set<bigint>();
  for (const e of h.encrypted) {
    if (e.block > toBlock || seen.has(e.commitment)) continue;
    const p = decryptNote(e.data, key.viewingSecret);
    if (!p) continue;
    if (commitmentOf(BigInt(p.asset), p.raw, key.ownerPk, p.blinding) !== e.commitment) continue;
    seen.add(e.commitment);
    const leaf = leafOf.get(e.commitment);
    const dep = h.deposits.get(e.commitment);
    const refund = h.refunds.get(e.commitment);
    const nullifier = leaf && key.spendingSecret !== undefined ? nullifierOf(e.commitment, key.spendingSecret, BigInt(leaf.index)) : null;
    const spent = nullifier !== null ? h.nullifiers.get(nullifier) : undefined;
    const spentNow = atOrBefore(spent, toBlock);
    const refundedNow = atOrBefore(refund, toBlock);
    const status: NoteStatus = refundedNow ? "refunded" : !leaf ? "pending" : spentNow ? "spent" : key.spendingSecret === undefined ? "unknown" : "unspent";
    mine.push({
      commitment: e.commitment,
      asset: p.asset,
      raw: p.raw,
      blinding: p.blinding,
      ownerPk: key.ownerPk,
      source: dep ? "deposit" : "received",
      depositOrigin: dep?.origin ?? null,
      createdBlock: e.block,
      createdTx: e.txHash,
      leafIndex: leaf?.index ?? null,
      insertedBlock: leaf?.block ?? null,
      insertedTx: leaf?.txHash ?? null,
      nullifier,
      spentBlock: spentNow ? spent!.block : null,
      spentTx: spentNow ? spent!.txHash : null,
      refundedBlock: refundedNow ? refund!.block : null,
      status,
    });
  }
  // A note created in the same transaction that spent one of the user's notes is change.
  const spendTxs = new Set(mine.filter((n) => n.spentTx).map((n) => n.spentTx!));
  for (const n of mine) if (n.source === "received" && spendTxs.has(n.createdTx)) n.source = "change";
  return mine;
}

/** Unspent, inserted balance per asset at `block` (spent status unknown counts as unspent). */
function balanceAt(notes: StatementNote[], block: bigint): Map<Address, bigint> {
  const m = new Map<Address, bigint>();
  for (const n of notes) {
    if (n.insertedBlock === null || n.insertedBlock > block) continue;
    if (n.spentBlock !== null && n.spentBlock <= block) continue;
    m.set(n.asset, (m.get(n.asset) ?? 0n) + n.raw);
  }
  return m;
}

async function value(pub: PublicClient, o: StatementOptions, asset: Address, raw: bigint, decimals: number, block: bigint) {
  if ((o.stables ?? []).some((s) => s.toLowerCase() === asset.toLowerCase())) {
    const unit = 10n ** BigInt(decimals);
    return { usd18: (raw * 10n ** 18n) / unit, priceUsd18: 10n ** 18n, multiplier18: null, hold: false };
  }
  if (!o.valuer) return { usd18: null, priceUsd18: null, multiplier18: null, hold: true };
  try {
    const [q, v] = await Promise.all([
      pub.readContract({ address: o.valuer, abi: valuerAbi, functionName: "quote", args: [asset], blockNumber: block }),
      pub.readContract({ address: o.valuer, abi: valuerAbi, functionName: "value", args: [asset, raw], blockNumber: block }),
    ]);
    return { usd18: v[0], priceUsd18: q.priceUsdPerToken, multiplier18: q.multiplier, hold: v[1] };
  } catch {
    // Delisted token or a broken feed at that block: show the raw amount, no USD value.
    return { usd18: null, priceUsd18: null, multiplier18: null, hold: true };
  }
}

/** Builds a statement for `period` from the chain. Nothing leaves the caller: keys are only used locally. */
export async function statement(pub: PublicClient, key: ViewingKey, period: Period, o: StatementOptions): Promise<Statement> {
  if (period.fromBlock > period.toBlock) throw new Error("period: fromBlock > toBlock");
  if (period.fromBlock < o.deployBlock) throw new Error("period starts before the pool was deployed");
  const h = o.history && o.history.toBlock >= period.toBlock && o.history.fromBlock <= o.deployBlock ? o.history : await scanPool(pub, o.pool, o.deployBlock, period.toBlock, o.chunk);
  const notes = notesAt(h, key, period.toBlock);
  const inPeriod = (b: bigint | null) => b !== null && b >= period.fromBlock && b <= period.toBlock;

  const symbols = new Map<string, string>(Object.entries(o.symbols ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const assets = [...new Set(notes.map((n) => n.asset))].sort();
  const decimals = new Map<Address, number>();
  await Promise.all(
    assets.map(async (a) => {
      decimals.set(a, Number(await pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals", blockNumber: period.toBlock })));
      if (!symbols.has(a.toLowerCase())) {
        try {
          symbols.set(a.toLowerCase(), await pub.readContract({ address: a, abi: erc20Abi, functionName: "symbol", blockNumber: period.toBlock }));
        } catch {
          symbols.set(a.toLowerCase(), a.slice(0, 10));
        }
      }
    }),
  );
  const sym = (a: Address) => symbols.get(a.toLowerCase())!;

  const moves: Omit<Movement, "timestamp">[] = [];
  for (const n of notes) {
    const base = { asset: n.asset, symbol: sym(n.asset), raw: n.raw, commitment: n.commitment };
    if (n.raw === 0n) continue; // zero-value dummy/change outputs move nothing
    const dep = n.source === "deposit" ? h.deposits.get(n.commitment)! : undefined;
    if (dep && inPeriod(dep.block)) moves.push({ ...base, block: dep.block, logIndex: dep.logIndex, txHash: dep.txHash, type: "queued", kind: "deposit" });
    if (inPeriod(n.insertedBlock)) {
      const leaf = h.leaves[n.leafIndex!]!;
      moves.push({ ...base, block: leaf.block, logIndex: leaf.logIndex, txHash: leaf.txHash, type: "in", kind: n.source });
    }
    if (inPeriod(n.spentBlock)) {
      const s = h.nullifiers.get(n.nullifier!)!;
      moves.push({ ...base, block: s.block, logIndex: s.logIndex, txHash: s.txHash, type: "out", kind: "spent" });
    }
    if (inPeriod(n.refundedBlock)) {
      const r = h.refunds.get(n.commitment)!;
      moves.push({ ...base, block: r.block, logIndex: r.logIndex, txHash: r.txHash, type: "refunded", kind: "refund" });
    }
  }
  moves.sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));

  const blocks = [...new Set([period.fromBlock, period.toBlock, ...moves.map((m) => m.block)])];
  const times = new Map<bigint, bigint>();
  for (let i = 0; i < blocks.length; i += 20) {
    const part = blocks.slice(i, i + 20);
    const got = await Promise.all(part.map((b) => pub.getBlock({ blockNumber: b })));
    got.forEach((b, j) => times.set(part[j]!, b.timestamp));
  }
  const movements: Movement[] = moves.map((m) => ({ ...m, timestamp: times.get(m.block)! }));

  const opening = balanceAt(notes, period.fromBlock - 1n);
  const closing = balanceAt(notes, period.toBlock);
  const balances: AssetBalance[] = [];
  for (const a of assets) {
    const sum = (t: Movement["type"]) => movements.filter((m) => m.asset === a && m.type === t).reduce((s, m) => s + m.raw, 0n);
    const close = closing.get(a) ?? 0n;
    const pending = notes.filter((n) => n.asset === a && n.status === "pending").reduce((s, n) => s + n.raw, 0n);
    const b: AssetBalance = {
      asset: a,
      symbol: sym(a),
      decimals: decimals.get(a)!,
      opening: opening.get(a) ?? 0n,
      in: sum("in"),
      out: sum("out"),
      closing: close,
      pending,
      ...(await value(pub, o, a, close, decimals.get(a)!, period.toBlock)),
    };
    if (b.opening + b.in - b.out !== b.closing) throw new Error(`statement does not reconcile for ${a}`);
    balances.push(b);
  }

  return {
    version: 1,
    kind: "plynth.statement",
    chainId: o.chainId,
    pool: o.pool,
    ownerPk: key.ownerPk,
    period: { ...period, start: times.get(period.fromBlock)!, end: times.get(period.toBlock)! },
    spendsVisible: key.spendingSecret !== undefined,
    balances,
    movements,
    notes,
    totalUsd18: balances.reduce((s, b) => s + (b.usd18 ?? 0n), 0n),
    generatedAt: new Date().toISOString(),
  };
}
