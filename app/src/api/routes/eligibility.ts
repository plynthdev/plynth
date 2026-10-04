// meta.eligibility: a STUB, not KYC. It reads two headers and nothing else:
//   x-plynth-residency  the user's self-attested country of residence (ISO 3166-1 alpha-2), set by the frontend
//                       after the user ticks the attestation box;
//   cf-ipcountry        the country a proxy such as Cloudflare derived from the IP, if a proxy set it.
// Stock Tokens are not offered to US, UK, Canadian or Swiss persons, so those four are blocked either way.
// Real screening (signed self-attestation, IP database, OFAC list) is POST /v1/eligibility/check from
// @plynth/eligibility; it signs an attestation for the on-chain EligibilityRegistry that gates buying.

export const BLOCKED_COUNTRIES = ["US", "GB", "CA", "CH"] as const;

export type Eligibility = {
  allowed: boolean;
  reason: "ok" | "self_attestation_required" | "residency_restricted" | "ip_country_restricted";
  residency: string | null;
  ipCountry: string | null;
  kyc: false;
  note: string;
};

const NOTE = "Stub: self-attestation plus an IP-country header if present. This is not KYC.";

export function normCountry(v: string | null | undefined): string | null {
  if (!v) return null;
  const c = v.trim().toUpperCase();
  if (c === "UK") return "GB";
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

export function eligibility(headers: Headers): Eligibility {
  const residency = normCountry(headers.get("x-plynth-residency"));
  const ipCountry = normCountry(headers.get("cf-ipcountry"));
  const blocked = (c: string | null) => c !== null && (BLOCKED_COUNTRIES as readonly string[]).includes(c);
  const base = { residency, ipCountry, kyc: false as const, note: NOTE };
  if (blocked(ipCountry)) return { allowed: false, reason: "ip_country_restricted", ...base };
  if (!residency) return { allowed: false, reason: "self_attestation_required", ...base };
  if (blocked(residency)) return { allowed: false, reason: "residency_restricted", ...base };
  return { allowed: true, reason: "ok", ...base };
}
