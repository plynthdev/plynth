// End to end against anvil + Postgres: the service screens a wallet, signs, a third party submits the
// attestation to the real EligibilityRegistry, the wallet becomes eligible; the decision row has no IP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eligibilityDecisions } from "@/db";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { apiTestDb } from "@/testing/api-fixture";
import { ANVIL_KEY_0, ANVIL_KEY_1, ROOT, startAnvil } from "@/testing/keeper-helpers";
import {
  DbDecisionStore,
  EligibilityService,
  extractSdnAddresses,
  ipCountryScreen,
  MmdbCountry,
  SanctionsList,
  sanctionsScreen,
  selfAttestationScreen,
  selfAttestationTypedData,
} from "./";
import { buildCountryMmdb } from "@/testing/mmdb-writer";

const ATTESTER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // test-key
const USER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // test-key
const ART = join(ROOT, "contracts", "out", "EligibilityRegistry.sol", "EligibilityRegistry.json");

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let db: Awaited<ReturnType<typeof apiTestDb>>;
let pub: PublicClient;
let registry: Address;
let abi: Abi;

beforeAll(async () => {
  if (!existsSync(ART)) {
    const p = Bun.spawn(["forge", "build", "--root", "contracts"], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error("forge build failed");
  }
  const art = JSON.parse(readFileSync(ART, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  abi = art.abi;
  anvil = await startAnvil();
  db = await apiTestDb("elig");
  pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 20 }) as PublicClient;
  const deployer = privateKeyToAccount(ANVIL_KEY_0);
  const wc = createWalletClient({ account: deployer, transport: http(anvil.rpc) });
  const attester = privateKeyToAccount(ATTESTER_KEY);
  const hash = await wc.deployContract({ abi, bytecode: art.bytecode.object, args: [deployer.address, attester.address], chain: null });
  registry = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}, 180_000);

afterAll(async () => {
  await anvil?.stop();
  await db?.drop();
});

describe("eligibility e2e (anvil + postgres)", () => {
  test("screen -> sign -> anyone submits -> isEligible; refused wallets get nothing; rows hold no IP", async () => {
    const chainId = await pub.getChainId();
    const user = privateKeyToAccount(USER_KEY);
    const now = Number((await pub.getBlock()).timestamp);
    const list = new SanctionsList();
    list.load(extractSdnAddresses(readFileSync(join(import.meta.dir, "..", "testing", "fixtures", "eligibility", "sdn-sample.csv"), "utf8")));
    const svc = new EligibilityService({
      chainId,
      registry,
      attester: privateKeyToAccount(ATTESTER_KEY),
      screens: [selfAttestationScreen(chainId, pub), sanctionsScreen(list), ipCountryScreen(new MmdbCountry(buildCountryMmdb({ "203.0.113.0/24": "DE", "198.51.100.0/24": "CA" })))],
      store: new DbDecisionStore(db.db),
      nowS: () => now,
    });
    const expiry = BigInt(now + 86_400);
    const sig = await user.signTypedData(selfAttestationTypedData(chainId, user.address, expiry));

    const refused = await svc.check({ address: user.address, attestationSig: sig, statementExpiry: expiry, ip: "198.51.100.4", cfCountry: null });
    expect(refused).toMatchObject({ allowed: false, reason: "ip_country_restricted" });

    const d = await svc.check({ address: user.address, attestationSig: sig, statementExpiry: expiry, ip: "203.0.113.4", cfCountry: null });
    if (!d.allowed) throw new Error(`refused: ${d.reason}`);
    const a = d.attestation;

    const read = (fn: string, args: unknown[]) => pub.readContract({ address: registry, abi, functionName: fn, args });
    expect(await read("isEligible", [user.address])).toBe(false);
    const relayer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY_1), transport: http(anvil.rpc) });
    const tx = await relayer.writeContract({ address: registry, abi, functionName: "attest", args: [a.user, BigInt(a.issuedAt), BigInt(a.expiry), a.flags, a.signature], chain: null });
    expect((await pub.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
    expect(await read("isEligible", [user.address])).toBe(true);
    expect(((await read("recordOf", [user.address])) as any).flags).toBe(7);

    const rows = await db.db.select().from(eligibilityDecisions);
    expect(rows.map((r) => [r.address, r.allowed, r.reason, r.country])).toEqual([
      [user.address.toLowerCase(), false, "ip_country_restricted", "CA"],
      [user.address.toLowerCase(), true, "ok", "DE"],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["address", "allowed", "chainId", "country", "createdAt", "expiry", "flags", "id", "reason"]);
    expect(JSON.stringify(rows)).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect(rows[1]!.expiry!.getTime()).toBe(a.expiry * 1000);
  }, 60_000);
});
