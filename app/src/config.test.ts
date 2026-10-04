import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_KEYS, ConfigurationError, DEFAULT_PORTS, configValue, isSet, keysFor, loadConfig, namedSecret, rpcUrlFor, safeConfigSummary } from "./config";

const KEY = `0x${"ab".repeat(32)}`; // a repeated byte, not a real key

describe("loadConfig", () => {
  test("an empty environment is valid and every default is applied", () => {
    const c = loadConfig({});
    expect(c.DATABASE_URL).toBe("postgres://localhost:5432/plynth_dev");
    expect(c.API_CHAIN).toBe("local");
    expect(c.KEEPER_INTERVAL_MS).toBe(30_000);
    expect(c.SPLIT_PARTS).toBe(2);
    expect(c.INDEXER_WALLETS).toEqual([]);
    expect(c.RELAYER_TRUST_PROXY).toBe(false);
    expect(c.INDEXER_CONFIRMATIONS).toBeUndefined();
    expect(c.INDEXER_DEPLOYMENTS_DIR).toBe(join(import.meta.dir, "..", "deployments"));
  });

  test("blank values count as unset (so .env.example can list every variable empty)", () => {
    const c = loadConfig({ KEEPER_INTERVAL_MS: "", API_PORT: " ", ELIGIBILITY_REGISTRY: "", PLAID_ENV: "" });
    expect(c.KEEPER_INTERVAL_MS).toBe(30_000);
    expect(c.API_PORT).toBe(DEFAULT_PORTS.api);
    expect(c.ELIGIBILITY_REGISTRY).toBeUndefined();
    expect(c.PLAID_ENV).toBe("sandbox");
  });

  test("values are coerced: numbers, 0/1 flags, comma lists", () => {
    const c = loadConfig({ SPLIT_PARTS: "3", RELAYER_TRUST_PROXY: "1", INDEXER_WALLETS: " 0xa , ,0xb", TREASURY_JURY: "off", INDEXER_CONFIRMATIONS: "0" });
    expect(c.SPLIT_PARTS).toBe(3);
    expect(c.RELAYER_TRUST_PROXY).toBe(true);
    expect(c.INDEXER_WALLETS).toEqual(["0xa", "0xb"]);
    expect(c.TREASURY_JURY).toBe("off");
    expect(c.INDEXER_CONFIRMATIONS).toBe(0);
  });

  test("every bad value is reported at once, by name", () => {
    let err: unknown;
    try {
      loadConfig({ SPLIT_PARTS: "4", API_CHAIN: "goerli", ELIGIBILITY_REGISTRY: "0x12", API_PORT: "70000", MCP_TOKEN_SECRET: "short", RELAYER_TRUST_PROXY: "yes" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigurationError);
    const m = (err as Error).message;
    for (const k of ["SPLIT_PARTS", "API_CHAIN", "ELIGIBILITY_REGISTRY", "API_PORT", "MCP_TOKEN_SECRET", "RELAYER_TRUST_PROXY"]) expect(m).toContain(k);
  });

  test("private keys must be 32 bytes of hex", () => {
    expect(() => loadConfig({ KEEPER_PRIVATE_KEY: "0x1234" })).toThrow(/KEEPER_PRIVATE_KEY/);
    expect(loadConfig({ KEEPER_PRIVATE_KEY: KEY }).KEEPER_PRIVATE_KEY).toBe(KEY);
  });

  test("config.env holds the same validated values as strings, defaults included", () => {
    const c = loadConfig({ RELAYER_TRUST_PROXY: "1", INDEXER_WALLETS: "a, b" });
    expect(c.env.RELAYER_TRUST_PROXY).toBe("1");
    expect(c.env.ELIGIBILITY_TRUST_PROXY).toBe("0");
    expect(c.env.INDEXER_WALLETS).toBe("a,b");
    expect(c.env.ELIGIBILITY_IP_LIMIT).toBe("10");
    expect(c.env.KEEPER_PRIVATE_KEY).toBeUndefined();
  });

  test("the result is frozen", () => {
    const c = loadConfig({});
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.env)).toBe(true);
  });
});

