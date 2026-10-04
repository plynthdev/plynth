// The close bundle: everything behind one period statement, as canonical JSON. Its keccak256 is the
// `bundleHash` the controller signs and PeriodClose stores. Canonical = keys sorted at every level, no
// whitespace, bigints as decimal strings, addresses lower-case. Anyone holding the JSON can re-derive the hash
// and the positions hash and compare both with the on-chain event.
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";

export const BUNDLE_SCHEMA = "plynth.close.bundle/1";

export type BundlePosition = {
  asset: string;
  symbol: string;
  kind: number; // 0 cash, 1 cash vault, 2 Stock Token
  band: number; // 0 cash, 1 equity
  decimals: number;
  raw: string;
  price: string; // USD 1e18 per whole token
  multiplier: string; // 1e18
  roundId: string;
  usd: string; // raw x price / 10^decimals (display; NAV is the on-chain figure)
  weightBps: number;
};

export type BundleDeskAction = {
  id: number;
  desk: string;
  action: string;
  status: string;
  reasonCode: number | null;
  reason: string | null;
  asset: string | null;
  amount: string | null;
  notionalUsd: string | null;
  txHash: string | null;
  at: string;
};

export type Bundle = {
  schema: typeof BUNDLE_SCHEMA;
  chainId: number;
  periodClose: string;
  account: string;
  closeIndex: number;
  periodStart: number;
  periodEnd: number;
  navUsd: string;
  cashBps: number;
  equityBps: number;
  positionsHash: string;
  policy: { hash: string; version: number };
  positions: BundlePosition[];
  deskActions: BundleDeskAction[];
  guardDenials: BundleDeskAction[];
  deskActionRange: { afterId: number; toId: number };
  fee: { bps: number; recipient: string };
  preview: { block: string; timestamp: number };
};

function sortDeep(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, sortDeep(o[k])]),
    );
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

export const bundleHashOf = (json: string): Hex => keccak256(toBytes(json));

const POSITIONS_PARAM = [
  {
    type: "tuple[]",
    components: [
      { name: "asset", type: "address" },
      { name: "raw", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "multiplier", type: "uint256" },
      { name: "roundId", type: "uint80" },
    ],
  },
] as const;

export type OnchainPosition = { asset: Address; raw: bigint; price: bigint; multiplier: bigint; roundId: bigint };

/** Same as PeriodClose: keccak256(abi.encode(Position[])) in ascending address order. */
export function positionsHashOf(positions: readonly OnchainPosition[]): Hex {
  const sorted = [...positions].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : BigInt(a.asset) > BigInt(b.asset) ? 1 : 0));
  return keccak256(encodeAbiParameters(POSITIONS_PARAM, [sorted]));
}

export function bundlePositionsHash(b: Pick<Bundle, "positions">): Hex {
  return positionsHashOf(
    b.positions.map((p) => ({ asset: p.asset as Address, raw: BigInt(p.raw), price: BigInt(p.price), multiplier: BigInt(p.multiplier), roundId: BigInt(p.roundId) })),
  );
}
