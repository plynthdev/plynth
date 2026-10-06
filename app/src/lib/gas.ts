// Gas limits for transactions whose cost depends on when they are mined.
//
// eth_estimateGas runs against the pending block, whose timestamp can still equal the latest block's (anvil and
// fast L2s put several blocks in one second). Code with a "nothing changed since last time" shortcut (PerpMarket
// and PerpPool skip funding/borrow accrual when block.timestamp == lastAccrual) is then estimated on the cheap
// path, and the transaction mined a second later pays for the accrual writes it skipped (~20k gas per market)
// and runs out of gas. A bare estimate is therefore not a gas limit; this adds headroom. Unused gas is not
// charged (EIP-1559 bills gas used), so the only cost is needing the balance for the limit.

/** Multiplier on the estimate, in bps (12_500 = +25%). */
export const GAS_HEADROOM_BPS = 12_500n;
/** Flat gas added on top, so small estimates still cover a few cold accrual writes. */
export const GAS_HEADROOM_FLAT = 50_000n;

export function withGasHeadroom(estimate: bigint): bigint {
  if (estimate < 0n) throw new Error("negative gas estimate");
  return (estimate * GAS_HEADROOM_BPS) / 10_000n + GAS_HEADROOM_FLAT;
}

/**
 * Estimates `request` (the request a viem simulateContract returns) and returns it with `gas` set to the estimate
 * plus headroom, ready for writeContract.
 */
export async function withEstimatedGas<R extends Record<string, unknown>>(pub: { estimateContractGas(args: any): Promise<bigint> }, request: R): Promise<R & { gas: bigint }> {
  const est = await pub.estimateContractGas(request);
  return { ...request, gas: withGasHeadroom(est) };
}

