// Hidden delivery end to end on anvil with the real UltraHonk verifiers:
// users register vault keys (from a wallet signature) -> crowd executes -> keeper deliver-hidden queues one note
// per Hidden user in ShieldedPool -> after MIN_PENDING_DELAY the keeper batches them into the tree -> the SDK
// syncs the tree from events and finds each note with the viewing key -> a private transfer (client proof) ->
// a gasless withdraw through the relayer's POST /withdraw to a fresh address. Plus a direct USDG deposit/refund.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  VAULT_KEY_MESSAGE,
  approveTx,
  balances,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  initVault,
  myNotes,
  proveTransfer,
  proveWithdraw,
  refundPendingTx,
  registration,
  shieldedPoolAbi,
  syncPool,
  transferTx,
  withdrawRequest,
  type VaultKeys,
} from "@plynth/sdk/vault";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beaconAbi, crowdAbi } from "@/abi/keeper";
import { beaconKey } from "@/keeper/jobs/beacon";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";
import { relayerApp } from "./app";
import { chainDeps, withdrawDeps } from "./chain";

const RELAYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex; // test-key (anvil #9)
const U = 1_000_000n;
const DAY = 86_400n;

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const userVaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function deposit(uint256 amount)",
  "function setSettings(Settings s)",
  "function setMix(MixEntry[] mix)",
  "function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)",
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
]);
const poolAdminAbi = parseAbi(["function applyCap(address asset)", "function cap(address asset) view returns (uint256)"]);

