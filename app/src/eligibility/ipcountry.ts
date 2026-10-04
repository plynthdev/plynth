// Source 2: IP country. Reads a MaxMind-format (MMDB) country database; the default is db-ip.com's free
// "IP to Country Lite" (CC BY 4.0), fetched by scripts/download-dbip.ts. When the service runs behind
// Cloudflare and TRUST_PROXY is on, Cloudflare's CF-IPCountry header is honoured as well (either source
// naming a restricted country refuses). The IP itself is used for the lookup and never stored.
import { readFileSync } from "node:fs";
import { Reader, type CountryResponse } from "mmdb-lib";
import { isBlockedCountry, normCountry } from "./countries";

export interface CountryLookup {
  /** ISO alpha-2 or null when the IP is not in the database (private ranges, unknown). */
  country(ip: string): string | null;
}

type CountryRecord = CountryResponse;

export class MmdbCountry implements CountryLookup {
  private reader: Reader<CountryRecord>;
  readonly databaseType: string;
  readonly buildEpoch: Date;

  constructor(db: Buffer) {
    this.reader = new Reader<CountryRecord>(db);
    this.databaseType = this.reader.metadata.databaseType;
    this.buildEpoch = this.reader.metadata.buildEpoch;
  }

  static fromFile(path: string): MmdbCountry {
    return new MmdbCountry(readFileSync(path));
  }

  country(ip: string): string | null {
    try {
      const r = this.reader.get(ip);
      return normCountry(r?.country?.iso_code ?? r?.registered_country?.iso_code ?? null);
    } catch {
      return null; // not an IP address
    }
  }
}

export type IpCountryResult =
  | { ok: true; country: string | null } // null only with allowUnknown
  | { ok: false; reason: "ip_country_restricted" | "ip_country_unknown"; country: string | null };

/**
 * Both sources are consulted; a restricted country from either refuses. No country at all refuses too
 * (fail closed) unless allowUnknown is set, which is meant for local development only.
 */
export function checkIpCountry(opts: {
  ip: string | null;
  cfCountry: string | null;
  lookup: CountryLookup | null;
  allowUnknown?: boolean | undefined;
}): IpCountryResult {
  const fromDb = opts.ip && opts.lookup ? opts.lookup.country(opts.ip) : null;
  const fromCf = normCountry(opts.cfCountry);
  for (const c of [fromCf, fromDb]) if (isBlockedCountry(c)) return { ok: false, reason: "ip_country_restricted", country: c };
  const country = fromCf ?? fromDb;
  if (country) return { ok: true, country };
  if (opts.allowUnknown) return { ok: true, country: null };
  return { ok: false, reason: "ip_country_unknown", country: null };
}
