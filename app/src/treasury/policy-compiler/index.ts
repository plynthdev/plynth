import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { contracts, stockTokens, usdg, type Network } from "@/chain";
import { buildTree, getProof, instrumentLeaf, venueLeaf, ZERO32 } from "./merkle";

export * from "./merkle";

// ------------------------------------------------------------------ the on-chain struct

export type Band = { minBps: number; maxBps: number };

/** Mirrors TreasuryPolicy.Policy field for field, in the same order. */
export type Policy = {
  cash: Band;
  equity: Band;
  basis: Band;
  netDeltaMinBps: number;
  netDeltaMaxBps: number;
  maxLeverageX10: number;
  perOrderCapUsd: bigint;
  perDayCapUsd: bigint;
  perNameFloatCapBps: number;
  perVenueCapBps: number;
  noNewRiskOffHours: boolean;
  pauseNewRiskAtDrawdownBps: number;
  deriskAtDrawdownBps: number;
  approvalAboveUsd: bigint;
  periodSeconds: number;
  instrumentAllowRoot: Hex;
  venueAllowRoot: Hex;
  controller: Address;
};

const BAND = { type: "tuple", components: [{ name: "minBps", type: "uint16" }, { name: "maxBps", type: "uint16" }] } as const;

export const policyAbiParam = {
  type: "tuple",
  components: [
    { name: "cash", ...BAND },
    { name: "equity", ...BAND },
    { name: "basis", ...BAND },
    { name: "netDeltaMinBps", type: "int16" },
    { name: "netDeltaMaxBps", type: "int16" },
    { name: "maxLeverageX10", type: "uint16" },
    { name: "perOrderCapUsd", type: "uint64" },
    { name: "perDayCapUsd", type: "uint64" },
    { name: "perNameFloatCapBps", type: "uint16" },
    { name: "perVenueCapBps", type: "uint16" },
    { name: "noNewRiskOffHours", type: "bool" },
    { name: "pauseNewRiskAtDrawdownBps", type: "int16" },
    { name: "deriskAtDrawdownBps", type: "int16" },
    { name: "approvalAboveUsd", type: "uint64" },
    { name: "periodSeconds", type: "uint32" },
    { name: "instrumentAllowRoot", type: "bytes32" },
    { name: "venueAllowRoot", type: "bytes32" },
    { name: "controller", type: "address" },
  ],
} as const;

/** keccak256(abi.encode(p)), the hash TreasuryPolicy stores and emits. */
export function policyHash(p: Policy): Hex {
  return keccak256(encodeAbiParameters([policyAbiParam], [p]));
}

// ------------------------------------------------------------------ validation (mirrors TreasuryPolicy.validate)

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const U16 = 0xffff;
/** TreasuryPolicy.MAX_LEVERAGE_X10: 3.0x, also the T2 default. */
export const MAX_LEVERAGE_X10 = 30;
const U32 = 0xffffffff;
const U64 = (1n << 64n) - 1n;

function int(name: string, v: number, lo: number, hi: number) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new PolicyError("OutOfRange", `${name} = ${v} not an integer in [${lo}, ${hi}]`);
}

