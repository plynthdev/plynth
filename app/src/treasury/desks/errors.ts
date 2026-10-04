import { BaseError, ContractFunctionRevertedError } from "viem";

/** PolicyGuard reason codes (TreasuryAccount.GuardRejected(code)). */
export const GUARD_CODES: Record<number, string> = {
  1: "R1_DESK_SCOPE",
  2: "R2_NOT_ALLOWED",
  3: "R2_NOT_CANONICAL",
  4: "R3_ORDER_CAP",
  5: "R3_DAY_CAP",
  6: "R4_BAND",
  7: "R6_UNKNOWN_CHANGE",
  8: "R7_OFF_HOURS",
  9: "R8_PAUSED",
  10: "R8_DERISK",
  11: "R9_APPROVAL",
  12: "R5_NET_DELTA",
  13: "R5_LEVERAGE",
  14: "R6_VENUE_NOT_ALLOWED",
  15: "R6_VENUE_CAP",
  16: "R6_STALE_VENUE",
};

export type Rejection = { code: number | null; reason: string; args?: unknown[] | undefined };

/** Turns an eth_call / write revert into {code, reason}. Guard rejections carry the rule code; anything else
 *  (a sleeve or router error) carries its error name and a null code. */
export function decodeRejection(err: unknown): Rejection {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      const name = reverted.data?.errorName;
      const args = reverted.data?.args as unknown[] | undefined;
      if (name === "GuardRejected") {
        const code = Number(args?.[0]);
        return { code, reason: GUARD_CODES[code] ?? `GUARD_${code}`, args };
      }
      if (name) return { code: null, reason: name, args };
      if (reverted.signature) return { code: null, reason: `unknown error ${reverted.signature}` };
      if (reverted.reason) return { code: null, reason: reverted.reason };
    }
    return { code: null, reason: err.shortMessage || err.message };
  }
  return { code: null, reason: err instanceof Error ? err.message : String(err) };
}
