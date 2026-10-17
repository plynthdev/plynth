// Audit (privileged / ops): every service ran as one Unix user with one env file, so any one compromised service had
// every secret (the keeper's sealing key, the MCP HMAC key) and could read every keystore. Now each service has its
// own user and env file. These checks run the real split-env.sh on env.example and read the systemd units.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "server");
const unit = (name: string) => readFileSync(join(SERVER, "systemd", `plynth-${name}.service`), "utf8");
const keys = (text: string) => new Set(text.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.slice(0, l.indexOf("="))));

function split(): Record<string, Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), "plynth-split-"));
  const r = Bun.spawnSync(["bash", join(SERVER, "split-env.sh"), join(SERVER, "env.example"), dir], { stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(r.stderr.toString()).not.toContain("no rule"); // every variable env.example ships has a home
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".env")).map((f) => [f.replace(/\.env$/, ""), keys(readFileSync(join(dir, f), "utf8"))]));
}

describe("one Unix user and one env file per service", () => {
  test("split-env.sh: each secret goes only to the services that use it; nothing is dropped", () => {
    const f = split();
    expect(Object.keys(f).sort()).toEqual(["api", "common", "eligibility", "indexer", "keeper", "mcp", "relayer", "treasury", "treasury-ro"]);
    const holders = (k: string) => Object.entries(f).filter(([, s]) => s.has(k)).map(([n]) => n).sort();
    expect(holders("KEEPER_SECRET_KEY")).toEqual(["api", "keeper"]);
    expect(holders("KEEPER_KEYSTORE")).toEqual(["keeper"]);
    expect(holders("KEEPER_KEYSTORE_PASSWORD_FILE")).toEqual(["keeper"]);
    expect(holders("RELAYER_KEYSTORE")).toEqual(["relayer"]);
    expect(holders("MCP_TOKEN_SECRET")).toEqual(["api", "mcp"]);
    expect(holders("ELIGIBILITY_KEYSTORE")).toEqual(["api", "eligibility"]);
    expect(holders("TREASURY_CONTROLLER_KEYSTORE")).toEqual(["treasury"]);
    // review v2 V2-L23: webhooks and marks get the treasury settings without any signing material
    for (const k of f["treasury-ro"]!) expect(k).not.toMatch(/_KEY$|_KEYSTORE$|_KEYSTORE_PASSWORD$|_KEYSTORE_PASSWORD_FILE$|^RISK_|^ORDERLY_/);
    for (const k of ["TREASURY_RPC_URL", "TREASURY_WEBHOOK_INTERVAL_S", "TREASURY_MARK_INTERVAL_S", "TREASURY_FACTORY"]) expect(holders(k), k).toContain("treasury-ro");
    expect(holders("CORS_ORIGINS")).toEqual(["api", "relayer"]);
    expect(holders("RHC_MAINNET_RPC_URL")).toEqual(["common"]);
    // the common file carries no secret at all
    for (const k of f.common!) expect(k).not.toMatch(/SECRET|KEY|PASSWORD|KEYSTORE|TOKEN/);
    // every variable of env.example lands somewhere
    const all = keys(readFileSync(join(SERVER, "env.example"), "utf8"));
    for (const k of all) expect(holders(k).length, k).toBeGreaterThan(0);
  });

  test("the live server's old single file: split once, then new settings and the relayer's blank fee tables are filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-old-"));
    const example = readFileSync(join(SERVER, "env.example"), "utf8");
    // what a server provisioned before this release has: no RELAYER_CLAIM_MIN_RAW / API_TRUST_PROXY, a blank fee table
    const old = example
      .split("\n")
      .filter((l) => !/^(RELAYER_CLAIM_MIN_RAW|API_TRUST_PROXY)=/.test(l))
      .map((l) => (l.startsWith("RELAYER_WITHDRAW_MIN_FEES=") ? "RELAYER_WITHDRAW_MIN_FEES=" : l.startsWith("CORS_ORIGINS=") ? "CORS_ORIGINS=https://kept.example" : l))
      .join("\n");
    Bun.write(join(dir, "plynth.env"), old);
    const run = (...a: string[]) => Bun.spawnSync(["bash", join(SERVER, "split-env.sh"), ...a], { stdout: "pipe", stderr: "pipe" });
    expect(run(join(dir, "plynth.env"), join(dir, "env")).exitCode).toBe(0);
    const add = run("--add-missing", join(SERVER, "env.example"), join(dir, "env"));
    expect(add.exitCode).toBe(0);
    const out = add.stdout.toString();
    expect(out).toContain("added RELAYER_CLAIM_MIN_RAW to relayer.env");
    expect(out).toContain("added API_TRUST_PROXY to api.env");
    expect(out).toContain("filled the blank RELAYER_WITHDRAW_MIN_FEES in relayer.env");
    expect(out).not.toMatch(/0x[0-9a-fA-F]{40}/); // never prints values
    const relayer = readFileSync(join(dir, "env", "relayer.env"), "utf8");
    expect(relayer).toMatch(/^RELAYER_WITHDRAW_MIN_FEES=0x/m);
    expect(relayer).toContain("CORS_ORIGINS=https://kept.example"); // existing values are never changed
    expect(run("--add-missing", join(SERVER, "env.example"), join(dir, "env")).stdout.toString()).toBe(""); // idempotent
  });

  test("systemd: each service has its own user, its own env file only, and no access to other services' keys", () => {
    const want: Record<string, { user: string; env: string; db: boolean; keys: boolean }> = {
      indexer: { user: "plynth-indexer", env: "indexer", db: true, keys: false },
      keeper: { user: "plynth-keeper", env: "keeper", db: true, keys: true },
      api: { user: "plynth-api", env: "api", db: true, keys: true },
      eligibility: { user: "plynth-eligibility", env: "eligibility", db: true, keys: true },
      relayer: { user: "plynth-relayer", env: "relayer", db: false, keys: true },
      mcp: { user: "plynth-mcp", env: "mcp", db: true, keys: false },
      ipdb: { user: "plynth-eligibility", env: "eligibility", db: false, keys: false },
      ...Object.fromEntries(["close", "desks", "receipts", "reconciler", "risk"].map((t) => [`treasury-${t}`, { user: "plynth-treasury", env: "treasury", db: true, keys: true }])),
      // review v2 V2-L23: they sign nothing (webhooks fetches customer URLs): own users, no keys, no signing settings
      "treasury-webhooks": { user: "plynth-webhooks", env: "treasury-ro", db: true, keys: false },
      "treasury-marks": { user: "plynth-marks", env: "treasury-ro", db: true, keys: false },
    };
    const users = new Set<string>();
    for (const [name, w] of Object.entries(want)) {
      const u = unit(name);
      expect(u, name).toContain(`\nUser=${w.user}\n`);
      users.add(w.user);
      const envs = u.split("\n").filter((l) => l.startsWith("EnvironmentFile=")).map((l) => l.slice("EnvironmentFile=".length));
      expect(envs, name).not.toContain("/etc/plynth/plynth.env"); // the old file with every secret
      const own = envs.filter((e) => e.startsWith("/etc/plynth/env/"));
      expect(own.sort(), name).toEqual(["/etc/plynth/env/common.env", `/etc/plynth/env/${w.env}.env`].sort());
      expect(envs.includes("/etc/plynth/db.env"), name).toBe(w.db);
      if (!w.keys) expect(u, name).toContain("InaccessiblePaths=-/etc/plynth/keys");
      expect(u, name).toContain("ProtectSystem=strict");
    }
    expect(users.size).toBe(9);
    for (const n of ["treasury-webhooks", "treasury-marks"]) expect(unit(n), n).not.toContain("SupplementaryGroups=plynth"); // group plynth traverses /etc/plynth/keys
    // migrations run as the code owner with the database URL and no service secrets
    const m = unit("migrate");
    expect(m).toContain("\nUser=plynth\n");
    expect(m).not.toMatch(/EnvironmentFile=\/etc\/plynth\/env\/(keeper|api|relayer|mcp|treasury|eligibility)\.env/);
  });

  test("V2-L23: a server split before treasury-ro existed gets it from treasury.env, without signing material", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-ro-"));
    const run = (...a: string[]) => Bun.spawnSync(["bash", join(SERVER, "split-env.sh"), ...a], { stdout: "pipe", stderr: "pipe" });
    expect(run(join(SERVER, "env.example"), join(dir, "env")).exitCode).toBe(0);
    const { rmSync, appendFileSync } = require("node:fs") as typeof import("node:fs");
    rmSync(join(dir, "env", "treasury-ro.env"));
    appendFileSync(join(dir, "env", "treasury.env"), "TREASURY_CASH_DESK_KEY=0xabc\nTREASURY_MARK_INTERVAL_S=77\n");
    const add = run("--add-missing", join(SERVER, "env.example"), join(dir, "env"));
    expect(add.exitCode, add.stderr.toString()).toBe(0);
    expect(add.stdout.toString()).toContain("wrote treasury-ro.env from treasury.env");
    const ro = readFileSync(join(dir, "env", "treasury-ro.env"), "utf8");
    expect(ro).toContain("TREASURY_MARK_INTERVAL_S=77"); // the server's own values
    expect(ro).not.toMatch(/KEYSTORE|_KEY=|^RISK_/m);
    expect(run("--add-missing", join(SERVER, "env.example"), join(dir, "env")).stdout.toString()).toBe(""); // idempotent
  });

  test("V2-L23: provision's key catch-all fails closed (an unknown file goes to no service)", () => {
    const p = readFileSync(join(SERVER, "provision.sh"), "utf8");
    expect(p).not.toMatch(/\*\) g=plynth-treasury ;;/);
    expect(p).toMatch(/plynth-main-controller \| controller\.password \| plynth-desk-\* \| desk-\*\.password\) g=plynth-treasury/);
    const fallback = p.slice(p.indexOf("plynth-desk-*"), p.indexOf("esac", p.indexOf("plynth-desk-*")));
    expect(fallback).toContain("chown root:root");
    expect(fallback).toContain("chmod 0400");
    expect(p).toMatch(/SERVICE_USERS=\(.*plynth-webhooks plynth-marks\)/);
    expect(readFileSync(join(SERVER, "deploy.sh"), "utf8")).toMatch(/for other in .*plynth-webhooks plynth-marks; do/);
  });

  test("provision.sh gives each key file to the service that signs with it", () => {
    const p = readFileSync(join(SERVER, "provision.sh"), "utf8");
    expect(p).toMatch(/plynth-main-keeper \| keeper\.password\) g=plynth-keeper/);
    expect(p).toMatch(/plynth-main-relayer \| relayer\.password\) g=plynth-relayer/);
    expect(p).toMatch(/plynth-main-attester \| attester\.password\) g=plynth-screening/);
    expect(p).toContain('bash "$HERE/split-env.sh" /etc/plynth/plynth.env /etc/plynth/env');
    for (const s of ["provision.sh", "deploy.sh", "split-env.sh", "backup.sh"]) {
      const r = Bun.spawnSync(["bash", "-n", join(SERVER, s)], { stderr: "pipe" });
      expect(r.exitCode, `${s}: ${r.stderr}`).toBe(0);
    }
  });
});
