// Review v3 R3-SVC-2 follow-up, on anvil with the real SavingsVault: on-chain round-ups under the 5-cent minimum are
// no longer dropped. Each is carried (one keeper_roundups row per spend key) and, once a user's carried round-ups add
// up to 5 cents, the keeper sends ONE vault.accrueBatch for them. Restarts and re-indexing never count a spend twice,
// a key the vault already has reverts the batch and is recorded without stopping other users, and a batch never
// holds more than MAX_ACCRUE_BATCH spends.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vaultAbi } from "@/abi/keeper";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { Sender, viemSenderIO } from "@/keeper/sender";
import { AccrueGate, accruedFromReceipt, DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS, MAX_ACCRUE_BATCH } from "@/keeper/sources/accrue";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";
import { runRoundups, WAITING } from "./roundups";

const U = 1_000_000n;
const WEEK = 604_800n;
const DUST = 990_000n; // 0.99 USDG: a 1-cent round-up at roundTo 1, multiplier 1

const usdgAbi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
const userVaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "function deposit(uint256 amount)",
  "function setSettings(Settings s)",
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
]);

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dep: Record<string, any>;
let dir: string;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let ctx: Ctx;
let sender: Sender;
let users: Address[]; // alice, bob, carol
let wallets: Address[];
let merchant: Address;
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

/** n USDG transfers of `amount` from user i's linked wallet; returns their (txHash, logIndex). */
async function spends(i: number, n: number, amount = DUST) {
  const out: { hash: Hex; logIndex: number }[] = [];
  for (let k = 0; k < n; k++) {
    const r = await tx(wallets[i]!, dep.usdg, usdgAbi, "transfer", [merchant, amount]);
    out.push({ hash: r.transactionHash, logIndex: r.logs[0]!.logIndex });
  }
  return out;
}

const indexer = () => {
  const r = Bun.spawnSync(["bun", "app/src/bin/indexer.ts", "--once"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: t.url, LOCAL_RPC_URL: anvil.rpc, INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stdout.toString() + r.stderr.toString());
};

/** One keeper roundups pass with a fresh gate, as a restarted keeper would run it. */
const pass = (limits: ConstructorParameters<typeof AccrueGate>[1] = {}) => runRoundups(ctx, new AccrueGate(ctx, { minAccrueCents: DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS, ...limits }));
const keeperNonce = () => pub.getTransactionCount({ address: ANVIL_ADDR_1 as Address });
const pending = async (u: Address) => ((await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "balancesOf", args: [u] })) as readonly [bigint, bigint])[1];
const rowsOf = async (u: Address) =>
  (await t.sql`select tx_hash, log_index, status, reason, added, accrue_tx from keeper_roundups where user_address = ${u.toLowerCase()} order by block_number, log_index`) as unknown as {
    tx_hash: string;
    log_index: number;
    status: string;
    reason: string | null;
    added: string | null;
    accrue_tx: string | null;
  }[];

/** The decoded accrueBatch call of a keeper transaction, and its receipt's Accrued events. */
async function batchOf(hash: Hex) {
  const txn = await pub.getTransaction({ hash });
  const call = decodeFunctionData({ abi: vaultAbi, data: txn.input });
  const receipt = await pub.getTransactionReceipt({ hash });
  return { call, accrued: accruedFromReceipt(receipt, dep.savingsVault) };
}

