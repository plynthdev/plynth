// Source 3: sanctions. (a) The OFAC SDN list, free from the US Treasury, from which every EVM-format
// digital-currency address is extracted; refreshed daily, and the screen fails closed if the list is
// missing or older than MAX_LIST_AGE. (b) Optionally an on-chain oracle exposing isSanctioned(address)
// (the Chainalysis oracle interface) where one is deployed; it is not deployed on Robinhood Chain today.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, parseAbi, type Address, type PublicClient } from "viem";

export const SDN_URLS = [
  "https://www.treasury.gov/ofac/downloads/sdn.csv",
  "https://www.treasury.gov/ofac/downloads/sdn_comments.csv", // remarks that overflow sdn.csv
];
export const REFRESH_MS = 24 * 3600 * 1000;
export const MAX_LIST_AGE_MS = 48 * 3600 * 1000;

const DIGITAL_ADDRESS = /Digital Currency Address - ([A-Za-z0-9.\-]+)\s+(0x[0-9a-fA-F]{40})\b/g;

/** Lower-cased EVM addresses listed as "Digital Currency Address - <ticker> 0x…" anywhere in the text. */
export function extractSdnAddresses(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(DIGITAL_ADDRESS)) if (isAddress(m[2]!, { strict: false })) out.add(m[2]!.toLowerCase());
  return out;
}

type Fetcher = (url: string) => Promise<string>;
const httpFetch: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "plynth-eligibility/1 (sanctions screen)" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};

export class SanctionsList {
  private set = new Set<string>();
  updatedAt: number | null = null;

  constructor(
    private opts: { urls?: string[]; fetcher?: Fetcher; cachePath?: string; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  get size() {
    return this.set.size;
  }

  /** Replaces the list. An empty extraction is treated as a failed download, never as "nobody is listed". */
  load(addresses: Iterable<string>, at = this.now()) {
    const s = new Set([...addresses].map((a) => a.toLowerCase()));
    if (s.size === 0) throw new Error("sanctions list is empty");
    this.set = s;
    this.updatedAt = at;
  }

  /** Downloads every URL; keeps the previous list if anything fails. Returns the new size. */
  async refresh(): Promise<number> {
    const fetcher = this.opts.fetcher ?? httpFetch;
    const texts = await Promise.all((this.opts.urls ?? SDN_URLS).map((u) => fetcher(u)));
    const found = new Set<string>();
    for (const t of texts) for (const a of extractSdnAddresses(t)) found.add(a);
    this.load(found);
    if (this.opts.cachePath) {
      mkdirSync(dirname(this.opts.cachePath), { recursive: true });
      writeFileSync(this.opts.cachePath, JSON.stringify({ updatedAt: this.updatedAt, addresses: [...this.set].sort() }));
    }
    return this.set.size;
  }

  /** Loads the last saved list (so a restart within MAX_LIST_AGE does not need the network). */
  loadCache(): boolean {
    if (!this.opts.cachePath) return false;
    try {
      const j = JSON.parse(readFileSync(this.opts.cachePath, "utf8")) as { updatedAt: number; addresses: string[] };
      this.load(j.addresses, j.updatedAt);
      return true;
    } catch {
      return false;
    }
  }

  fresh(): boolean {
    return this.updatedAt !== null && this.now() - this.updatedAt <= MAX_LIST_AGE_MS;
  }

  has(address: string): boolean {
    return this.set.has(address.toLowerCase());
  }

  /** Daily refresh loop; failures are logged and retried next tick (the old list stays until it is stale). */
  start(log: (m: string) => void = console.log): () => void {
    const tick = () =>
      this.refresh().then(
        (n) => log(`[sanctions] ${n} addresses`),
        (e) => log(`[sanctions] refresh failed: ${(e as Error).message}`),
      );
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }
}

export const sanctionsOracleAbi = parseAbi(["function isSanctioned(address addr) view returns (bool)"]);

export type SanctionsResult = { ok: true } | { ok: false; reason: "sanctioned" | "sanctions_list_unavailable" };

export async function checkSanctions(opts: {
  address: Address;
  list: SanctionsList;
  oracle?: { pub: PublicClient; address: Address } | null | undefined;
}): Promise<SanctionsResult> {
  if (!opts.list.fresh()) return { ok: false, reason: "sanctions_list_unavailable" };
  if (opts.list.has(opts.address)) return { ok: false, reason: "sanctioned" };
  if (opts.oracle) {
    try {
      const hit = await opts.oracle.pub.readContract({
        address: opts.oracle.address,
        abi: sanctionsOracleAbi,
        functionName: "isSanctioned",
        args: [getAddress(opts.address)],
      });
      if (hit) return { ok: false, reason: "sanctioned" };
    } catch {
      return { ok: false, reason: "sanctions_list_unavailable" }; // configured but unreadable: fail closed
    }
  }
  return { ok: true };
}
