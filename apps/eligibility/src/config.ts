// Builds the service from env, shared by `bun run eligibility` and the dashboard API (which mounts the
// same routes at /eligibility and /v1/eligibility when ELIGIBILITY_REGISTRY is set).
//
// ELIGIBILITY_REGISTRY        EligibilityRegistry address (required to enable the service)
// ELIGIBILITY_ATTESTER_KEY    attester signing key, or ELIGIBILITY_KEYSTORE + ELIGIBILITY_KEYSTORE_PASSWORD_FILE
// ELIGIBILITY_IP_DB           path to the MMDB country database (default ./data/dbip-country-lite.mmdb)
// ELIGIBILITY_SANCTIONS_CACHE path of the saved OFAC address list (default ./data/ofac-sdn-addresses.json)
// ELIGIBILITY_SANCTIONS_ORACLE optional isSanctioned(address) oracle; none exists on Robinhood Chain today
// ELIGIBILITY_TRUST_PROXY=1   honour CF-IPCountry / CF-Connecting-IP (only behind Cloudflare)
// ELIGIBILITY_ALLOW_UNKNOWN_IP=1  dev only: let IPs with no country through (no IP flag is set)
import { loadSigner } from "@plynth/keeper/src/signer";
import type { Db } from "@plynth/db";
import { existsSync } from "node:fs";
import { getAddress, isAddress, type PublicClient } from "viem";
import { eligibilityRoutes, RateLimiter } from "./app";
import { MmdbCountry } from "./ipcountry";
import { SanctionsList } from "./sanctions";
import { DbDecisionStore, EligibilityService, ipCountryScreen, MemoryDecisionStore, sanctionsScreen, selfAttestationScreen } from "./service";

type Env = Record<string, string | undefined>;

export function eligibilityFromEnv(env: Env, deps: { chainId: number; pub: PublicClient; db?: Db; log?: (m: string) => void }) {
  const log = deps.log ?? console.log;
  const reg = env.ELIGIBILITY_REGISTRY?.trim();
  if (!reg) return null;
  if (!isAddress(reg)) throw new Error("ELIGIBILITY_REGISTRY is not an address");
  const attester = (() => {
    try {
      return loadSigner({ KEEPER_PRIVATE_KEY: env.ELIGIBILITY_ATTESTER_KEY, KEEPER_KEYSTORE: env.ELIGIBILITY_KEYSTORE, KEEPER_KEYSTORE_PASSWORD_FILE: env.ELIGIBILITY_KEYSTORE_PASSWORD_FILE });
    } catch (err) {
      throw new Error(String((err as Error).message).replaceAll("KEEPER_PRIVATE_KEY", "ELIGIBILITY_ATTESTER_KEY").replaceAll("KEEPER_", "ELIGIBILITY_"));
    }
  })();

  const ipDb = env.ELIGIBILITY_IP_DB || "data/dbip-country-lite.mmdb";
  const lookup = existsSync(ipDb) ? MmdbCountry.fromFile(ipDb) : null;
  if (!lookup) log(`[eligibility] no IP database at ${ipDb}: run scripts/download-dbip.ts (until then only CF-IPCountry can pass)`);

  const list = new SanctionsList({ cachePath: env.ELIGIBILITY_SANCTIONS_CACHE || "data/ofac-sdn-addresses.json" });
  list.loadCache();
  const stop = list.start(log);
  const oracleAddr = env.ELIGIBILITY_SANCTIONS_ORACLE?.trim();
  const oracle = oracleAddr ? { pub: deps.pub, address: getAddress(oracleAddr) } : null;

  const service = new EligibilityService({
    chainId: deps.chainId,
    registry: getAddress(reg),
    attester,
    screens: [
      selfAttestationScreen(deps.chainId, deps.pub),
      sanctionsScreen(list, oracle),
      ipCountryScreen(lookup, { allowUnknown: env.ELIGIBILITY_ALLOW_UNKNOWN_IP === "1" }),
    ],
    store: deps.db ? new DbDecisionStore(deps.db) : new MemoryDecisionStore(),
  });
  const routes = eligibilityRoutes(service, {
    trustProxy: env.ELIGIBILITY_TRUST_PROXY === "1",
    perIp: new RateLimiter(Number(env.ELIGIBILITY_IP_LIMIT ?? 10), 60_000),
    perAddress: new RateLimiter(Number(env.ELIGIBILITY_ADDRESS_LIMIT ?? 5), 60_000),
  });
  return { service, routes, attester: attester.address, stop };
}
