// Audit (dependencies): viem used ^ ranges in app, sdk, circuits and web, minimumReleaseAge was set in web only, and
// the app's postinstall ran a non-frozen `bun install` in ../sdk (so installing the app could rewrite the SDK lock).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PKGS = ["app", "sdk", "circuits", "web"];
const pkg = (d: string) =>
  JSON.parse(readFileSync(join(ROOT, d, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; overrides?: Record<string, string>; scripts?: Record<string, string> };
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe("dependency controls", () => {
  test("viem is pinned to one exact version in every package, and the lockfile resolves that version", () => {
    for (const d of PKGS) {
      const v = pkg(d).dependencies?.viem;
      expect(v, d).toMatch(/^\d+\.\d+\.\d+$/);
      const lock = join(ROOT, d, "bun.lock");
      if (existsSync(lock)) {
        const text = readFileSync(lock, "utf8");
        expect(text, d).toContain(`"viem": ["viem@${v}"`);
        expect(text, d).toContain(`"viem": "${v}"`); // the package's own specifier in the lock
      }
    }
  });

  test("minimumReleaseAge (>= 24 h) in every package's bunfig.toml", () => {
    for (const d of PKGS) {
      const f = join(ROOT, d, "bunfig.toml");
      expect(existsSync(f), d).toBe(true);
      const m = readFileSync(f, "utf8").match(/^\s*minimumReleaseAge\s*=\s*(\d+)/m);
      expect(m, d).not.toBeNull();
      expect(Number(m![1]), d).toBeGreaterThanOrEqual(86_400);
    }
  });

  // Review v2 (V2-L25, DEPS-1): only viem was exact; app had 13 ranges (hono, plaid ^41, @mcp/sdk ^1, @trpc/server ^11,
  // ...), sdk 2, web about 71, and circuits had no lockfile.
  test("every dependency of every package is an exact version (or a local file:), no ^ / ~ / x ranges", () => {
    const bad: string[] = [];
    for (const d of PKGS) {
      const p = pkg(d);
      for (const [name, spec] of Object.entries({ ...p.dependencies, ...p.devDependencies, ...p.overrides })) if (!EXACT.test(spec) && !spec.startsWith("file:")) bad.push(`${d}: ${name}@${spec}`);
    }
    expect(bad).toEqual([]);
  });

  test("every package has a committed bun.lock whose specifiers are the package.json's exact versions", () => {
    for (const d of PKGS) {
      const lock = join(ROOT, d, "bun.lock");
      expect(existsSync(lock), d).toBe(true);
      const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", `${d}/bun.lock`], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
      expect(tracked.exitCode, `${d}/bun.lock is not committed`).toBe(0);
      const text = readFileSync(lock, "utf8");
      const p = pkg(d);
      for (const [name, spec] of Object.entries({ ...p.dependencies, ...p.devDependencies })) {
        expect(text, `${d}: ${name}`).toContain(`"${name}": "${spec}"`);
        if (EXACT.test(spec)) expect(text, `${d}: ${name} resolves to ${spec}`).toContain(`"${name}": ["${name}@${spec}"`);
      }
    }
  });

  test("the app's postinstall installs the SDK frozen", () => {
    const s = pkg("app").scripts?.postinstall ?? "";
    expect(s).toContain("bun install");
    expect(s).toContain("--frozen-lockfile");
  });
});
