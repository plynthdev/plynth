// The CFO pack trusts exactly two things: the on-chain PeriodClosed event and a stored bundle whose keccak256
// equals the event's bundleHash. Everything rendered comes from those; any disagreement refuses to render.
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { periodCloseAbi } from "../close/abi";
import { BUNDLE_SCHEMA, bundleHashOf, bundlePositionsHash, type Bundle } from "../close/bundle";
import type { CloseStruct } from "../close/service";

export class CfoPackRefused extends Error {
  constructor(reason: string) {
    super(`cfo-pack refused: ${reason}`);
    this.name = "CfoPackRefused";
  }
}

export type ClosedEvent = {
  chainId: number;
  periodClose: Address;
  index: number;
  close: CloseStruct;
  feeRaw: bigint;
  feePaid: bigint;
  feeOwed: bigint;
  txHash: Hex;
  blockNumber: bigint;
};

export type Statement = { event: ClosedEvent; bundle: Bundle };

/** Reads the PeriodClosed event for `index` (or `periodEnd`). `fromBlock`/`toBlock` narrow the scan; the
 *  scan is chunked so a public RPC's log-range limit is respected. */
export async function readClosedEvent(
  pub: PublicClient,
  pc: Address,
  q: { index?: number; periodEnd?: bigint; fromBlock?: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<ClosedEvent> {
  const chainId = await pub.getChainId();
  const to = q.toBlock ?? (await pub.getBlockNumber());
  const chunk = q.chunk ?? 50_000n;
  const args = q.index !== undefined ? { index: BigInt(q.index) } : q.periodEnd !== undefined ? { periodEnd: q.periodEnd } : {};
  for (let start = q.fromBlock ?? 0n; start <= to; start += chunk) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    const logs = await pub.getContractEvents({ address: pc, abi: periodCloseAbi, eventName: "PeriodClosed", args, fromBlock: start, toBlock: end, strict: true });
    const l = logs[0];
    if (l) {
      const a = l.args as unknown as { index: bigint; close: CloseStruct; feeRaw: bigint; feePaid: bigint; feeOwed: bigint };
      return {
        chainId,
        periodClose: getAddress(pc),
        index: Number(a.index),
        close: { ...a.close, cashBps: Number(a.close.cashBps), equityBps: Number(a.close.equityBps), policyVersion: Number(a.close.policyVersion) },
        feeRaw: a.feeRaw,
        feePaid: a.feePaid,
        feeOwed: a.feeOwed,
        txHash: l.transactionHash!,
        blockNumber: l.blockNumber!,
      };
    }
  }
  throw new CfoPackRefused(`no PeriodClosed event for ${q.index !== undefined ? `index ${q.index}` : `periodEnd ${q.periodEnd}`} on ${pc}`);
}

/** Checks the stored bundle text against the event. Returns the parsed bundle or throws CfoPackRefused. */
export function verifyBundle(ev: ClosedEvent, bundleJson: string): Bundle {
  const h = bundleHashOf(bundleJson);
  if (h.toLowerCase() !== ev.close.bundleHash.toLowerCase()) {
    throw new CfoPackRefused(`bundle hash ${h} does not match on-chain bundleHash ${ev.close.bundleHash}`);
  }
  let b: Bundle;
  try {
    b = JSON.parse(bundleJson) as Bundle;
  } catch {
    throw new CfoPackRefused("bundle is not JSON");
  }
  const c = ev.close;
  const mismatch = (what: string, got: unknown, want: unknown) => {
    throw new CfoPackRefused(`bundle ${what} ${String(got)} != on-chain ${String(want)}`);
  };
  if (b.schema !== BUNDLE_SCHEMA) mismatch("schema", b.schema, BUNDLE_SCHEMA);
  if (b.chainId !== ev.chainId) mismatch("chainId", b.chainId, ev.chainId);
  if (b.periodClose.toLowerCase() !== ev.periodClose.toLowerCase()) mismatch("periodClose", b.periodClose, ev.periodClose);
  if (BigInt(b.periodEnd) !== c.periodEnd) mismatch("periodEnd", b.periodEnd, c.periodEnd);
  if (BigInt(b.navUsd) !== c.navUsd) mismatch("navUsd", b.navUsd, c.navUsd);
  if (b.cashBps !== c.cashBps || b.equityBps !== c.equityBps) mismatch("weights", `${b.cashBps}/${b.equityBps}`, `${c.cashBps}/${c.equityBps}`);
  if (b.policy.hash.toLowerCase() !== c.policyHash.toLowerCase() || b.policy.version !== c.policyVersion) mismatch("policy", `${b.policy.hash}@${b.policy.version}`, `${c.policyHash}@${c.policyVersion}`);
  if (b.positionsHash.toLowerCase() !== c.positionsHash.toLowerCase()) mismatch("positionsHash", b.positionsHash, c.positionsHash);
  const recomputed = bundlePositionsHash(b);
  if (recomputed !== c.positionsHash.toLowerCase()) mismatch("positions (recomputed hash)", recomputed, c.positionsHash);
  if (b.closeIndex !== ev.index) mismatch("closeIndex", b.closeIndex, ev.index);
  return b;
}

export type BundleSource = (chainId: number, pc: Address, bundleHash: Hex) => Promise<string | undefined>;

/** Event first, then the stored bundle by the event's hash, then verification. */
export async function loadStatement(
  pub: PublicClient,
  pc: Address,
  q: { index?: number; periodEnd?: bigint; fromBlock?: bigint; toBlock?: bigint },
  source: BundleSource,
): Promise<Statement> {
  const event = await readClosedEvent(pub, pc, q);
  const json = await source(event.chainId, pc, event.close.bundleHash);
  if (json === undefined) throw new CfoPackRefused(`no stored bundle for bundleHash ${event.close.bundleHash}`);
  return { event, bundle: verifyBundle(event, json) };
}