/** Throws a PolicyError whose code equals the Solidity custom error TreasuryPolicy.validate would revert with. */
export function validate(p: Policy): void {
  for (const k of ["cash", "equity", "basis"] as const) {
    int(`${k}.minBps`, p[k].minBps, 0, U16);
    int(`${k}.maxBps`, p[k].maxBps, 0, U16);
  }
  int("netDeltaMinBps", p.netDeltaMinBps, -32768, 32767);
  int("netDeltaMaxBps", p.netDeltaMaxBps, -32768, 32767);
  int("maxLeverageX10", p.maxLeverageX10, 0, U16);
  int("perNameFloatCapBps", p.perNameFloatCapBps, 0, U16);
  int("perVenueCapBps", p.perVenueCapBps, 0, U16);
  int("pauseNewRiskAtDrawdownBps", p.pauseNewRiskAtDrawdownBps, -32768, 32767);
  int("deriskAtDrawdownBps", p.deriskAtDrawdownBps, -32768, 32767);
  int("periodSeconds", p.periodSeconds, 0, U32);
  for (const k of ["perOrderCapUsd", "perDayCapUsd", "approvalAboveUsd"] as const) {
    if (p[k] < 0n || p[k] > U64) throw new PolicyError("OutOfRange", `${k} out of uint64 range`);
  }

  for (const k of ["cash", "equity", "basis"] as const) {
    const b = p[k];
    if (b.minBps > b.maxBps || b.maxBps > 10_000) throw new PolicyError("BadBand", `${k} band ${b.minBps}..${b.maxBps}`);
  }
  const sumMin = p.cash.minBps + p.equity.minBps + p.basis.minBps;
  const sumMax = p.cash.maxBps + p.equity.maxBps + p.basis.maxBps;
  if (sumMin > 10_000 || sumMax < 10_000) {
    throw new PolicyError("BadBandSums", `band mins sum to ${sumMin} and maxes to ${sumMax}; need mins <= 10000 <= maxes`);
  }
  if (p.maxLeverageX10 === 0) {
    // T1: no overlay, no venues.
    if (p.basis.minBps !== 0 || p.basis.maxBps !== 0) throw new PolicyError("T1Basis", "basis band must be 0..0 in T1");
    if (p.netDeltaMinBps !== 0 || p.netDeltaMaxBps !== 0) throw new PolicyError("T1NetDelta", "net delta must be 0 in T1");
    if (p.perVenueCapBps !== 0 || BigInt(p.venueAllowRoot) !== 0n) throw new PolicyError("T1Venue", "no venues in T1");
  } else {
    // T2: hedge overlay and perp venues.
    if (p.maxLeverageX10 > MAX_LEVERAGE_X10) throw new PolicyError("LeverageTooHigh", `${p.maxLeverageX10 / 10}x > 3x`);
    if (p.netDeltaMinBps > p.netDeltaMaxBps || p.netDeltaMinBps < -10_000 || p.netDeltaMaxBps > 10_000) {
      throw new PolicyError("BadNetDelta", `net delta ${p.netDeltaMinBps}..${p.netDeltaMaxBps}`);
    }
    if (p.perVenueCapBps === 0 || p.perVenueCapBps > 10_000) throw new PolicyError("BadVenueCap", `per-venue cap ${p.perVenueCapBps}`);
    if (BigInt(p.venueAllowRoot) === 0n) throw new PolicyError("NoVenues", "T2 needs at least one allowed venue");
  }
  if (p.perNameFloatCapBps > 200) throw new PolicyError("FloatCapTooHigh", `${p.perNameFloatCapBps} > 200`);
  if (!(p.deriskAtDrawdownBps < p.pauseNewRiskAtDrawdownBps && p.pauseNewRiskAtDrawdownBps <= 0)) {
    throw new PolicyError("BadDrawdown", "need derisk < pause <= 0");
  }
  if (p.periodSeconds < 86_400) throw new PolicyError("BadPeriod", "period must be at least 1 day");
  if (BigInt(p.controller) === 0n) throw new PolicyError("ZeroAddress", "controller must be set");
}

// ------------------------------------------------------------------ templates

export const KINDS = { cash: 0, cash_vault: 1, stock_token: 2 } as const;
export type KindName = keyof typeof KINDS;

export type Template = {
  name: string;
  description?: string;
  extends?: string;
  network?: Network;
  bands: { cash: [number, number]; equity: [number, number]; basis?: [number, number] }; // percent of NAV
  hedge?: { netDeltaBps?: [number, number]; maxLeverageX10?: number };
  limits: { perOrderUsd: number; perDayUsd: number; approvalAboveUsd: number; perNameFloatBps: number; perVenueBps?: number };
  risk: { noNewRiskOffHours: boolean; pauseNewRiskAtDrawdownBps: number; deriskAtDrawdownBps: number };
  periodDays: number;
  controller?: string | null;
  instruments: { asset: string; kind: KindName }[];
  /** T2 only: venue adapter addresses (InHousePerpVenue / MirroredPerpVenue) allowed for new risk. */
  venues?: string[];
};

export type Instrument = { label: string; asset: Address; kind: number; kindName: KindName; leaf: Hex; proof: Hex[] };

export type Venue = { address: Address; leaf: Hex; proof: Hex[] };

export type Compiled = {
  name: string;
  description: string;
  network: Network;
  policy: Policy;
  hash: Hex;
  instruments: Instrument[];
  venues: Venue[];
};

