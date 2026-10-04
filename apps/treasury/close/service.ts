// The close service. At each period end: wait until the held feeds are fresh, build the Close and its bundle
// from one pinned block (PeriodClose.preview + the account's tracked assets + this period's desk actions),
// store the bundle, sign the Close with the controller key (EIP-712), simulate, commit, record the tx.
//
// PeriodClose recomputes NAV exactly at inclusion. If the chain moves between the preview and inclusion (a
// feed round, vault interest accruing per second) the commit reverts with NavMismatch/PositionsMismatch/
// WeightsMismatch; the service marks that bundle `stale` and rebuilds, up to `maxAttempts` times.
import { decodeEventLog, zeroAddress, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { accountAbi, erc20Abi } from "../desks/abi";
import { decodeRejection } from "../desks/errors";
import { closeDomain, closePolicyAbi, CLOSE_TYPES, periodCloseAbi } from "./abi";
import { BUNDLE_SCHEMA, bundleHashOf, canonicalJson, positionsHashOf, type Bundle, type BundlePosition } from "./bundle";
import type { CloseStore } from "./store";
import { parseAbi } from "viem";

const symbolAbi = parseAbi(["function symbol() view returns (string)"]);
const RETRYABLE = new Set(["NavMismatch", "PositionsMismatch", "WeightsMismatch"]);

export type CloseStruct = {
  periodEnd: bigint;
  navUsd: bigint;
  cashBps: number;
  equityBps: number;
  positionsHash: Hex;
  bundleHash: Hex;
  policyHash: Hex;
  policyVersion: number;
};

export type CloseContext = {
  chain: Chain;
  pub: PublicClient;
  controller: PrivateKeyAccount;
  wallet: WalletClient;
  periodClose: Address;
  store: CloseStore;
  maxAttempts?: number;
  say?: (m: string) => void;
};

export type CloseOutcome =
  | { status: "not_due"; periodEnd: bigint; now: bigint }
  | { status: "hold"; periodEnd: bigint; token: Address }
  | { status: "committed"; periodEnd: bigint; index: number; txHash: Hex; bundleHash: Hex; attempts: number }
  | { status: "failed"; periodEnd: bigint; error: string };

export type Built = { close: CloseStruct; bundle: Bundle; json: string; holdToken: Address; lastDeskActionId: number };

/** The period end the next statement covers: one policy period after the previous close (or after deploy). */
export async function targetPeriodEnd(pub: PublicClient, pc: Address): Promise<bigint> {
  const count = await pub.readContract({ address: pc, abi: periodCloseAbi, functionName: "closeCount" });
  if (count > 0n) return BigInt(await pub.readContract({ address: pc, abi: periodCloseAbi, functionName: "nextPeriodEnd" }));
  const start = await pub.readContract({ address: pc, abi: periodCloseAbi, functionName: "startTime" });
  const policy = await pub.readContract({ address: pc, abi: periodCloseAbi, functionName: "policy" });
  const v = await pub.readContract({ address: policy, abi: closePolicyAbi, functionName: "versionAt", args: [start] });
  const [p] = await pub.readContract({ address: policy, abi: closePolicyAbi, functionName: "policyAt", args: [v] });
  return BigInt(start) + BigInt(p.periodSeconds);
}

/** Builds the Close and its bundle from one block. Does not sign or send. */
export async function buildClose(ctx: Pick<CloseContext, "chain" | "pub" | "periodClose" | "store">, periodEnd: bigint): Promise<Built> {
  const { pub, periodClose: pc } = ctx;
  const block = await pub.getBlock({ blockTag: "latest" });
  const blockNumber = block.number!;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;

  const [positions, positionsHash, navUsd, cashBps, equityBps, holdToken] = await read<
    readonly [readonly { asset: Address; raw: bigint; price: bigint; multiplier: bigint; roundId: bigint }[], Hex, bigint, number, number, Address]
  >(pc, periodCloseAbi, "preview");
  const account = await read<Address>(pc, periodCloseAbi, "account");
  const policy = await read<Address>(pc, periodCloseAbi, "policy");
  const count = await read<bigint>(pc, periodCloseAbi, "closeCount");
  const periodStart = count === 0n ? await read<bigint>(pc, periodCloseAbi, "startTime") : (await read<CloseStruct>(pc, periodCloseAbi, "latest")).periodEnd;
  const feeRecipient = await read<Address>(pc, periodCloseAbi, "feeRecipient");
  const version = await read<number>(policy, closePolicyAbi, "versionAt", [periodEnd]);
  const [, policyHash] = await read<readonly [unknown, Hex, bigint]>(policy, closePolicyAbi, "policyAt", [version]);
  const [assets, kinds, bands] = await read<readonly [readonly Address[], readonly number[], readonly number[]]>(account, accountAbi, "trackedAssets");
  const meta = new Map(assets.map((a, i) => [a.toLowerCase(), { kind: kinds[i]!, band: bands[i]! }]));

  if (positionsHashOf(positions) !== positionsHash) throw new Error("preview positions do not hash to the preview positionsHash");

  const bpos: BundlePosition[] = [];
  for (const p of positions) {
    const decimals = Number(await read<number>(p.asset, erc20Abi, "decimals"));
    let symbol = "";
    try {
      symbol = await read<string>(p.asset, symbolAbi, "symbol");
    } catch {
      symbol = "";
    }
    const usd = (p.raw * p.price) / 10n ** BigInt(decimals);
    const m = meta.get(p.asset.toLowerCase());
    bpos.push({
      asset: p.asset.toLowerCase(),
      symbol,
      kind: m?.kind ?? -1,
      band: m?.band ?? -1,
      decimals,
      raw: p.raw.toString(),
      price: p.price.toString(),
      multiplier: p.multiplier.toString(),
      roundId: p.roundId.toString(),
      usd: usd.toString(),
      weightBps: navUsd === 0n ? 0 : Number((usd * 10_000n) / navUsd),
    });
  }

  const afterId = await ctx.store.lastCoveredDeskActionId(ctx.chain.id, pc);
  const deskActions = await ctx.store.deskActionsSince(ctx.chain.id, account, afterId);
  const lastDeskActionId = deskActions.length ? deskActions[deskActions.length - 1]!.id : afterId;

  const bundle: Bundle = {
    schema: BUNDLE_SCHEMA,
    chainId: ctx.chain.id,
    periodClose: pc.toLowerCase(),
    account: account.toLowerCase(),
    closeIndex: Number(count),
    periodStart: Number(periodStart),
    periodEnd: Number(periodEnd),
    navUsd: navUsd.toString(),
    cashBps: Number(cashBps),
    equityBps: Number(equityBps),
    positionsHash,
    policy: { hash: policyHash, version: Number(version) },
    positions: bpos,
    deskActions,
    guardDenials: deskActions.filter((a) => a.status === "rejected" || a.status === "reverted"),
    deskActionRange: { afterId, toId: lastDeskActionId },
    fee: { bps: 25, recipient: feeRecipient.toLowerCase() },
    preview: { block: blockNumber.toString(), timestamp: Number(block.timestamp) },
  };
  const json = canonicalJson(bundle);
  const close: CloseStruct = {
    periodEnd,
    navUsd,
    cashBps: Number(cashBps),
    equityBps: Number(equityBps),
    positionsHash,
    bundleHash: bundleHashOf(json),
    policyHash,
    policyVersion: Number(version),
  };
  return { close, bundle, json, holdToken, lastDeskActionId };
}

export async function signClose(controller: PrivateKeyAccount, chainId: number, pc: Address, close: CloseStruct): Promise<Hex> {
  return controller.signTypedData({ domain: closeDomain(chainId, pc), types: CLOSE_TYPES, primaryType: "Close", message: close });
}

/** One pass: commits the next period's statement if it is due and the held feeds are fresh. */
export async function closeOnce(ctx: CloseContext): Promise<CloseOutcome> {
  const say = ctx.say ?? (() => {});
  const pc = ctx.periodClose;
  const periodEnd = await targetPeriodEnd(ctx.pub, pc);
  const now = (await ctx.pub.getBlock({ blockTag: "latest" })).timestamp;
  if (now < periodEnd) return { status: "not_due", periodEnd, now };

  const max = ctx.maxAttempts ?? 5;
  let lastErr = "";
  for (let attempt = 1; attempt <= max; attempt++) {
    const b = await buildClose(ctx, periodEnd);
    if (b.holdToken !== zeroAddress) {
      say(`period ${periodEnd}: feed on hold for ${b.holdToken}; retry when markets reopen`);
      return { status: "hold", periodEnd, token: b.holdToken };
    }
    const signature = await signClose(ctx.controller, ctx.chain.id, pc, b.close);
    const id = await ctx.store.insertSigned({
      chainId: ctx.chain.id,
      periodClose: pc,
      account: b.bundle.account,
      periodEnd,
      navUsd: b.close.navUsd,
      bundleHash: b.close.bundleHash,
      bundleJson: b.json,
      signature,
      lastDeskActionId: b.lastDeskActionId,
    });

    let request;
    try {
      ({ request } = await ctx.pub.simulateContract({ address: pc, abi: periodCloseAbi, functionName: "commit", args: [b.close, signature], account: ctx.controller, chain: ctx.chain }));
    } catch (e) {
      const r = decodeRejection(e);
      if (RETRYABLE.has(r.reason)) {
        await ctx.store.markStatus(id, "stale", r.reason);
        lastErr = r.reason;
        say(`period ${periodEnd}: chain moved (${r.reason}), rebuilding (attempt ${attempt}/${max})`);
        continue;
      }
      if (r.reason === "HoldAtClose") {
        await ctx.store.markStatus(id, "stale", r.reason);
        return { status: "hold", periodEnd, token: (r.args?.[0] as Address) ?? zeroAddress };
      }
      await ctx.store.markStatus(id, "failed", r.reason);
      return { status: "failed", periodEnd, error: r.reason };
    }

    const txHash = await ctx.wallet.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
    const rcpt = await ctx.pub.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") {
      await ctx.store.markStatus(id, "stale", "reverted on-chain after a passing simulation");
      lastErr = "reverted on-chain";
      continue;
    }
    let index = -1;
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== pc.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: periodCloseAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "PeriodClosed") index = Number(ev.args.index);
      } catch {
        // not ours
      }
    }
    await ctx.store.markCommitted(id, { txHash, blockNumber: rcpt.blockNumber, closeIndex: index });
    say(`period ${periodEnd}: committed close #${index} nav=${b.close.navUsd} bundle=${b.close.bundleHash} tx=${txHash}`);
    return { status: "committed", periodEnd, index, txHash, bundleHash: b.close.bundleHash, attempts: attempt };
  }
  return { status: "failed", periodEnd, error: `chain kept moving: ${lastErr}` };
}