describe("ports", () => {
  test("every service has its own default port", () => {
    const ports = Object.values(DEFAULT_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
    const c = loadConfig({});
    expect([c.INDEXER_PORT, c.KEEPER_PORT, c.API_PORT, c.ELIGIBILITY_PORT, c.RELAYER_PORT, c.MCP_PORT]).toEqual([8787, 8788, 8789, 8790, 8791, 8792]);
    const treasury = [c.TREASURY_DESKS_PORT, c.TREASURY_CLOSE_PORT, c.TREASURY_RISK_PORT, c.TREASURY_RECEIPTS_PORT, c.TREASURY_MARKS_PORT, c.TREASURY_RECONCILER_PORT, c.TREASURY_WEBHOOKS_PORT];
    expect(treasury).toEqual([8793, 8794, 8795, 8796, 8797, 8798, 8799]);
  });
});

describe("helpers", () => {
  test("configValue validates one variable and applies its default", () => {
    expect(configValue("DATABASE_URL", {})).toBe("postgres://localhost:5432/plynth_dev");
    expect(configValue("SPLIT_PARTS", { SPLIT_PARTS: "1" })).toBe(1);
    expect(() => configValue("SPLIT_PARTS", { SPLIT_PARTS: "9" })).toThrow(ConfigurationError);
  });

  test("isSet tells an explicit value from a default", () => {
    expect(isSet("DATABASE_URL", {})).toBe(false);
    expect(isSet("DATABASE_URL", { DATABASE_URL: " " })).toBe(false);
    expect(isSet("DATABASE_URL", { DATABASE_URL: "postgres://h/db" })).toBe(true);
  });

  test("rpcUrlFor picks the URL of the named chain", () => {
    const c = loadConfig({ LOCAL_RPC_URL: "http://127.0.0.1:9545" });
    expect(rpcUrlFor(c, "local")).toBe("http://127.0.0.1:9545");
    expect(rpcUrlFor(c, "testnet")).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(rpcUrlFor(c, "mainnet")).toBe("https://rpc.mainnet.chain.robinhood.com");
  });

  test("namedSecret reads an operator-named variable and refuses odd names", () => {
    expect(namedSecret("HOOK_SECRET", { HOOK_SECRET: " s " })).toBe("s");
    expect(namedSecret("HOOK_SECRET", { HOOK_SECRET: "" })).toBeUndefined();
    expect(() => namedSecret("a b", {})).toThrow(ConfigurationError);
  });

  test("safeConfigSummary never shows keys, secrets, tokens, passwords or URLs", () => {
    const c = loadConfig({
      KEEPER_PRIVATE_KEY: KEY,
      KEEPER_SECRET_KEY: "s3cret",
      DATABASE_URL: "postgres://user:pw@db/plynth",
      RHC_MAINNET_RPC_URL: "https://x.example/v2/apikey",
      TREASURY_CASH_DESK_KEYSTORE_PASSWORD: "pw",
      PLAID_SECRET: "plaid",
      MCP_TOKEN_SECRET: "m".repeat(32),
      KEEPER_KEYSTORE_PASSWORD_FILE: "/run/pw",
    });
    const s = JSON.stringify(safeConfigSummary(c));
    for (const secret of [KEY, "s3cret", "user:pw", "apikey", "\"pw\"", "plaid\"", "mmmm"]) expect(s).not.toContain(secret);
    expect(s).toContain("/run/pw"); // a file path is not the secret
    expect(safeConfigSummary(c).KEEPER_INTERVAL_MS).toBe(30_000);
  });

  test("keysFor selects one service's variables", () => {
    expect(keysFor("RELAYER_")).toContain("RELAYER_PORT");
    expect(keysFor("RELAYER_").every((k) => k.startsWith("RELAYER_"))).toBe(true);
  });
});

test(".env.example lists every variable exactly once", () => {
  const text = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
  const names = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
  expect(new Set(names).size).toBe(names.length);
  for (const k of CONFIG_KEYS.filter((k) => k !== "PLYNTH_TEST_DB_PREFIX")) expect(names).toContain(k);
  for (const n of names) expect(CONFIG_KEYS as string[]).toContain(n);
  // and the example itself is a valid configuration
  const values = Object.fromEntries([...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]));
  expect(() => loadConfig(values)).not.toThrow();
});

test("no process.env reads in app/src outside config.ts (tests excepted)", () => {
  const glob = new Bun.Glob("**/*.ts");
  const offenders: string[] = [];
  for (const f of glob.scanSync(import.meta.dir)) {
    if (f === "config.ts" || f.endsWith(".test.ts")) continue;
    if (/process\.env(\.|\[)/.test(readFileSync(join(import.meta.dir, f), "utf8"))) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
