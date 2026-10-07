// The testnet timers on anvil: CrowdBuy WINDOW = 2 h on a JitterBeacon with GRACE = 15 min (LocalConsumer with
// CROWD_WINDOW / BEACON_GRACE). The real indexer + keeper CLIs (--once) read WINDOW() and GRACE() from the
// contracts: they commit the next 2 h windows, reveal at the execution time and execute, all inside one window,
// and the next window runs again the same way (two executions within 4 hours).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { beaconAbi, crowdAbi } from "@/abi/keeper";
import { beaconKey } from "./jobs/beacon";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";

const U = 1_000_000n;
const WINDOW = 7_200n;
const GRACE = 900n;

const usdgAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const userVaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function deposit(uint256 amount)",
  "function setSettings(Settings s)",
  "function setMix(MixEntry[] mix)",
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
]);

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dir: string;
let dep: Record<string, any>;
let users: Address[];
let wallets: Address[];
let merchant: Address;
let deployer: Address;
let pub: ReturnType<typeof createPublicClient>;
let wc: ReturnType<typeof createWalletClient>;
const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

function cli(script: string, env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", script, "--once"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: t.url, LOCAL_RPC_URL: anvil.rpc, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${script} --once failed:\n${out}`);
  return out;
}
const indexer = () => cli("app/src/bin/indexer.ts", { INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir });
const keeper = (jobs?: string) =>
  cli("app/src/bin/keeper.ts", { KEEPER_CHAIN: "local", KEEPER_DEPLOYMENTS_DIR: dir, KEEPER_PRIVATE_KEY: ANVIL_KEY_1, KEEPER_SECRET_KEY: secretKey, ...(jobs ? { KEEPER_JOBS: jobs } : {}) });
const cycle = () => {
  indexer();
  return keeper();
};

const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
async function warpTo(ts: bigint) {
  await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
  await rpc("evm_mine");
}
const windowOf = (ts: bigint) => {
  const g = BigInt(dep.genesis);
  const start = g + ((ts - g) / WINDOW) * WINDOW;
  return { start, end: start + WINDOW };
};
const tsla = () => dep.stocks.mTSLA.token as Address;
const book = async (id: bigint) => (await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "book", args: [tsla(), id] })) as any;
const beaconOf = async (key: Hex) => (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "beacon", args: [key] })) as any;

/** Keeper beacon passes in small steps (never past the reveal deadline) until it has revealed `key`. */
async function revealByKeeper(key: Hex): Promise<bigint> {
  const deadline = BigInt((await beaconOf(key)).windowEnd) - GRACE;
  for (let i = 0; i < 60; i++) {
    keeper("beacon");
    const st = (await t.sql`select status from keeper_jobs where job_key = ${key.toLowerCase()}`)[0]?.status;
    if (st === "revealed") return (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "executeAfter", args: [key] })) as bigint;
    const n = await now();
    const left = deadline - n;
    await warpTo(n + (left / 2n > 600n ? 600n : left / 2n > 10n ? left / 2n : 10n));
  }
  throw new Error("the keeper never revealed");
}

async function link(user: Address, wallet: Address) {
  const nonce = (await pub.readContract({ address: dep.savingsVault, abi: userVaultAbi, functionName: "linkNonce", args: [wallet] })) as bigint;
  const deadline = (await now()) + 3600n;
  const sig = await wc.signTypedData({
    account: wallet,
    domain: { name: "Plynth SavingsVault", version: "1", chainId: 31337, verifyingContract: dep.savingsVault },
    types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "LinkWallet",
    message: { user, wallet, nonce, deadline },
  });
  await tx(user, dep.savingsVault, userVaultAbi, "linkSpendingWallet", [wallet, deadline, sig]);
}

beforeAll(async () => {
  anvil = await startAnvil();
  pub = createPublicClient({ transport: http(anvil.rpc) });
  wc = createWalletClient({ transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  deployer = accounts[0]!;
  users = accounts.slice(2, 5);
  wallets = accounts.slice(5, 8);
  merchant = accounts[8]!;
  await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
  const f = Bun.spawnSync(["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"], {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, KEEPER_ADDRESS: ANVIL_ADDR_1, MIN_CROWD: "3", CROWD_WINDOW: String(WINDOW), BEACON_GRACE: String(GRACE) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const fout = f.stdout.toString() + f.stderr.toString();
  const line = fout.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
  if (f.exitCode !== 0 || !line) throw new Error(`forge script failed:\n${fout}`);
  dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
  dir = mkdtempSync(join(tmpdir(), "plynth-keeper-2h-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("short");
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 1_000n * U]);
    await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 1, multiplier: 1, weeklyCap: 500n * U, fixedTopUp: 0n, mode: 0 }]);
    await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: tsla(), weightBps: 10_000 }]]);
    await tx(deployer, dep.usdg, usdgAbi, "mint", [wallets[i]!, 200n * U]);
    await link(u, wallets[i]!);
  }
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
  await t?.drop();
});

describe("keeper with a 2 h CrowdBuy window and a 15 min beacon GRACE", () => {
  test("the contracts carry the deploy-time timers", async () => {
    expect((await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "WINDOW" })) as bigint).toBe(WINDOW);
    expect((await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "GRACE" })) as bigint).toBe(GRACE);
  });

  for (const round of [0n, 1n]) {
    test(`book ${round}: commit -> reveal -> execute inside one 2 h window`, async () => {
      for (const [i, w] of wallets.entries()) await tx(w, dep.usdg, usdgAbi, "transfer", [merchant, 3_400_000n + BigInt(i)]);
      const out = cycle(); // accrue, sweep into the open book, commit the next 2 h windows
      expect(out).toContain("sweep: ok actions=1");
      expect((await book(round)).accounts).toBe(3);

      const w = windowOf(await now()).start + WINDOW;
      const key = beaconKey(tsla(), w);
      const b = await beaconOf(key);
      expect(BigInt(b.windowStart)).toBe(w);
      expect(BigInt(b.windowEnd)).toBe(w + WINDOW); // the keeper used WINDOW() from the contract, not 24 h
      expect(b.commitment).not.toBe(`0x${"0".repeat(64)}`);

      await warpTo(w + 1n);
      const executeAt = await revealByKeeper(key);
      expect(executeAt).toBeGreaterThanOrEqual(w);
      expect(executeAt).toBeLessThan(w + WINDOW - GRACE);
      const n = await now();
      await warpTo((executeAt > n ? executeAt : n) + 1n);
      expect(cycle()).toContain("execute: ok actions=1");
      const bk = await book(round);
      expect(bk.executed).toBe(true);
      expect(bk.rawOut).toBeGreaterThan(0n);
      const job = (await t.sql`select tx_hash from keeper_jobs where kind = 'execute' and job_key = ${`${tsla().toLowerCase()}:${round}`}`)[0]!;
      const blk = await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: job.tx_hash })).blockNumber });
      expect(blk.timestamp).toBeGreaterThanOrEqual(executeAt);
      expect(blk.timestamp).toBeLessThan(w + WINDOW); // executed inside the same 2 h window
    }, 180_000);
  }
});