/** Parses YAML and resolves `extends: other` (a sibling file other.yaml) by shallow top-level merge. */
export function loadTemplate(path: string, seen: string[] = []): Template {
  const abs = resolve(path);
  if (seen.includes(abs)) throw new Error(`extends cycle: ${[...seen, abs].join(" -> ")}`);
  const raw = Bun.YAML.parse(readFileSync(abs, "utf8")) as Partial<Template>;
  if (!raw || typeof raw !== "object") throw new Error(`${path}: not a YAML mapping`);
  if (!raw.extends) return raw as Template;
  const parentPath = resolve(dirname(abs), raw.extends.endsWith(".yaml") ? raw.extends : `${raw.extends}.yaml`);
  const parent = loadTemplate(parentPath, [...seen, abs]);
  const { extends: _drop, ...own } = raw;
  return { ...parent, ...own } as Template;
}

function pctToBps(name: string, pct: number): number {
  const bps = Math.round(pct * 100);
  if (typeof pct !== "number" || Math.abs(bps - pct * 100) > 1e-9) throw new PolicyError("OutOfRange", `${name}: ${pct}% is not a whole bps`);
  return bps;
}

/** Resolves a symbol (USDG, steakUSDG, TSLA, ...) or a literal address to a checksummed address. */
export function resolveAsset(asset: string, network: Network): { label: string; address: Address } {
  if (isAddress(asset, { strict: false })) return { label: getAddress(asset), address: getAddress(asset) };
  if (asset === "USDG") return { label: asset, address: getAddress(usdg[network]) };
  if (asset === "steakUSDG") {
    const a = contracts[network].steakhouseUsdgVault;
    if (!a) throw new Error(`steakUSDG does not exist on ${network}`);
    return { label: asset, address: getAddress(a) };
  }
  if (asset in stockTokens) {
    if (network !== "mainnet") throw new Error(`${asset}: Stock Tokens exist on mainnet only`);
    return { label: asset, address: getAddress(stockTokens[asset as keyof typeof stockTokens]) };
  }
  throw new Error(`unknown asset ${asset}`);
}

export type CompileOptions = { controller?: string; network?: Network };

export function compileTemplate(t: Template, opts: CompileOptions = {}): Compiled {
  const network: Network = opts.network ?? t.network ?? "mainnet";
  const controller = opts.controller ?? t.controller ?? undefined;
  if (!controller || !isAddress(controller, { strict: false })) throw new PolicyError("ZeroAddress", "controller missing: set it in the template or pass --controller");
  const venueList = (t.venues ?? []).map((v) => {
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new PolicyError("BadVenue", `venue ${JSON.stringify(v)} is not an address`);
    return getAddress(v);
  });
  // Venues only exist in T2 (maxLeverageX10 > 0); validate() names the rule.
  if (venueList.length > 0 && !(t.hedge?.maxLeverageX10 ?? 0)) throw new PolicyError("T1Venue", "no venues in T1");
  const venueTree = buildTree(venueList.map((v) => venueLeaf(v)));
  const venues: Venue[] = venueList.map((v) => ({ address: v, leaf: venueLeaf(v), proof: getProof(venueTree, venueLeaf(v)) }));

  const kinds = t.instruments.map((i) => {
    if (!(i.kind in KINDS)) throw new Error(`unknown instrument kind ${i.kind}`);
    const r = resolveAsset(i.asset, network);
    return { label: r.label, asset: r.address, kindName: i.kind, kind: KINDS[i.kind], leaf: instrumentLeaf(r.address, KINDS[i.kind]) };
  });
  const tree = buildTree(kinds.map((k) => k.leaf));
  const instruments: Instrument[] = kinds.map((k) => ({ ...k, proof: getProof(tree, k.leaf) }));

  const band = (name: string, b: [number, number] | undefined): Band => {
    const [lo, hi] = b ?? [0, 0];
    return { minBps: pctToBps(`${name}.min`, lo), maxBps: pctToBps(`${name}.max`, hi) };
  };
  const [dMin, dMax] = t.hedge?.netDeltaBps ?? [0, 0];
  const policy: Policy = {
    cash: band("cash", t.bands.cash),
    equity: band("equity", t.bands.equity),
    basis: band("basis", t.bands.basis),
    netDeltaMinBps: dMin,
    netDeltaMaxBps: dMax,
    maxLeverageX10: t.hedge?.maxLeverageX10 ?? 0,
    perOrderCapUsd: BigInt(t.limits.perOrderUsd),
    perDayCapUsd: BigInt(t.limits.perDayUsd),
    perNameFloatCapBps: t.limits.perNameFloatBps,
    perVenueCapBps: t.limits.perVenueBps ?? 0,
    noNewRiskOffHours: t.risk.noNewRiskOffHours,
    pauseNewRiskAtDrawdownBps: t.risk.pauseNewRiskAtDrawdownBps,
    deriskAtDrawdownBps: t.risk.deriskAtDrawdownBps,
    approvalAboveUsd: BigInt(t.limits.approvalAboveUsd),
    periodSeconds: Math.round(t.periodDays * 86_400),
    instrumentAllowRoot: tree.root,
    venueAllowRoot: venueTree.root,
    controller: getAddress(controller),
  };
  validate(policy);
  return { name: t.name, description: t.description ?? "", network, policy, hash: policyHash(policy), instruments, venues };
}

