// Read-only token API as a plain fetch handler (Request -> Response) that the treasury API (todo 14) can mount
// under /token. Everything is read live from the chain; amounts are decimal strings (raw units).
//   GET /token/stakers/:address   stake, unbonding, tier and claimable rewards
//   GET /token/router             fee router state (next push time, carry, spot price)
//   GET /token/insurance          pool totals; /token/insurance/claims/:id one claim
import { isAddress, type Address, type PublicClient } from "viem";
import { CLAIM_STATUS, feeRouterAbi, insuranceAbi, stakingAbi } from "@/abi/treasury-token";

export type TokenAddresses = { staking: Address; feeRouter: Address; insurancePool: Address };

const PUSH_INTERVAL = 3600n;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });

export function tokenApi(pub: Pick<PublicClient, "readContract">, a: TokenAddresses, opts: { prefix?: string } = {}) {
  const prefix = opts.prefix ?? "/token";
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return json(404, { error: "not found" });
    const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean);

    if (parts[0] === "stakers" && parts.length === 2) {
      const who = parts[1]!;
      if (!isAddress(who)) return json(400, { error: "bad address" });
      const [staked, [active, pending, unbonding, releaseAt], tierIndex, tier, earned] = await Promise.all([
        read<bigint>(a.staking, stakingAbi, "stakedOf", [who]),
        read<readonly [bigint, bigint, bigint, bigint]>(a.staking, stakingAbi, "stakerOf", [who]),
        read<bigint>(a.staking, stakingAbi, "tierIndexOf", [who]),
        read<{ maxDesks: number; weeklyClose: boolean; privateSleeve: boolean; templatePriority: number }>(a.staking, stakingAbi, "tierOf", [who]),
        read<readonly [bigint, bigint]>(a.staking, stakingAbi, "earned", [who]),
      ]);
      return json(200, {
        address: who,
        staked,
        active,
        pending,
        unbonding,
        releaseAt: Number(releaseAt),
        tierIndex: Number(tierIndex),
        tier,
        earned: { usdg: earned[0], plth: earned[1] },
      });
    }

    if (parts[0] === "router" && parts.length === 1) {
      const [lastPush, buyCarry, perPushCap, maxSlippageBps, authorBps, spot] = await Promise.all([
        read<bigint>(a.feeRouter, feeRouterAbi, "lastPush"),
        read<bigint>(a.feeRouter, feeRouterAbi, "buyCarry"),
        read<bigint>(a.feeRouter, feeRouterAbi, "perPushCap"),
        read<number>(a.feeRouter, feeRouterAbi, "maxSlippageBps"),
        read<number>(a.feeRouter, feeRouterAbi, "authorBps"),
        read<bigint>(a.feeRouter, feeRouterAbi, "spotSqrtPriceX96"),
      ]);
      return json(200, {
        lastPush: Number(lastPush),
        nextPushAt: lastPush === 0n ? 0 : Number(lastPush + PUSH_INTERVAL),
        buyCarry,
        perPushCap,
        maxSlippageBps,
        authorBps,
        spotSqrtPriceX96: spot,
      });
    }

    if (parts[0] === "insurance" && parts.length === 1) {
      const [freeAssets, queuedOwed, activeShares, pendingAssets, queueLength, claimCount] = await Promise.all(
        ["freeAssets", "queuedOwed", "activeShares", "pendingAssets", "queueLength", "claimCount"].map((f) => read<bigint>(a.insurancePool, insuranceAbi, f)),
      );
      // Shares waiting to withdraw are burnt at the request (pendingAssets is what they are owed), so only
      // active shares count as depositors.
      return json(200, { freeAssets, queuedOwed, activeShares, pendingAssets, queueLength, claimCount, hasDepositors: activeShares! > 0n });
    }

    if (parts[0] === "insurance" && parts[1] === "claims" && parts.length === 3) {
      if (!/^\d+$/.test(parts[2]!)) return json(400, { error: "claim id must be a decimal number" });
      const id = BigInt(parts[2]!);
      const count = await read<bigint>(a.insurancePool, insuranceAbi, "claimCount");
      if (id >= count) return json(404, { error: "no claim" });
      const c = await read<{ status: number } & Record<string, unknown>>(a.insurancePool, insuranceAbi, "claim", [id]);
      return json(200, { id, ...c, filedAt: Number(c.filedAt as bigint), status: CLAIM_STATUS[c.status] ?? "unknown" });
    }

    return json(404, { error: "not found" });
  };
}