function stealthRuntime(name: "ANNOUNCER_RUNTIME" | "REGISTRY_RUNTIME"): Hex {
  const src = readFileSync(join(ROOT, "contracts", "test", "consumer", "StealthCode.sol"), "utf8");
  const m = src.match(new RegExp(`${name} =\\s*hex"([0-9a-fA-F]+)"`));
  if (!m) throw new Error(`${name} not found`);
  return `0x${m[1]}` as Hex;
}

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dir: string;
let dep: Record<string, any>;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let users: Address[];
let wallets: Address[];
let merchant: Address;
let deployer: Address;
const keys: VaultKeys[] = [];
const alloc: bigint[] = [];
const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
const tsla = () => dep.stocks.mTSLA.token as Address;
const pool = () => dep.shieldedPool as Address;
const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
const warpTo = async (ts: bigint) => {
  await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
  await rpc("evm_mine");
};
const windowStart = (ts: bigint) => {
  const g = BigInt(dep.genesis);
  return g + ((ts - g) / DAY) * DAY;
};
const read = (address: Address, abi: any, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}
async function send(account: Address, u: { to: Address; data: Hex }) {
  const hash = await wc.sendTransaction({ account, to: u.to, data: u.data, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`tx to ${u.to} reverted`);
  return r;
}

function cli(script: string, env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", script, "--once"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: t.url, LOCAL_RPC_URL: anvil.rpc, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${script} --once failed:\n${out}`);
  return out;
}
const keeper = (jobs?: string) =>
  cli("app/src/bin/keeper.ts", { KEEPER_CHAIN: "local", KEEPER_DEPLOYMENTS_DIR: dir, KEEPER_PRIVATE_KEY: ANVIL_KEY_1, KEEPER_SECRET_KEY: secretKey, ...(jobs ? { KEEPER_JOBS: jobs } : {}) });
const cycle = (jobs?: string) => {
  cli("app/src/bin/indexer.ts", { INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir });
  return keeper(jobs);
};

async function link(user: Address, wallet: Address) {
  const nonce = (await read(dep.savingsVault, userVaultAbi, "linkNonce", [wallet])) as bigint;
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

async function fillAndExecute(spendUsd: bigint): Promise<bigint> {
  for (const w of wallets) await tx(w, dep.usdg, tokenAbi, "transfer", [merchant, spendUsd]);
  cycle("roundups,spends,sweep,beacon");
  const [bookId] = (await read(dep.crowdBuy, crowdAbi, "openBook", [tsla()])) as [bigint, any];
  const w = windowStart(await now()) + DAY;
  await warpTo(w + 5n);
  keeper("beacon");
  const executeAt = (await read(dep.jitterBeacon, beaconAbi, "executeAfter", [beaconKey(tsla(), w)])) as bigint;
  await warpTo((executeAt > (await now()) ? executeAt : await now()) + 1n);
  expect(cycle("execute")).toContain("execute: ok actions=1");
  return bookId;
}

beforeAll(async () => {
  await initVault();
  anvil = await startAnvil(["--gas-limit", "60000000"]);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  pub = createPublicClient({ chain, transport: http(anvil.rpc) }) as PublicClient;
  wc = createWalletClient({ chain, transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  deployer = accounts[0]!;
  users = accounts.slice(2, 5);
  wallets = accounts.slice(5, 8);
  merchant = accounts[8]!;

  await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
  await rpc("anvil_setCode", ["0x55649E01B5Df198D18D95b5cc5051630cfD45564", stealthRuntime("ANNOUNCER_RUNTIME")]);
  await rpc("anvil_setCode", ["0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538", stealthRuntime("REGISTRY_RUNTIME")]);
  const f = Bun.spawnSync(["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"], {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, KEEPER_ADDRESS: ANVIL_ADDR_1, MIN_CROWD: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const fout = f.stdout.toString() + f.stderr.toString();
  const line = fout.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
  if (f.exitCode !== 0 || !line) throw new Error(`forge script failed:\n${fout}`);
  dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
  expect(typeof dep.shieldedPool).toBe("string");
  dir = mkdtempSync(join(tmpdir(), "plynth-hidden-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("hidden");

  // Users 0 and 1 choose Hidden and register vault keys derived from a wallet signature; user 2 stays Open.
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, tokenAbi, "mint", [u, 1_000n * U]);
    await tx(u, dep.usdg, tokenAbi, "approve", [dep.savingsVault, 300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 10, multiplier: 1, weeklyCap: 500n * U, fixedTopUp: 0n, mode: i < 2 ? 2 : 0 }]);
    await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: tsla(), weightBps: 10_000 }]]);
    await tx(deployer, dep.usdg, tokenAbi, "mint", [wallets[i]!, 200n * U]);
    await link(u, wallets[i]!);
    if (i < 2) {
      const k = deriveVaultKeys(await wc.signMessage({ account: u, message: VAULT_KEY_MESSAGE }));
      keys.push(k);
      const r = registration(k);
      await tx(u, dep.savingsVault, userVaultAbi, "setHiddenKeys", [r.ownerPk, r.viewingPub]);
    }
  }
}, 240_000);

afterAll(async () => {
  await destroyProver();
  await anvil?.stop();
  await t?.drop();
});

describe("Hidden delivery on anvil", () => {
  test("caps start at 0 and only apply 48h after the deploy proposed them", async () => {
    expect(await read(pool(), poolAdminAbi, "cap", [tsla()])).toBe(0n);
    await warpTo((await now()) + 48n * 3600n + 1n);
    for (const a of [tsla(), dep.usdg]) await tx(deployer, pool(), poolAdminAbi, "applyCap", [a]);
    expect(await read(pool(), poolAdminAbi, "cap", [tsla()])).toBe(10n ** 24n);
  }, 60_000);

  test("execution -> keeper queues one note per Hidden user; nothing secret is stored", async () => {
    expect(await fillAndExecute(5_500_000n)).toBe(0n);
    for (const u of users.slice(0, 2)) alloc.push((await read(dep.crowdBuy, crowdAbi, "allocationOf", [tsla(), 0n, u])) as bigint);
    expect(cycle("deliver-hidden")).toContain("deliver-hidden: ok actions=2"); // 2 delivers, nothing ready to insert yet
    expect(await read(dep.crowdBuy, crowdAbi, "settled", [tsla(), 0n, users[2]!])).toBe(false); // Open user claims herself
    expect(await read(pool(), shieldedPoolAbi, "pendingCount")).toBe(2n);
    expect(await read(tsla(), tokenAbi, "balanceOf", [pool()])).toBe(alloc[0]! + alloc[1]!);
    const rows = await t.sql`select * from keeper_hidden_deliveries order by user_address`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.status === "delivered" && r.commitment)).toBe(true);
    expect(Object.keys(rows[0]!)).not.toContain("blinding");
    expect(cycle("deliver-hidden")).toContain("deliver-hidden: ok actions=0"); // idempotent, still inside the delay
  }, 240_000);

  test("after MIN_PENDING_DELAY the keeper batches the pending notes into the tree", async () => {
    await warpTo((await now()) + 7201n); // two deposits: under MIN_INSERT_BATCH, so MIN_PENDING_DELAY + SOLO_INSERT_DELAY
    expect(keeper("deliver-hidden")).toContain("deliver-hidden: ok actions=1");
    expect(await read(pool(), shieldedPoolAbi, "nextLeaf")).toBe(2n);
  }, 120_000);

  test("SDK: sync + scan finds each user's note with only their keys; transfer; relayed withdraw to a fresh address", async () => {
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const raw = await pub.getLogs({ address: pool(), fromBlock: 0n, toBlock: "latest" });
    expect(state.tree.root()).toBe(BigInt(await read(pool(), shieldedPoolAbi, "currentRoot")));
    const n0 = myNotes(state, keys[0]!);
    const n1 = myNotes(state, keys[1]!);
    expect(n0.map((n) => n.raw)).toEqual([alloc[0]!]);
    expect(n1.map((n) => n.raw)).toEqual([alloc[1]!]);
    expect(n0[0]!.leafIndex).not.toBeNull();

    // user 0 privately sends a third of her note to user 1 (submitted from an unrelated account)
    const part = alloc[0]! / 3n;
    const tr = await proveTransfer({ keys: keys[0]!, tree: state.tree, inputs: n0, to: keys[1]!, raw: part });
    await send(merchant, transferTx(pool(), tr));

    await syncPool(pub, pool(), state);
    const after1 = myNotes(state, keys[1]!);
    expect(balances(after1).get(tsla())).toBe(alloc[1]! + part);
    expect(balances(myNotes(state, keys[0]!)).get(tsla())).toBe(alloc[0]! - part);

    // user 1 withdraws the received note to a fresh address through the relayer, paying a fee
    const received = after1.find((n) => n.raw === part)!;
    const fresh = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    const fee = part / 100n;
    const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
    const account = privateKeyToAccount(RELAYER_KEY);
    // The fee is bound to the relayer's sending address (audit L-9): a proof bound elsewhere is refused.
    const w = await proveWithdraw({ keys: keys[1]!, tree: state.tree, note: received, amount: part, recipient: fresh, relayerFee: fee, relayer: account.address });
    const wrong = await proveWithdraw({ keys: keys[1]!, tree: state.tree, note: received, amount: part, recipient: fresh, relayerFee: fee, relayer: fresh });
    const wallet = createWalletClient({ chain, account, transport: http(anvil.rpc) });
    const plynth = Object.values(dep).filter((v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v));
    const app = relayerApp({
      ...chainDeps({ pub, wallet, account, chain, stealthClaims: dep.stealthClaims, plynth }),
      withdraw: withdrawDeps({ pub, wallet, account, chain, pool: pool(), minFee: () => 1n }),
    });
    const post = (b: unknown) => app.request("/withdraw", { method: "POST", body: JSON.stringify(b) });
    const body = withdrawRequest(w);
    expect((await post({ ...body, pub: { ...body.pub, recipient: dep.savingsVault } })).status).toBe(400); // Plynth contract
    const bad = await post(withdrawRequest(wrong));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain("must bind this relayer");
    const relayerBefore = (await read(tsla(), tokenAbi, "balanceOf", [account.address])) as bigint;
    const r = await post(body);
    const j = (await r.json()) as any;
    expect(r.status, JSON.stringify(j)).toBe(200);
    expect((await pub.getTransactionReceipt({ hash: j.txHash })).from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(await read(tsla(), tokenAbi, "balanceOf", [fresh])).toBe(part - fee);
    expect((await read(tsla(), tokenAbi, "balanceOf", [account.address])) - relayerBefore).toBe(fee);
    expect(await pub.getTransactionCount({ address: fresh })).toBe(0);
    expect((await post(body)).status).toBe(409); // replay: note already spent

    await syncPool(pub, pool(), state);
    expect(balances(myNotes(state, keys[1]!)).get(tsla())).toBe(alloc[1]!);
    expect(await read(pool(), shieldedPoolAbi, "shielded", [tsla()])).toBe(alloc[0]! + alloc[1]! - part);
    expect(await read(tsla(), tokenAbi, "balanceOf", [pool()])).toBe(alloc[0]! + alloc[1]! - part);
  }, 240_000);

  test("a direct USDG deposit queues a note that its origin can take back while pending", async () => {
    const u = users[2]!;
    const k = deriveVaultKeys(await wc.signMessage({ account: u, message: VAULT_KEY_MESSAGE }));
    await send(u, approveTx(dep.usdg, pool(), 25n * U));
    const before = (await read(dep.usdg, tokenAbi, "balanceOf", [u])) as bigint;
    const d = depositTx(pool(), dep.usdg, 25n * U, k);
    await send(u, d);
    const id = ((await read(pool(), shieldedPoolAbi, "pendingCount")) as bigint) - 1n;
    expect(BigInt((await read(pool(), shieldedPoolAbi, "pending", [id])).commitment)).toBe(d.commitment);
    await send(u, refundPendingTx(pool(), id));
    expect(await read(dep.usdg, tokenAbi, "balanceOf", [u])).toBe(before);
    expect(await read(pool(), shieldedPoolAbi, "shielded", [dep.usdg])).toBe(0n);
  }, 60_000);
});
