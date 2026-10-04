// On-chain USDG spends (todo 07) behind the SpendSource interface. These keep their natural on-chain identity
// as the accrual key, (txHash, logIndex), which is what the vault has keyed them on since todo 07.
import { linkedUserAt, linkEvents, linkIntervals, type LinkInterval } from "@plynth/indexer";
import type { Address } from "viem";
import type { Ctx } from "../context";
import { openSpends, type SpendLog } from "../state";
import type { SpendEvent, SpendSource } from "./types";

export type SpendDecision = { kind: "accrue"; user: string } | { kind: "skip"; reason: string };

/** Pure: is this transfer a round-up source, and for whom? */
export function classifySpend(s: SpendLog, intervals: Map<string, LinkInterval[]>, plynth: Set<string>): SpendDecision {
  const user = intervalsUser(intervals, s);
  if (!user) return { kind: "skip", reason: "wallet not linked at this block" };
  if (plynth.has(s.to.toLowerCase())) return { kind: "skip", reason: "transfer into a Plynth contract" };
  if (s.value === 0n) return { kind: "skip", reason: "zero-value transfer" };
  return { kind: "accrue", user };
}

const intervalsUser = (iv: Map<string, LinkInterval[]>, s: SpendLog) => linkedUserAt(iv, s.from, s.blockNumber);

export const onchainEventId = (s: Pick<SpendLog, "txHash" | "logIndex">) => `${s.txHash.toLowerCase()}:${s.logIndex}`;

/** USDG has 6 decimals, so the exact amount travels in `units`; amountCents is the truncated display value. */
export function onchainEvent(s: SpendLog): SpendEvent {
  return { id: onchainEventId(s), amountCents: s.value / 10_000n, units: s.value, currency: "USDG", at: s.indexedAt ?? new Date(0), merchant: s.to.toLowerCase() };
}

export class OnchainSource implements SpendSource {
  readonly name = "onchain" as const;
  constructor(private readonly ctx: Pick<Ctx, "db" | "chainId" | "dep">) {}

  /** Every open indexed transfer out of a linked wallet, with the decision for it. */
  async scan(): Promise<{ spend: SpendLog; decision: SpendDecision }[]> {
    const intervals = linkIntervals(await linkEvents(this.ctx.db, this.ctx.chainId, this.ctx.dep.vault));
    const spends = await openSpends(this.ctx.db, this.ctx.chainId, this.ctx.dep.usdg, [...intervals.keys()]);
    return spends.map((spend) => ({ spend, decision: classifySpend(spend, intervals, this.ctx.dep.plynth) }));
  }

  async fetch(user: Address, since: Date): Promise<SpendEvent[]> {
    return (await this.scan())
      .filter(({ spend, decision }) => decision.kind === "accrue" && decision.user.toLowerCase() === user.toLowerCase() && (spend.indexedAt ?? new Date(0)) >= since)
      .map(({ spend }) => onchainEvent(spend));
  }
}
