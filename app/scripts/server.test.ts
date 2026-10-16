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
    expect(Object.keys(f).sort()).toEqual(["api", "common", "eligibility", "indexer", "keeper", "mcp", "relayer", "treasury"]);
    const holders = (k: string) => Object.entries(f).filter(([, s]) => s.has(k)).map(([n]) => n).sort();
    expect(holders("KEEPER_SECRET_KEY")).toEqual(["api", "keeper"]);
    expect(holders("KEEPER_KEYSTORE")).toEqual(["keeper"]);
    expect(holders("KEEPER_KEYSTORE_PASSWORD_FILE")).toEqual(["keeper"]);
    expect(holders("RELAYER_KEYSTORE")).toEqual(["relayer"]);
    expect(holders("MCP_TOKEN_SECRET")).toEqual(["api", "mcp"]);
    expect(holders("ELIGIBILITY_KEYSTORE")).toEqual(["api", "eligibility"]);
    expect(holders("TREASURY_CONTROLLER_KEYSTORE")).toEqual(["treasury"]);
    expect(holders("CORS_ORIGINS")).toEqual(["api", "relayer"]);
    expect(holders("RHC_MAINNET_RPC_URL")).toEqual(["common"]);
    // the common file carries no secret at all
    for (const k of f.common!) expect(k).not.toMatch(/SECRET|KEY|PASSWORD|KEYSTORE|TOKEN/);
    // every variable of env.example lands somewhere
    const all = keys(readFileSync(join(SERVER, "env.example"), "utf8"));
    for (const k of all) expect(holders(k).length, k).toBeGreaterThan(0);
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
      ...Object.fromEntries(["close", "desks", "marks", "receipts", "reconciler", "risk", "webhooks"].map((t) => [`treasury-${t}`, { user: "plynth-treasury", env: "treasury", db: true, keys: true }])),
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
    expect(users.size).toBe(7);
    // migrations run as the code owner with the database URL and no service secrets
    const m = unit("migrate");
    expect(m).toContain("\nUser=plynth\n");
    expect(m).not.toMatch(/EnvironmentFile=\/etc\/plynth\/env\/(keeper|api|relayer|mcp|treasury|eligibility)\.env/);
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
