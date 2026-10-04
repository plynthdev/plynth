import { contracts } from "@plynth/chain";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbiItem, type AbiEvent, type Address } from "viem";

export type ChainName = "mainnet" | "testnet" | "local";

export type Stream = {
  /** Unique, stable: it is the ev_cursors primary key. */
  name: string;
  chain: ChainName;
  address: Address;
  events: AbiEvent[];
  /** First block to scan. The cursor starts at fromBlock - 1. */
  fromBlock: bigint;
  /** Indexed-argument filter; only allowed with a single event. */
  args?: Record<string, unknown>;
};

const ev = (sigs: string[]): AbiEvent[] => sigs.map((s) => parseAbiItem(s) as AbiEvent);

const OWNABLE = ["event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"];

/** Events per deployments/<chainid>.json key. Signatures mirror contracts/src (checked by config.test.ts). */
export const DEPLOYMENT_EVENTS: Record<string, AbiEvent[]> = {
  stockTokenRegistry: ev([
    "event Listed(address indexed token, address indexed feed, bool multiplierEmbedded)",
    "event Delisted(address indexed token)",
    "event OwnershipTransferStarted(address indexed from, address indexed to)",
    "event OwnershipTransferred(address indexed from, address indexed to)",
  ]),
  stockRouter: ev([
    "event PoolSet(address indexed stockToken, bytes32 indexed poolId)",
    "event Bought(address indexed stockToken, address indexed payer, address indexed recipient, uint256 usdgIn, uint256 rawOut)",
    "event Sold(address indexed stockToken, address indexed payer, address indexed recipient, uint256 rawIn, uint256 usdgOut)",
    ...OWNABLE,
  ]),
  jitterBeacon: ev([
    "event KeeperSet(address indexed keeper)",
    "event Committed(bytes32 indexed key, uint64 windowStart, uint64 windowEnd, bytes32 commitment)",
    "event Revealed(bytes32 indexed key, bytes32 secret, uint64 executeAt)",
    ...OWNABLE,
  ]),
};

/** Mock Stock Tokens in the testnet kit announce multiplier changes. */
export const STOCK_TOKEN_EVENTS = ev(["event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier)"]);

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)") as AbiEvent;

export type Deployment = {
  chainId: number;
  deployBlock?: number | string;
  usdg?: string;
  stocks?: Record<string, { token: string }>;
  [k: string]: unknown;
};

export function readDeployment(dir: string, chainId: number): Deployment | undefined {
  const file = join(dir, `${chainId}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

export type ExtraStream = { name: string; address: string; events: string[]; fromBlock?: number | string; args?: Record<string, unknown> };

export type LoadOptions = {
  chain: ChainName;
  chainId: number;
  deploymentsDir?: string;
  /** Fallback fromBlock when the deployment file has no deployBlock. */
  fromBlock?: bigint;
  /** Linked wallets: index USDG Transfer in and out of each. */
  wallets?: string[];
  /** fromBlock for the wallet USDG streams. */
  walletsFromBlock?: bigint;
  extra?: ExtraStream[];
};

/** Streams = deployments/<chainid>.json contracts + static list (USDG Transfer for linked wallets) + extras. */
export function loadStreams(o: LoadOptions): Stream[] {
  const streams: Stream[] = [];
  const dep = o.deploymentsDir ? readDeployment(o.deploymentsDir, o.chainId) : undefined;
  const depFrom = dep?.deployBlock !== undefined ? BigInt(dep.deployBlock) : (o.fromBlock ?? 0n);
  const p = `${o.chainId}`;

  if (dep) {
    for (const [key, events] of Object.entries(DEPLOYMENT_EVENTS)) {
      const a = dep[key];
      if (typeof a !== "string") continue;
      streams.push({ name: `${p}:${key}`, chain: o.chain, address: getAddress(a), events, fromBlock: depFrom });
    }
    for (const [sym, s] of Object.entries(dep.stocks ?? {})) {
      streams.push({ name: `${p}:stock:${sym}`, chain: o.chain, address: getAddress(s.token), events: STOCK_TOKEN_EVENTS, fromBlock: depFrom });
    }
  }

  const usdg = dep?.usdg ?? (o.chain === "local" ? undefined : contracts[o.chain].usdg);
  if (usdg && o.wallets?.length) {
    const wallets = o.wallets.map((w) => getAddress(w));
    const from = o.walletsFromBlock ?? depFrom;
    streams.push({ name: `${p}:usdg:in`, chain: o.chain, address: getAddress(usdg), events: [TRANSFER_EVENT], fromBlock: from, args: { to: wallets } });
    streams.push({ name: `${p}:usdg:out`, chain: o.chain, address: getAddress(usdg), events: [TRANSFER_EVENT], fromBlock: from, args: { from: wallets } });
  }

  for (const x of o.extra ?? []) {
    streams.push({
      name: `${p}:${x.name}`,
      chain: o.chain,
      address: getAddress(x.address),
      events: ev(x.events),
      fromBlock: x.fromBlock !== undefined ? BigInt(x.fromBlock) : depFrom,
      args: x.args,
    });
  }

  const seen = new Set<string>();
  for (const s of streams) {
    if (seen.has(s.name)) throw new Error(`duplicate stream name ${s.name}`);
    seen.add(s.name);
    if (s.args && s.events.length !== 1) throw new Error(`stream ${s.name}: args filter needs exactly one event`);
  }
  return streams;
}
