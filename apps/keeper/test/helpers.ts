import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@plynth/db";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";

export const ROOT = join(import.meta.dir, "..", "..", "..");

/** Anvil's well-known dev accounts #0 and #1. Public test keys, never used outside local anvil. */
export const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // test-key
export const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // test-key
export const ANVIL_ADDR_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Fresh migrated database named plynth_c_keeper_* (consumer-lane prefix). Call drop() after. */
export async function keeperTestDb(label = "t") {
  const name = `plynth_c_keeper_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const url = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(url);
  await runMigrations(url);
  const conn = connect(url);
  return {
    url,
    name,
    ...conn,
    drop: async () => {
      await conn.close();
      await dropDatabase(url);
    },
  };
}

/** Starts anvil on a free port in 8550-8599 (tries several). */
export async function startAnvil(extra: string[] = []): Promise<{ proc: ReturnType<typeof Bun.spawn>; rpc: string; stop: () => Promise<void> }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = 8550 + Math.floor(Math.random() * 50);
    const proc = Bun.spawn(["anvil", "--port", String(port), "--silent", ...extra], { stdout: "ignore", stderr: "ignore" });
    const rpc = `http://127.0.0.1:${port}`;
    const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) break; // port taken
      try {
        await pub.getChainId();
        return {
          proc,
          rpc,
          stop: async () => {
            proc.kill();
            await proc.exited;
          },
        };
      } catch {
        await Bun.sleep(100);
      }
    }
    proc.kill();
    await proc.exited;
  }
  throw new Error("could not start anvil on 8550-8599");
}

/** Runtime bytecode of the canonical Permit2, as embedded for the vault tests. */
export function permit2Runtime(): Hex {
  const src = readFileSync(join(ROOT, "contracts", "test", "consumer", "Permit2Code.sol"), "utf8");
  const m = src.match(/RUNTIME =\s*hex"([0-9a-fA-F]+)"/);
  if (!m) throw new Error("Permit2 runtime not found");
  return `0x${m[1]}` as Hex;
}

export function hasBinary(name: string): boolean {
  return Bun.spawnSync(["which", name]).exitCode === 0;
}