export function compileFile(path: string, opts: CompileOptions = {}): Compiled {
  return compileTemplate(loadTemplate(path), opts);
}

// ------------------------------------------------------------------ human-readable text

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const usd = (v: bigint) => `$${v.toLocaleString("en-US")}`;
const bandText = (b: Band) => `${pct(b.minBps)} to ${pct(b.maxBps)} of NAV`;
const periodText = (s: number) => (s % 86_400 === 0 ? `${s / 86_400} days` : `${s} seconds`);

/** One line per rule, in plain words. Keys are stable so diff can compare line by line. */
function lines(c: Compiled): [string, string][] {
  const p = c.policy;
  return [
    ["Cash", bandText(p.cash)],
    ["Equity", bandText(p.equity)],
    ["Basis", bandText(p.basis)],
    ["Net delta", `${pct(p.netDeltaMinBps)} to ${pct(p.netDeltaMaxBps)}`],
    ["Max leverage", p.maxLeverageX10 === 0 ? "none" : `${p.maxLeverageX10 / 10}x`],
    ["Per-order cap", usd(p.perOrderCapUsd)],
    ["Per-day cap", usd(p.perDayCapUsd)],
    ["Board approval above", usd(p.approvalAboveUsd)],
    ["Per-name float cap", `${pct(p.perNameFloatCapBps)} of a Stock Token's supply`],
    ["Per-venue cap", p.perVenueCapBps === 0 ? "no venues" : pct(p.perVenueCapBps)],
    ["New risk off-hours", p.noNewRiskOffHours ? "not allowed" : "allowed"],
    ["Pause new risk at drawdown", pct(p.pauseNewRiskAtDrawdownBps)],
    ["De-risk at drawdown", pct(p.deriskAtDrawdownBps)],
    ["Period", periodText(p.periodSeconds)],
    ["Controller", p.controller],
  ];
}

const instrumentText = (i: Instrument) => `${i.label} (${i.kindName.replace("_", " ")})`;

export function summary(c: Compiled): string {
  const out = [`Policy "${c.name}" on ${c.network}`];
  if (c.description) out.push(c.description.trim());
  for (const [k, v] of lines(c)) out.push(`  ${k}: ${v}`);
  out.push(`  Allowed instruments (${c.instruments.length}): ${c.instruments.map(instrumentText).join(", ")}`);
  out.push(`  Instrument root: ${c.policy.instrumentAllowRoot}`);
  out.push(`  Policy hash: ${c.hash}`);
  return out.join("\n");
}

/** What changes if `next` replaces `prev`, one line per changed rule. */
export function diff(prev: Compiled, next: Compiled): string {
  const out: string[] = [];
  const a = new Map(lines(prev));
  for (const [k, v] of lines(next)) {
    const old = a.get(k);
    if (old !== v) out.push(`~ ${k}: ${old} -> ${v}`);
  }
  const key = (i: Instrument) => `${i.asset.toLowerCase()}:${i.kind}`;
  const before = new Set(prev.instruments.map(key));
  const after = new Set(next.instruments.map(key));
  for (const i of next.instruments) if (!before.has(key(i))) out.push(`+ instrument ${instrumentText(i)}`);
  for (const i of prev.instruments) if (!after.has(key(i))) out.push(`- instrument ${instrumentText(i)}`);
  return out.length === 0 ? "No changes." : out.join("\n");
}
