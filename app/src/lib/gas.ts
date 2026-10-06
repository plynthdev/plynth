// Gas limits for transactions whose cost depends on when they are mined.
//
// eth_estimateGas runs against the pending block, whose timestamp can still equal the latest block's (anvil and
// fast L2s put several blocks in one second). Code with a "nothing changed since last time" shortcut (PerpMarket
// and PerpPool skip funding/borrow accrual when block.timestamp == lastAccrual) is then estimated on the cheap
// path, and the transaction mined a second later pays for the accrual writes it skipped and runs out of gas.
//
// Fix at the source (fork run 2026-10-06, an in-house perp open out-ran the headroom): `estimateGasAhead` also
// estimates against the latest block with its timestamp moved one second ahead (eth_estimateGas block override
// `time`), so every per-second path is priced, and takes the larger of the two. On a node that rejects block
// overrides it falls back to the plain estimate. Headroom on top covers state that moves between estimate and
// inclusion. Unused gas is not charged (EIP-1559 bills gas used), so the only cost is needing the balance for
// the limit.
import { encodeFunctionData, toHex, type Abi, type Address, type Hex } from "viem";

/** Multiplier on the estimate, in bps (12_500 = +25%). */
export const GAS_HEADROOM_BPS = 12_500n;
/** Flat gas added on top, so small estimates still cover a few cold writes. */
export const GAS_HEADROOM_FLAT = 50_000n;
/** How far ahead (seconds) the second estimate runs. */
export const ESTIMATE_AHEAD_S = 1n;

export function withGasHeadroom(estimate: bigint): bigint {
  if (estimate < 0n) throw new Error("negative gas estimate");
  return (estimate * GAS_HEADROOM_BPS) / 10_000n + GAS_HEADROOM_FLAT;
}

/** The parts of a viem PublicClient the estimate needs. */
export type GasClient = {
  estimateContractGas(args: any): Promise<bigint>;
  getBlock(args: { blockTag: "latest" }): Promise<{ timestamp: bigint }>;
  request(args: { method: any; params?: any }): Promise<unknown>;
};

/** A contract call as viem's simulateContract returns it (or as passed to estimateContractGas). */
export type ContractCall = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  account?: Address | { address: Address };
  value?: bigint;
  [k: string]: unknown;
};

/**
 * Gas for `call` mined now or in the next second: max(plain estimate, estimate at latest.timestamp + 1). The
 * plain estimate's errors (a revert) propagate; the ahead estimate is best effort (a node without block
 * overrides, or a call that only fails a second later, falls back to the plain estimate).
 */
export async function estimateGasAhead(pub: GasClient, call: ContractCall): Promise<bigint> {
  const plain = await pub.estimateContractGas(call);
  const ahead = await estimateAt(pub, call, ESTIMATE_AHEAD_S).catch(() => undefined);
  return ahead !== undefined && ahead > plain ? ahead : plain;
}

/** eth_estimateGas against the latest state with the block timestamp moved `seconds` ahead. */
export async function estimateAt(pub: GasClient, call: ContractCall, seconds: bigint): Promise<bigint> {
  const { timestamp } = await pub.getBlock({ blockTag: "latest" });
  const from = typeof call.account === "string" ? call.account : call.account?.address;
  const data = encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: (call.args ?? []) as unknown[] });
  const tx: { from?: Address; to: Address; data: Hex; value?: Hex } = { to: call.address, data };
  if (from) tx.from = from;
  if (call.value) tx.value = toHex(call.value);
  const res = await pub.request({ method: "eth_estimateGas", params: [tx, "latest", {}, { time: toHex(timestamp + seconds) }] });
  return BigInt(res as Hex);
}

/**
 * Estimates `request` (the request a viem simulateContract returns) with `estimateGasAhead` and returns it with
 * `gas` set to that estimate plus headroom, ready for writeContract.
 */
export async function withEstimatedGas<R extends Record<string, unknown>>(pub: GasClient, request: R): Promise<R & { gas: bigint }> {
  const est = await estimateGasAhead(pub, request as unknown as ContractCall);
  return { ...request, gas: withGasHeadroom(est) };
}
