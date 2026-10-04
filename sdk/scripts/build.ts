// Builds the publishable package: ESM bundles per entry point (shared code in chunks, npm dependencies left as
// imports, @plynth/chain inlined) plus .d.ts files. `bun run build` writes dist/; `bun scripts/build.ts <dir>`
// writes elsewhere (the tests build into a temp dir).
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

export const ENTRIES = ["index", "stealth", "crowd", "vault", "statements", "relayer"] as const;
const here = join(import.meta.dir, "..");

export async function build(outDir = join(here, "dist")): Promise<void> {
  outDir = resolve(outDir);
  rmSync(outDir, { recursive: true, force: true });
  const res = await Bun.build({
    entrypoints: ENTRIES.map((e) => join(here, "src", e === "index" ? "index.ts" : `${e}/index.ts`)),
    root: join(here, "src"),
    outdir: outDir,
    format: "esm",
    target: "browser",
    splitting: true,
    minify: false,
    sourcemap: "none",
    external: Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]),
    naming: { entry: "[dir]/[name].js", chunk: "chunks/[name]-[hash].js" },
  });
  if (!res.success) throw new AggregateError(res.logs, "bun build failed");
  const tsc = Bun.spawnSync(["bunx", "tsc", "-p", join(here, "tsconfig.build.json"), "--outDir", outDir], { cwd: here, stdout: "pipe", stderr: "pipe" });
  if (tsc.exitCode !== 0) throw new Error(`tsc failed:\n${tsc.stdout}${tsc.stderr}`);
}

if (import.meta.main) {
  const out = process.argv[2];
  await build(out);
  console.log(`built ${ENTRIES.length} entry points + types into ${out ?? "dist"}`);
}
