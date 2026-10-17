// Equity desk order splitting. The guard bounds every operation's loss at maxOpLossBps of its notional (rule 6,
// R6_UNKNOWN_CHANGE) and the equity sleeve asks the router for at most that slippage against the oracle (Slippage).
// A buy too big for the pool's depth breaks one of them although a smaller one would not, so the desk does not raise
// the bound: it halves the order until each piece passes, down to a minimum piece, and sends the pieces one by one.
// What is still unfilled (the pool is off the oracle even for a minimum piece, or the send budget ran out) waits for a
// later pass of the same window (see runner.ts: rebalance_partial).

/** Rejections a smaller order can avoid. Anything else (band, caps, pause, off-hours) is not a size problem. */
export const SPLIT_REASONS: ReadonlySet<string> = new Set(["Slippage", "R6_UNKNOWN_CHANGE"]);

export type Probe = (amount: bigint) => Promise<{ ok: true } | { ok: false; reason: string }>;
/** Sends one piece; true when it landed. */
export type Send = (amount: bigint) => Promise<boolean>;

export type SplitResult = {
  filled: bigint;
  sends: number;
  /** Why the rest was not filled: a non-size rejection, "min piece" (a minimum piece still fails on size), "reverted",
   *  or "max sends". Absent when everything was filled. */
  stuck?: string;
  /** True when the rest can be retried by a later pass (a size problem, not a rule). */
  retryLater?: boolean;
};

/**
 * Fills `total` in pieces: tries the whole amount, halves on a size rejection while the half is at least `minPiece`,
 * then keeps sending pieces of the size that passed (re-probing each, since every fill moves the pool).
 */
export async function splitFill(total: bigint, minPiece: bigint, maxSends: number, probe: Probe, send: Send): Promise<SplitResult> {
  let piece = total;
  let filled = 0n;
  let sends = 0;
  while (filled < total) {
    if (sends >= maxSends) return { filled, sends, stuck: "max sends", retryLater: true };
    const c = piece < total - filled ? piece : total - filled;
    const r = await probe(c);
    if (r.ok) {
      if (!(await send(c))) return { filled, sends, stuck: "reverted" };
      filled += c;
      sends++;
      continue;
    }
    if (!SPLIT_REASONS.has(r.reason)) return { filled, sends, stuck: r.reason };
    if (c / 2n < minPiece) return { filled, sends, stuck: "min piece", retryLater: true };
    piece = c / 2n;
  }
  return { filled, sends };
}
