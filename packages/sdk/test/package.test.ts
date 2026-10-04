// Packaging rules for @plynth/sdk: per-module ESM entry points with types, tree-shakeable (light modules never
// pull in the proving stack), no network side effects on import, and a tarball holding only dist/ + README.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { ENTRIES, build } from "../scripts/build";

const PKG = join(import.meta.dir, "..");
const OUT = join(PKG, `.test-dist-${process.pid}`);
const MODULES = ["stealth", "crowd", "vault", "statements", "relayer"] as const;
const LIGHT = ["stealth", "crowd", "relayer"] as const;
const PROVING = ["@aztec/bb.js", "@noir-lang/noir_js"];
const entryFile = (e: string) => join(OUT, e === "index" ? "index.js" : `${e}/index.js`);

beforeAll(async () => {
  await build(OUT);
}, 120_000);
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/** Every module a built file loads, following relative imports through the shared chunks. */
function importGraph(file: string, seen = new Set<string>()): { files: Set<string>; packages: Set<string> } {
  const packages = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      if (spec.startsWith(".")) walk(resolve(dirname(f), spec));
      else packages.add(spec);
    }
  };
  walk(file);
  return { files: seen, packages };
}

describe("build output", () => {
  test("ESM + .d.ts for every entry point; every export in package.json points at a built file", () => {
    expect([...ENTRIES].sort()).toEqual(["index", ...MODULES].sort());
    for (const [sub, cond] of Object.entries(pkg.exports)) {
      if (typeof cond === "string") continue; // ./package.json
      for (const target of [cond.import, cond.default, cond.types]) {
        const f = join(OUT, target.replace(/^\.\/dist\//, ""));
        expect(existsSync(f)).toBe(true);
      }
      expect(sub === "." || MODULES.includes(sub.slice(2) as any)).toBe(true);
    }
    for (const m of MODULES) expect(Object.keys(pkg.exports)).toContain(`./${m}`);
    expect(readFileSync(entryFile("crowd"), "utf8")).toMatch(/export\s*\{/); // ESM
    expect(readFileSync(join(OUT, "crowd/index.d.ts"), "utf8")).toContain("joinTx");
  });

  test("declarations never reference unpublished workspace packages", () => {
    const glob = new Bun.Glob("**/*.d.ts");
    for (const f of glob.scanSync(OUT)) expect(readFileSync(join(OUT, f), "utf8")).not.toMatch(/from ["']@plynth\//);
  });

  test("bundles import only declared dependencies; @plynth/chain is inlined", () => {
    const deps = Object.keys(pkg.dependencies);
    for (const e of ENTRIES) {
      for (const p of importGraph(entryFile(e)).packages) {
        expect(deps.some((d) => p === d || p.startsWith(`${d}/`))).toBe(true);
      }
    }
  });

  test("tree-shakeable: stealth, crowd and relayer never load the proving stack; vault and statements do", () => {
    for (const m of LIGHT) {
      const { packages } = importGraph(entryFile(m));
      for (const p of PROVING) expect([...packages]).not.toContain(p);
    }
    for (const m of ["vault", "statements"]) expect([...importGraph(entryFile(m)).packages]).toContain("@aztec/bb.js");
    expect(pkg.sideEffects).toBe(false);
  });

  test("a consumer importing one stealth function gets a small bundle without the proving stack", async () => {
    const app = join(OUT, "app.ts");
    writeFileSync(app, `import { metaAddress } from "./stealth/index.js";\nconsole.log(metaAddress);\n`);
    const r = await Bun.build({ entrypoints: [app], target: "browser", external: ["viem", "viem/*", "@noble/*"] });
    expect(r.success).toBe(true);
    const code = await r.outputs[0]!.text();
    expect(code).not.toMatch(/bb\.js|noir_js|Barretenberg/);
    expect(code).not.toMatch(/joinTx|submitWithdraw|proveWithdraw/); // unused modules dropped
  });
});

describe("no network side effects on import", () => {
  // Runs in a child process with every network primitive replaced by a recorder.
  const probe = (specs: string[]) => {
    const script = join(OUT, `probe-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(
      script,
      `const calls: string[] = [];
for (const k of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
  (globalThis as any)[k] = new Proxy(function () {}, { apply: () => { calls.push(k); throw new Error("network"); }, construct: () => { calls.push(k); throw new Error("network"); } });
}
for (const s of ${JSON.stringify(specs)}) await import(s);
await new Promise((r) => setTimeout(r, 200));
console.log("CALLS=" + JSON.stringify(calls));
`,
    );
    const r = Bun.spawnSync(["bun", script], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    rmSync(script);
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode).toBe(0);
    return JSON.parse(out.match(/CALLS=(.*)/)![1]!) as string[];
  };

  test("built entry points (what npm consumers get)", () => {
    expect(probe(ENTRIES.map((e) => entryFile(e)))).toEqual([]);
  });

  test("workspace sources (what apps in this repo get)", () => {
    expect(probe(["@plynth/sdk", ...MODULES.map((m) => `@plynth/sdk/${m}`)])).toEqual([]);
  });
});

describe("workspace resolution and the tarball", () => {
  test("inside the repo @plynth/sdk/<module> resolves to src (root tsconfig paths), so apps need no build", () => {
    for (const m of MODULES) expect(Bun.resolveSync(`@plynth/sdk/${m}`, join(PKG, "..", "..", "apps", "keeper"))).toBe(join(PKG, "src", m, "index.ts"));
  });

  test("npm pack --dry-run lists only dist/, README.md and package.json; private, never published", () => {
    const r = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const files = (JSON.parse(r.stdout.toString())[0].files as { path: string }[]).map((f) => f.path);
    for (const f of files) expect(f === "package.json" || f === "README.md" || f.startsWith("dist/")).toBe(true);
    expect(files).toContain("README.md");
    if (existsSync(join(PKG, "dist", "index.js"))) for (const e of ENTRIES) expect(files).toContain(e === "index" ? "dist/index.js" : `dist/${e}/index.js`);
    expect(pkg.private).toBe(true);
    expect(pkg.files).toEqual(["dist", "README.md"]);
    expect((pkg as any).scripts?.prepublishOnly ?? (pkg as any).scripts?.publish).toBeUndefined();
  });

  test("README covers every module, trust assumptions and the documented limits", () => {
    const readme = readFileSync(join(PKG, "README.md"), "utf8");
    for (const m of MODULES) expect(readme).toContain(`@plynth/sdk/${m}`);
    expect(readme).toMatch(/funding is public|hides the recipient, not the funding/i);
    expect(readme).toMatch(/crowd privacy depends on crowd size/i);
    expect(readme).toMatch(/unaudited/i);
    expect(readme).toMatch(/mainnet cap is 0/i);
    for (const ex of ["send-to-stealth", "crowd-join", "shield-and-withdraw"]) {
      expect(readme).toContain(`examples/${ex}.ts`);
      expect(existsSync(join(PKG, "examples", `${ex}.ts`))).toBe(true);
    }
  });
});
