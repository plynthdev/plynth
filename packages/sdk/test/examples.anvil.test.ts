// The three README examples run end to end against anvil + the local kit (each starts and stops its own anvil
// on 8550-8599). Skips without anvil/forge.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const tools = ["anvil", "forge"].every((b) => Bun.spawnSync(["which", b]).exitCode === 0);
const EXAMPLES = join(import.meta.dir, "..", "examples");

async function run(name: string) {
  const p = Bun.spawn(["bun", join(EXAMPLES, `${name}.ts`)], { cwd: join(EXAMPLES, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, RPC_URL: "", PLYNTH_DEPLOYMENT: "" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

describe.skipIf(!tools)("examples (anvil + local kit)", () => {
  for (const name of ["send-to-stealth", "crowd-join", "shield-and-withdraw"]) {
    test(name, async () => {
      const r = await run(name);
      if (r.code !== 0) console.error(r.out);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`${name}: OK`);
    }, 240_000);
  }
});
