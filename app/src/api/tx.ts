// Unsigned transaction builders. The API never holds user keys: it returns {to, data, value, chainId}
// for the user's own wallet to sign and send. Inputs are validated with the same rules the contracts
// enforce, so a bad request fails here with a reason instead of as an opaque revert in the wallet.
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { crowdAbi, erc20Abi, vaultAbi } from "@/abi/api";
import { stockOf, type ApiDeployment } from "@/chain/deployment";
import { parseAmount } from "./format";
import { MODES, type Mode } from "./service";

export type UnsignedTx = { to: Address; data: Hex; value: "0"; chainId: number };

export class TxInputError extends Error {}

const MAX_WEEKLY_CAP = 500n * 1_000_000n; // SavingsVault.MAX_WEEKLY_CAP (500 USDG)
const TOP_UPS = [0n, 25n, 50n, 100n].map((x) => x * 1_000_000n);
const MAX_MIX = 5;

function amount(s: string): bigint {
  let v: bigint;
  try {
    v = parseAmount(s);
  } catch (e) {
    throw new TxInputError((e as Error).message);
  }
  if (v === 0n) throw new TxInputError("amount must be > 0");
  return v;
}

const tx = (chainId: number, to: Address, data: Hex): UnsignedTx => ({ to, data, value: "0", chainId });

export type SettingsInput = { roundTo: number; multiplier: number; weeklyCap: string; fixedTopUp: string; mode: Mode };

export function buildSetSettings(chainId: number, dep: ApiDeployment, i: SettingsInput): UnsignedTx {
  if (![1, 5, 10].includes(i.roundTo)) throw new TxInputError("roundTo must be 1, 5 or 10");
  if (![1, 2, 3].includes(i.multiplier)) throw new TxInputError("multiplier must be 1, 2 or 3");
  let cap: bigint, top: bigint;
  try {
    cap = parseAmount(i.weeklyCap);
    top = parseAmount(i.fixedTopUp);
  } catch (e) {
    throw new TxInputError((e as Error).message);
  }
  if (cap > MAX_WEEKLY_CAP) throw new TxInputError("weeklyCap must be <= 500 USDG");
  if (!TOP_UPS.includes(top)) throw new TxInputError("fixedTopUp must be 0, 25, 50 or 100 USDG");
  const mode = MODES.indexOf(i.mode);
  if (mode < 0) throw new TxInputError("mode must be open, quiet or hidden");
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: "setSettings",
    args: [{ roundTo: i.roundTo, multiplier: i.multiplier, weeklyCap: cap, fixedTopUp: top, mode }],
  });
  return tx(chainId, dep.vault, data);
}

/** USDG.approve(vault, amount): needed once before deposit (plain ERC-20 path). */
export function buildApproveUsdg(chainId: number, dep: ApiDeployment, amt: string): UnsignedTx {
  return tx(chainId, dep.usdg, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dep.vault, amount(amt)] }));
}

export function buildDeposit(chainId: number, dep: ApiDeployment, amt: string): UnsignedTx {
  return tx(chainId, dep.vault, encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amount(amt)] }));
}

export function buildWithdraw(chainId: number, dep: ApiDeployment, amt: string, to: string): UnsignedTx {
  const dest = getAddress(to);
  if (BigInt(dest) === 0n) throw new TxInputError("to must not be the zero address");
  return tx(chainId, dep.vault, encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [amount(amt), dest] }));
}

export function buildSetMix(chainId: number, dep: ApiDeployment, mix: { token: string; weightBps: number }[]): UnsignedTx {
  if (mix.length === 0 || mix.length > MAX_MIX) throw new TxInputError(`mix needs 1 to ${MAX_MIX} entries`);
  const seen = new Set<string>();
  let sum = 0;
  const entries = mix.map((m) => {
    const s = stockOf(dep, m.token);
    if (!s) throw new TxInputError(`unknown Stock Token ${m.token}`);
    if (seen.has(s.token)) throw new TxInputError(`duplicate token ${s.symbol}`);
    seen.add(s.token);
    if (!Number.isInteger(m.weightBps) || m.weightBps <= 0 || m.weightBps > 10_000) throw new TxInputError("weightBps must be 1..10000");
    sum += m.weightBps;
    return { stockToken: s.token, weightBps: m.weightBps };
  });
  if (sum !== 10_000) throw new TxInputError(`weights must sum to 10000 bps (got ${sum})`);
  return tx(chainId, dep.vault, encodeFunctionData({ abi: vaultAbi, functionName: "setMix", args: [entries] }));
}

export function buildClaimOpen(chainId: number, dep: ApiDeployment, asset: string, bookId: string): UnsignedTx {
  const s = stockOf(dep, asset);
  if (!s) throw new TxInputError(`unknown Stock Token ${asset}`);
  if (!/^\d{1,78}$/.test(bookId)) throw new TxInputError("bookId must be a non-negative integer");
  return tx(chainId, dep.crowd, encodeFunctionData({ abi: crowdAbi, functionName: "claimOpen", args: [s.token, BigInt(bookId)] }));
}
