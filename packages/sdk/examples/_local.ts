// Shared setup for the examples: an anvil chain with the local Plynth kit deployed. NOT part of the SDK.
//
// With RPC_URL + PLYNTH_DEPLOYMENT (path to the deployment JSON) set, it attaches to that chain. Otherwise it
// starts anvil on a free port in 8550-8599, etches the canonical Permit2 / ERC-5564 Announcer / ERC-6538 Registry
// runtimes at their real addresses, runs contracts/script/LocalConsumer.s.sol, and stops anvil on `stop()`.
// Transactions use anvil's unlocked dev accounts (eth_sendTransaction): no key is ever handled here except
// anvil's well-known account #0 key, which `forge script` needs to broadcast.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, type Address, type Hex, type PublicClient } from "viem";

export const ROOT = join(import.meta.dir, "..", "..", "..");
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // test-key (anvil #0, public)
const ANVIL_ADDR_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1: the local kit's keeper

export type Kit = Awaited<ReturnType<typeof localKit>>;

function runtime(file: string, name: string): Hex {
  const src = readFileSync(join(ROOT, "contracts", "test", "consumer", file), "utf8");
  const m = src.match(new RegExp(`${name} =\\s*hex"([0-9a-fA-F]+)"`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return `0x${m[1]}` as Hex;
}

async function startAnvil(): Promise<{ rpc: string; stop: () => Promise<void> }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = 8550 + Math.floor(Math.random() * 50);
    const proc = Bun.spawn(["anvil", "--port", String(port), "--silent", "--gas-limit", "60000000"], { stdout: "ignore", stderr: "ignore" });
    const rpc = `http://127.0.0.1:${port}`;
    const probe = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) break; // port taken
      try {
        await probe.getChainId();
        return { rpc, stop: async () => void (proc.kill(), await proc.exited) };
      } catch {
        await Bun.sleep(100);
      }
    }
    proc.kill();
    await proc.exited;
  }
  throw new Error("could not start anvil on 8550-8599");
}

export async function localKit() {
  let rpc = process.env.RPC_URL;
  let stop = async () => {};
  let dep: Record<string, any>;
  if (rpc && process.env.PLYNTH_DEPLOYMENT) {
    dep = JSON.parse(readFileSync(process.env.PLYNTH_DEPLOYMENT, "utf8"));
  } else {
    const a = await startAnvil();
    rpc = a.rpc;
    stop = a.stop;
    const raw = createPublicClient({ transport: http(rpc) });
    const setCode = (addr: Address, code: Hex) => raw.request({ method: "anvil_setCode" as any, params: [addr, code] as any });
    await setCode("0x000000000022D473030F116dDEE9F6B43aC78BA3", runtime("Permit2Code.sol", "RUNTIME"));
    await setCode("0x55649E01B5Df198D18D95b5cc5051630cfD45564", runtime("StealthCode.sol", "ANNOUNCER_RUNTIME"));
    await setCode("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538", runtime("StealthCode.sol", "REGISTRY_RUNTIME"));
    const f = Bun.spawnSync(["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"], {
      cwd: join(ROOT, "contracts"),
      env: { ...process.env, KEEPER_ADDRESS: ANVIL_ADDR_1, MIN_CROWD: "3" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = f.stdout.toString() + f.stderr.toString();
    const line = out.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
    if (f.exitCode !== 0 || !line) {
      await stop();
      throw new Error(`forge script failed:\n${out}`);
    }
    dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
  }

  const chain = defineChain({ id: Number(dep.chainId), name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc), cacheTime: 0, pollingInterval: 20 }) as PublicClient;
  const wallet = createWalletClient({ chain, transport: http(rpc) });
  const accounts = (await pub.request({ method: "eth_accounts" as any })) as Address[];
  const rpcCall = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
  const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const warpTo = async (ts: bigint) => {
    await rpcCall("evm_setNextBlockTimestamp", [Number(ts)]);
    await rpcCall("evm_mine");
  };

  /** Sends an unsigned { to, data } from an unlocked anvil account and waits for success. */
  async function send(from: Address, u: { to: Address; data: Hex; value?: bigint }) {
    const hash = await wallet.sendTransaction({ account: from, to: u.to, data: u.data, value: u.value, chain } as any);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx to ${u.to} reverted`);
    return r;
  }
  const call = (from: Address, to: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
    send(from, { to, data: encodeFunctionData({ abi, functionName, args } as any) });
  const read = <T = any>(address: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;

  return { rpc, dep, chain, pub, wallet, accounts, rpcCall, now, warpTo, send, call, read, stop };
}

/** Runs an example: always stops the anvil it started, exits non-zero on failure. */
export async function runExample(name: string, body: (kit: Kit) => Promise<void>) {
  const kit = await localKit();
  try {
    await body(kit);
    console.log(`${name}: OK`);
  } catch (err) {
    console.error(`${name}: FAILED`, err);
    process.exitCode = 1;
  } finally {
    await kit.stop();
  }
}

export function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}
