// The todo-07 end-to-end fixture, reused to seed the API's test database with real indexer + keeper output:
// anvil + LocalConsumer (MIN_CROWD = 3), three savers with linked spending wallets, round-ups, a Permit2
// top-up, a sweep into Crowd Buy, a revealed window, an executed mTSLA book, one Open claim and one
// withdrawal. User 0 splits 50/50 mTSLA/mNVDA, so its mNVDA order stays queued (crowd of 1 < 3).
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, permit2Runtime, startAnvil } from "./keeper-helpers";

export { ROOT };
const U = 1_000_000n;
const DAY = 86_400n;

const usdgAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const userAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount, address to)",
  "function setSettings(Settings s)",
  "function setMix(MixEntry[] mix)",
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
  "function claimOpen(address asset, uint256 bookId)",
  "function book(address asset, uint256 bookId) view returns ((uint256 usdgTotal, uint32 accounts, uint64 openedAt, uint256 rawOut, bool executed))",
  "function executeAfter(bytes32 key) view returns (uint64)",
  "function beaconKey(address asset, uint64 windowStart) pure returns (bytes32)",
]);
const permit2UserAbi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

/** Fresh migrated database named plynth_c_api_* (consumer-lane prefix). */
export async function apiTestDb(label = "t") {
  const name = `plynth_c_api_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const url = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(url);
  await runMigrations(url);
  const conn = connect(url);
  return { url, name, ...conn, drop: async () => (await conn.close(), await dropDatabase(url)) };
}

export type Fixture = Awaited<ReturnType<typeof seedFixture>>;

export async function seedFixture() {
  const anvil = await startAnvil();
  const pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 20 }) as PublicClient;
  const wc = createWalletClient({ transport: http(anvil.rpc) });
  const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
  const accounts = (await rpc("eth_accounts")) as Address[];
  const deployer = accounts[0]!;
  const users = accounts.slice(2, 5);
  const wallets = accounts.slice(5, 8);
  const merchant = accounts[8]!;
  const stranger = accounts[9]!;
  const db = await apiTestDb("e2e");
  const dir = mkdtempSync(join(tmpdir(), "plynth-api-"));
  const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  const cleanup = async () => {
    await anvil.stop();
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const send = async (account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) => {
      const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      if (r.status !== "success") throw new Error(`${functionName} reverted`);
    };
    const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
    const warpTo = async (ts: bigint) => {
      await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
      await rpc("evm_mine");
    };
    const cli = (script: string, env: Record<string, string>) => {
      const r = Bun.spawnSync(["bun", script, "--once"], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: db.url, LOCAL_RPC_URL: anvil.rpc, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = r.stdout.toString() + r.stderr.toString();
      if (r.exitCode !== 0) throw new Error(`${script} --once failed:\n${out}`);
      return out;
    };
    const indexer = () => cli("app/src/bin/indexer.ts", { INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir });
    const keeper = (jobs?: string) =>
      cli("app/src/bin/keeper.ts", {
        KEEPER_CHAIN: "local",
        KEEPER_DEPLOYMENTS_DIR: dir,
        KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
        KEEPER_SECRET_KEY: secretKey,
        ...(jobs ? { KEEPER_JOBS: jobs } : {}),
      });
    const cycle = () => (indexer(), keeper());

    await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
    const f = Bun.spawnSync(
      ["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"],
      { cwd: join(ROOT, "contracts"), env: { ...process.env, KEEPER_ADDRESS: ANVIL_ADDR_1, MIN_CROWD: "3" }, stdout: "pipe", stderr: "pipe" },
    );
    const fout = f.stdout.toString() + f.stderr.toString();
    const line = fout.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
    if (f.exitCode !== 0 || !line) throw new Error(`forge script failed:\n${fout}`);
    const dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
    writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
    const tsla = dep.stocks.mTSLA.token as Address;
    const nvda = dep.stocks.mNVDA.token as Address;

    for (const [i, u] of users.entries()) {
      await send(deployer, dep.usdg, usdgAbi, "mint", [u, 1_000n * U]);
      await send(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 300n * U]);
      await send(u, dep.savingsVault, userAbi, "deposit", [300n * U]);
      const s = { roundTo: 1, multiplier: i === 0 ? 2 : 1, weeklyCap: 500n * U, fixedTopUp: i === 0 ? 25n * U : 0n, mode: 0 };
      await send(u, dep.savingsVault, userAbi, "setSettings", [s]);
      const mix = i === 0 ? [{ stockToken: tsla, weightBps: 5_000 }, { stockToken: nvda, weightBps: 5_000 }] : [{ stockToken: tsla, weightBps: 10_000 }];
      await send(u, dep.savingsVault, userAbi, "setMix", [mix]);
      await send(deployer, dep.usdg, usdgAbi, "mint", [wallets[i]!, 200n * U]);
    }
    await send(users[0]!, dep.usdg, usdgAbi, "approve", [dep.permit2, (1n << 256n) - 1n]);
    await send(users[0]!, dep.permit2, permit2UserAbi, "approve", [dep.usdg, dep.savingsVault, 1_000n * U, Number((await now()) + 60n * DAY)]);
    for (const [i, u] of users.entries()) {
      const nonce = (await pub.readContract({ address: dep.savingsVault, abi: userAbi, functionName: "linkNonce", args: [wallets[i]!] })) as bigint;
      const deadline = (await now()) + 3600n;
      const sig = await wc.signTypedData({
        account: wallets[i]!,
        domain: { name: "Plynth SavingsVault", version: "1", chainId: 31337, verifyingContract: dep.savingsVault },
        types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "LinkWallet",
        message: { user: u, wallet: wallets[i]!, nonce, deadline },
      });
      await send(u, dep.savingsVault, userAbi, "linkSpendingWallet", [wallets[i]!, deadline, sig]);
    }
    // Round-ups: user0 3.40 (x2 -> 1.20), user1 7.25 (0.75), user2 7.01 (0.99) and an exact 20.00 (0).
    for (const [i, v] of [[0, 3_400_000n], [1, 7_250_000n], [2, 7_010_000n], [2, 20_000_000n]] as const) {
      await send(wallets[i]!, dep.usdg, usdgAbi, "transfer", [merchant, v]);
    }
    cycle(); // accrue, top-up, sweep into book 0 (and user0's mNVDA order), commit next windows

    const genesis = BigInt(dep.genesis);
    const w1 = genesis + (((await now()) - genesis) / DAY) * DAY + DAY;
    await warpTo(w1 + 5n);
    keeper("topups,roundups,sweep,beacon"); // reveal w1
    const executeAt = (await pub.readContract({ address: dep.jitterBeacon, abi: userAbi, functionName: "executeAfter", args: [await pub.readContract({ address: dep.crowdBuy, abi: userAbi, functionName: "beaconKey", args: [tsla, w1] })] })) as bigint;
    await warpTo((executeAt > (await now()) ? executeAt : await now()) + 1n);
    const out = cycle();
    if (!out.includes("execute: ok actions=1")) throw new Error(`book 0 did not execute:\n${out}`);
    await send(users[0]!, dep.crowdBuy, userAbi, "claimOpen", [tsla, 0n]);
    await send(users[1]!, dep.savingsVault, userAbi, "withdraw", [10n * U, users[1]!]);
    indexer();

    return { anvil, pub, wc, db, dir, dep, users, wallets, stranger, tsla, nvda, deployer, cleanup, indexer };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