beforeAll(async () => {
  anvil = await startAnvil();
  pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  wc = createWalletClient({ transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  users = accounts.slice(2, 5);
  wallets = accounts.slice(5, 8);
  merchant = accounts[8]!;

  await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
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
  dir = mkdtempSync(join(tmpdir(), "plynth-carry-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("carry");

  // A fresh vault week so every accrual below lands in one week.
  const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
  await rpc("evm_setNextBlockTimestamp", [Number((now / WEEK + 1n) * WEEK + 3_600n)]);
  await rpc("evm_mine");

  const deployer = accounts[0]!;
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 100n * U]);
    await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 100n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [100n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 1, multiplier: 1, weeklyCap: 100n * U, fixedTopUp: 0n, mode: 0 }]);
    const w = wallets[i]!;
    await tx(deployer, dep.usdg, usdgAbi, "mint", [w, 100n * U]);
    const nonce = (await pub.readContract({ address: dep.savingsVault, abi: userVaultAbi, functionName: "linkNonce", args: [w] })) as bigint;
    const deadline = (await pub.getBlock({ blockTag: "latest" })).timestamp + 3600n;
    const sig = await wc.signTypedData({
      account: w,
      domain: { name: "Plynth SavingsVault", version: "1", chainId: 31337, verifyingContract: dep.savingsVault },
      types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "LinkWallet",
      message: { user: u, wallet: w, nonce, deadline },
    });
    await tx(u, dep.savingsVault, userVaultAbi, "linkSpendingWallet", [w, deadline, sig]);
  }

  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  const keeperAcct = privateKeyToAccount(ANVIL_KEY_1);
  const kp = createPublicClient({ chain, transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  sender = new Sender(viemSenderIO(kp, keeperAcct, 31337), keeperAcct.address, { pollMs: 50 });
  ctx = { chainId: 31337, db: t.db, pub: kp, account: keeperAcct.address, sender, dep: keeperDeployment(dep as any, 31337), lookahead: 2, log: () => {} } as unknown as Ctx;
}, 180_000);

afterAll(async () => {
  await anvil?.stop();
  await t?.drop();
});

describe("carried on-chain round-ups on anvil (review v3 R3-SVC-2)", () => {
  test("the TS bound mirrors the contract's MAX_ACCRUE_BATCH", async () => {
    expect(await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "MAX_ACCRUE_BATCH" })).toBe(BigInt(MAX_ACCRUE_BATCH));
  });

  test("5 x 1-cent round-ups: carried across passes and restarts, then exactly one accrueBatch", async () => {
    const [alice] = users as [Address];
    await spends(0, 3);
    indexer();
    const n0 = await keeperNonce();
    expect((await pass()).actions).toBe(0); // 3 cents carried: not worth a transaction yet
    let rows = await rowsOf(alice);
    expect(rows.map((r) => r.status)).toEqual(["carried", "carried", "carried"]);
    expect(rows.every((r) => r.reason === WAITING)).toBe(true); // weighed once: 3 cents, under the 5-cent minimum

    // A restarted keeper (new pass, new gate) and a re-index over the same rows: still 3, nothing sent.
    indexer();
    expect((await pass()).actions).toBe(0);
    expect(await rowsOf(alice)).toEqual(rows);
    expect(await keeperNonce()).toBe(n0);

    await spends(0, 2);
    indexer();
    const res = await pass();
    expect(res.actions).toBe(1);
    expect(await keeperNonce()).toBe(n0 + 1); // ONE keeper transaction for five round-ups
    rows = await rowsOf(alice);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "done" && r.added === "10000" && r.reason === "carried round-up, sent in a batch")).toBe(true);
    const hashes = new Set(rows.map((r) => r.accrue_tx));
    expect(hashes.size).toBe(1);
    const { call, accrued } = await batchOf([...hashes][0] as Hex);
    expect(call.functionName).toBe("accrueBatch");
    expect((call.args![1] as readonly Hex[]).length).toBe(5);
    expect(accrued.size).toBe(5); // one Accrued per spend
    expect(await pending(alice)).toBe(50_000n);

    // Restart again: nothing left, nothing resent.
    indexer();
    expect((await pass()).actions).toBe(0);
    expect(await keeperNonce()).toBe(n0 + 1);

    // The keeper died after the batch was mined but before recording it: the rows look carried again. The vault's
    // replay guard refuses every key; the keeper marks them done "already accrued" and sends nothing.
    await t.sql`update keeper_roundups set status = 'carried', accrue_tx = null, added = null where user_address = ${alice.toLowerCase()}`;
    const again = await pass();
    expect(again.actions).toBe(0);
    expect(await keeperNonce()).toBe(n0 + 1);
    expect((await rowsOf(alice)).every((r) => r.status === "done" && r.reason === "already accrued")).toBe(true);
    expect(await pending(alice)).toBe(50_000n); // not counted twice
  }, 120_000);

  test("a key the vault already has reverts the real batch; the keeper records it and goes on (other users too)", async () => {
    const [, bob, carol] = users as [Address, Address, Address];
    const b = await spends(1, 6);
    await spends(2, 5);
    indexer();
    // Something already accrued bob's 3rd spend (an older keeper, a single accrue).
    await tx(ANVIL_ADDR_1 as Address, dep.savingsVault, vaultAbi, "accrue", [bob, b[2]!.hash, b[2]!.logIndex, DUST]);
    const bobPending = await pending(bob);
    expect(bobPending).toBe(10_000n);
    // The real contract refuses the whole batch with that key in it.
    await expect(
      pub.simulateContract({ account: ANVIL_ADDR_1 as Address, address: dep.savingsVault, abi: vaultAbi, functionName: "accrueBatch", args: [bob, b.map((x) => x.hash), b.map((x) => x.logIndex), b.map(() => DUST)] }),
    ).rejects.toThrow(/AlreadyAccrued/);

    const n0 = await keeperNonce();
    const res = await pass();
    expect(res.notes.some((n) => /1 spend\(s\) already accrued, sending the rest/.test(n))).toBe(true);
    expect(res.actions).toBe(2); // bob's remaining five, and carol's five
    expect(await keeperNonce()).toBe(n0 + 2);

    const bobRows = await rowsOf(bob);
    expect(bobRows.find((r) => r.tx_hash === b[2]!.hash.toLowerCase())).toMatchObject({ status: "done", reason: "already accrued", accrue_tx: null });
    expect(bobRows.filter((r) => r.accrue_tx !== null)).toHaveLength(5);
    expect(await pending(bob)).toBe(60_000n); // 1 cent once per spend, the replayed one not twice
    expect((await rowsOf(carol)).every((r) => r.status === "done" && r.added === "10000")).toBe(true);
    expect(await pending(carol)).toBe(50_000n);
  }, 120_000);

  test("40 carried spends: batches of at most MAX_ACCRUE_BATCH, within the per-user pass budget", async () => {
    const [alice] = users as [Address];
    const before = await pending(alice);
    await spends(0, 40);
    indexer();
    const n0 = await keeperNonce();

    // One accrual per user per pass: one batch of 32 now, the other 8 stay carried.
    const p1 = await pass({ perUserPass: 1 });
    expect(p1.actions).toBe(1);
    expect(p1.notes.some((n) => n.startsWith("pass limit of 1 accruals for this user reached"))).toBe(true);
    let rows = (await rowsOf(alice)).slice(-40);
    expect(rows.filter((r) => r.status === "done")).toHaveLength(MAX_ACCRUE_BATCH);
    expect(rows.filter((r) => r.status === "carried")).toHaveLength(40 - MAX_ACCRUE_BATCH);

    // Next pass sends the remaining 8.
    const p2 = await pass();
    expect(p2.actions).toBe(1);
    expect(await keeperNonce()).toBe(n0 + 2);
    rows = (await rowsOf(alice)).slice(-40);
    expect(rows.every((r) => r.status === "done" && r.added === "10000")).toBe(true);
    const byTx = new Map<string, number>();
    for (const r of rows) byTx.set(r.accrue_tx!, (byTx.get(r.accrue_tx!) ?? 0) + 1);
    expect([...byTx.values()].sort((x, y) => y - x)).toEqual([MAX_ACCRUE_BATCH, 40 - MAX_ACCRUE_BATCH]);
    for (const h of byTx.keys()) {
      const { call } = await batchOf(h as Hex);
      expect((call.args![1] as readonly Hex[]).length).toBeLessThanOrEqual(MAX_ACCRUE_BATCH);
    }
    expect((await pending(alice)) - before).toBe(400_000n);

    // Default budget: 40 more go out as 32 + 8 in a single pass.
    await spends(0, 40);
    indexer();
    const p3 = await pass();
    expect(p3.actions).toBe(2);
    expect(await keeperNonce()).toBe(n0 + 4);
  }, 180_000);

  test("carried round-ups the vault would now credit 0 for are skipped with the gate's reason", async () => {
    const [, , carol] = users as [Address, Address, Address];
    await spends(2, 2);
    indexer();
    expect((await pass()).actions).toBe(0);
    expect((await rowsOf(carol)).slice(-2).map((r) => [r.status, r.reason])).toEqual([["carried", WAITING], ["carried", WAITING]]);
    // As a keeper that stopped between carrying and weighing them would leave them: carried, not yet weighed.
    await t.sql`update keeper_roundups set reason = 'round-up below the keeper minimum of 5 cents per accrual; carried' where user_address = ${carol.toLowerCase()} and status = 'carried'`;
    // Carol's weekly room is gone: she lowers her cap under what she has already accrued this week.
    await tx(carol, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 1, multiplier: 1, weeklyCap: 10_000n, fixedTopUp: 0n, mode: 0 }]);
    const n0 = await keeperNonce();
    expect((await pass()).actions).toBe(0);
    expect(await keeperNonce()).toBe(n0);
    expect((await rowsOf(carol)).slice(-2).map((r) => [r.status, r.reason])).toEqual([
      ["skipped", "weekly cap reached: the vault would add 0"],
      ["skipped", "weekly cap reached: the vault would add 0"],
    ]);
  }, 120_000);
});
