// The eligibility service: runs the screens in order (cheapest first, first refusal wins), records the
// decision without the IP, and on a pass signs an EligibilityRegistry attestation valid for 30 days that
// anyone can submit on chain. Screens are pluggable: a paid KYC vendor later is one more Screen.
import { eligibilityDecisions, type Db } from "@/db";
import { getAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { checkIpCountry, type CountryLookup } from "./ipcountry";
import { checkSanctions, type SanctionsList } from "./sanctions";
import { checkSelfAttestation } from "./statement";

export const FLAG_SELF_ATTESTED = 1;
export const FLAG_IP_COUNTRY = 2;
export const FLAG_SANCTIONS = 4;
export const ATTESTATION_TTL_S = 30 * 24 * 3600;
/** issuedAt is backdated so a chain clock slightly behind ours still accepts it (issuedAt <= block.timestamp). */
export const CLOCK_SKEW_S = 60;

export type CheckRequest = {
  address: Address;
  /** The wallet's EIP-712 SelfAttestation signature and the expiry it signed. */
  attestationSig: Hex;
  statementExpiry: bigint;
  /** Client IP: used for the lookup only, never stored or logged. */
  ip: string | null;
  /** CF-IPCountry, only passed when the proxy is trusted. */
  cfCountry: string | null;
};

export type ScreenResult = { ok: true; flag: number; country?: string | null } | { ok: false; reason: string; country?: string | null };

export interface Screen {
  readonly name: string;
  run(req: CheckRequest, nowS: number): Promise<ScreenResult>;
}

export function selfAttestationScreen(chainId: number, pub?: PublicClient): Screen {
  return {
    name: "self_attestation",
    async run(req, nowS) {
      const r = await checkSelfAttestation({ chainId, wallet: req.address, expiry: req.statementExpiry, signature: req.attestationSig, nowS, pub });
      return r.ok ? { ok: true, flag: FLAG_SELF_ATTESTED } : r;
    },
  };
}

export function sanctionsScreen(list: SanctionsList, oracle?: { pub: PublicClient; address: Address } | null): Screen {
  return {
    name: "sanctions",
    async run(req) {
      const r = await checkSanctions({ address: req.address, list, oracle });
      return r.ok ? { ok: true, flag: FLAG_SANCTIONS } : r;
    },
  };
}

export function ipCountryScreen(lookup: CountryLookup | null, opts: { allowUnknown?: boolean | undefined } = {}): Screen {
  return {
    name: "ip_country",
    async run(req) {
      const r = checkIpCountry({ ip: req.ip, cfCountry: req.cfCountry, lookup, allowUnknown: opts.allowUnknown });
      // With allowUnknown (dev only) and no country, the IP check did not really pass: no flag.
      return r.ok ? { ok: true, flag: r.country ? FLAG_IP_COUNTRY : 0, country: r.country } : r;
    },
  };
}

export type Attestation = {
  chainId: number;
  registry: Address;
  user: Address;
  issuedAt: number;
  expiry: number;
  flags: number;
  signature: Hex;
};

export type Decision =
  | { allowed: true; reason: "ok"; country: string | null; flags: number; attestation: Attestation }
  | { allowed: false; reason: string; country: string | null; flags: number };

export type DecisionRow = { chainId: number; address: Address; allowed: boolean; reason: string; country: string | null; flags: number; expiry: number | null; at: number };

export interface DecisionStore {
  record(row: DecisionRow): Promise<void>;
}

export class MemoryDecisionStore implements DecisionStore {
  rows: DecisionRow[] = [];
  async record(row: DecisionRow) {
    this.rows.push(row);
  }
}

export class DbDecisionStore implements DecisionStore {
  constructor(private db: Db) {}
  async record(r: DecisionRow) {
    await this.db.insert(eligibilityDecisions).values({
      chainId: r.chainId,
      address: r.address.toLowerCase(),
      allowed: r.allowed,
      reason: r.reason,
      country: r.country,
      flags: r.flags,
      expiry: r.expiry === null ? null : new Date(r.expiry * 1000),
      createdAt: new Date(r.at * 1000),
    });
  }
}

export const attestationTypes = {
  Attestation: [
    { name: "user", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "flags", type: "uint32" },
  ],
} as const;

export function registryDomain(chainId: number, registry: Address) {
  return { name: "Plynth EligibilityRegistry", version: "1", chainId, verifyingContract: registry } as const;
}

export class EligibilityService {
  constructor(
    private cfg: {
      chainId: number;
      registry: Address;
      attester: LocalAccount;
      screens: Screen[];
      store: DecisionStore;
      nowS?: () => number;
    },
  ) {}

  private nowS() {
    return this.cfg.nowS ? this.cfg.nowS() : Math.floor(Date.now() / 1000);
  }

  async check(req: CheckRequest): Promise<Decision> {
    const nowS = this.nowS();
    const address = getAddress(req.address);
    let flags = 0;
    let country: string | null = null;
    let refused: string | null = null;
    for (const s of this.cfg.screens) {
      const r = await s.run({ ...req, address }, nowS);
      if (r.country !== undefined && r.country !== null) country = r.country;
      if (!r.ok) {
        refused = r.reason;
        break;
      }
      flags |= r.flag;
    }
    const base = { chainId: this.cfg.chainId, address, country, flags, at: nowS };
    if (refused) {
      await this.cfg.store.record({ ...base, allowed: false, reason: refused, expiry: null });
      return { allowed: false, reason: refused, country, flags };
    }
    const issuedAt = nowS - CLOCK_SKEW_S;
    const expiry = issuedAt + ATTESTATION_TTL_S;
    const signature = await this.cfg.attester.signTypedData({
      domain: registryDomain(this.cfg.chainId, this.cfg.registry),
      types: attestationTypes,
      primaryType: "Attestation",
      message: { user: address, issuedAt: BigInt(issuedAt), expiry: BigInt(expiry), flags },
    });
    await this.cfg.store.record({ ...base, allowed: true, reason: "ok", expiry });
    return {
      allowed: true,
      reason: "ok",
      country,
      flags,
      attestation: { chainId: this.cfg.chainId, registry: this.cfg.registry, user: address, issuedAt, expiry, flags, signature },
    };
  }
}
