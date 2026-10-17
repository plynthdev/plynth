// fix-keeper-fair, on real anvil (LocalConsumer + the real indexer + an in-process keeper): a user at
// KEEPER_MAX_ACCRUALS_PER_USER_PASS used to end the on-chain round-up scan for every user after them in that pass, and
// the order was always block order, so a busy (or sybil) user who spent first starved everyone else. Now a user at the
// limit is skipped and the rest carry on, users are served least-recently-served first, one spend per user per round,
// and carried dust older than KEEPER_CARRY_MAX_AGE_DAYS is dropped with a recorded reason.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { EXPIRED, runRoundups } from "@/keeper/jobs/roundups";
import { Sender, viemSenderIO } from "@/keeper/sender";
import { ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";

const U = 1_000_000n;
const WEEK = 604_800n;
const usdgAbi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
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
let dep: Record<string, any>;
let dir: string;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let ctx: Ctx;
let users: Address[];
let wallets: Address[];
let merchant: Address;
let accounts: Address[];
let accounts0: Address;
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
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

/** `n` spends of $x.40 (a 60-cent round-up each) from user i's linked wallet. */
async function spend(i: number, n: number) {
  for (let k = 0; k < n; k++) await tx(wallets[i]!, dep.usdg, usdgAbi, "transfer", [merchant, 1_400_000n + BigInt(k) * U]);
}
const doneBy = async () => {
  const rows = (await t.sql`select user_address as u, count(*)::int as n from keeper_roundups where status = 'done' and accrue_tx is not null group by 1`) as unknown as { u: string; n: number }[];
  return users.map((u) => rows.find((r) => r.u === u.toLowerCase())?.n ?? 0);
};

/** Funds `u` (100 USDG deposited, roundTo 1, mTSLA mix) and links spending wallet `w` (funded with 1,000 USDG). */
async function linkUser(u: Address, w: Address) {
  const deployer = accounts0;
  await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 100n * U]);
  await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 100n * U]);
  await tx(u, dep.savingsVault, userVaultAbi, "deposit", [100n * U]);
  await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 1, multiplier: 1, weeklyCap: 50n * U, fixedTopUp: 0n, mode: 0 }]);
  await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: dep.stocks.mTSLA.token, weightBps: 10_000 }]]);
  await tx(deployer, dep.usdg, usdgAbi, "mint", [w, 1_000n * U]);
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

beforeAll(async () => {
  anvil = await startAnvil(["--accounts", "120"]); // 3 users + 50 sybils, each with a linked wallet
  pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  wc = createWalletClient({ transport: http(anvil.rpc) });
  accounts = (await rpc("eth_accounts")) as Address[];
  accounts0 = accounts[0]!;
  users = [accounts[2]!, accounts[3]!, accounts[4]!];
  wallets = [accounts[5]!, accounts[6]!, accounts[7]!];
  merchant = accounts[8]!;
  await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
  const f = Bun.spawnSync(["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"], {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, KEEPER_ADDRESS: privateKeyToAccount(ANVIL_KEY_1).address, MIN_CROWD: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const fout = f.stdout.toString() + f.stderr.toString();
  const line = fout.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
  if (f.exitCode !== 0 || !line) throw new Error(`forge script failed:\n${fout}`);
  dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
  dir = mkdtempSync(join(tmpdir(), "plynth-fair-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("roundups_fair");

  const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
  await rpc("evm_setNextBlockTimestamp", [Number((now / WEEK + 1n) * WEEK + 3_600n)]);
  await rpc("evm_mine");
  for (const [i, u] of users.entries()) await linkUser(u, wallets[i]!);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  const keeperAcct = privateKeyToAccount(ANVIL_KEY_1);
  const kp = createPublicClient({ chain, transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  const sender = new Sender(viemSenderIO(kp, keeperAcct, 31337), keeperAcct.address, { pollMs: 50 });
  ctx = { chainId: 31337, db: t.db, pub: kp, account: keeperAcct.address, sender, dep: keeperDeployment(dep as any, 31337), lookahead: 2, log: () => {} } as unknown as Ctx; // no sealer: the roundups job never seals
}, 600_000); // a LocalConsumer deploy (--slow) plus 3 linked users: minutes on a host loaded by other forge runs

afterAll(async () => {
  await anvil?.stop();
  await t?.drop();
});

describe("on-chain round-ups: fair per pass and across passes (real anvil)", () => {
  test("a user at the per-user pass limit does not block the users after them", async () => {
    await spend(0, 6); // the busy user spends first: block order puts all 6 ahead of the others
    await spend(1, 2);
    await spend(2, 2);
    indexer();
    const r = await runRoundups({ ...ctx, accrueLimits: { perPass: 200, perUserWeek: 100, perUserPass: 2 } });
    expect(r.ok).toBe(true);
    expect(await doneBy()).toEqual([2, 2, 2]); // before: [2, 0, 0], the scan stopped at the busy user's limit
    expect(r.notes.some((n) => n.startsWith(users[0]!.toLowerCase()) && n.includes("pass limit"))).toBe(true);
    // the busy user's other 4 spends stay open and go out on later passes
    await runRoundups({ ...ctx, accrueLimits: { perPass: 200, perUserWeek: 100, perUserPass: 2 } });
    await runRoundups({ ...ctx, accrueLimits: { perPass: 200, perUserWeek: 100, perUserPass: 2 } });
    expect(await doneBy()).toEqual([6, 2, 2]);
  }, 180_000);

  test("fair across 3 passes: with room for 2 accrues a pass, every user is served, nobody is always last", async () => {
    for (const i of [0, 1, 2]) await spend(i, 3);
    indexer();
    const perPass: number[][] = [];
    const start = await doneBy(); // after the first test: [6, 2, 2]
    let before = start;
    for (let p = 0; p < 3; p++) {
      await runRoundups({ ...ctx, accrueLimits: { perPass: 2, perUserWeek: 100 } });
      const now = await doneBy();
      perPass.push(now.map((n, i) => n - before[i]!));
      before = now;
    }
    // block order alone would have given the first user every slot: [2,0,0] three times
    expect(before.map((n, i) => n - start[i]!)).toEqual([2, 2, 2]);
    for (const p of perPass) expect(p.reduce((a, b) => a + b, 0)).toBe(2);
    for (let i = 0; i < 3; i++) expect(perPass.filter((p) => p[i]! > 0).length, `user ${i}`).toBeGreaterThanOrEqual(2);
  }, 180_000);

  test("review v5 R5-SVC-1: 50 fresh sybil wallets cannot delay a returning user's older spend past one pass", async () => {
    const returning = users[1]!.toLowerCase(); // served in the tests above
    await spend(1, 1); // the returning user's new spend: older than the flood below
    indexer();
    const sybils = Array.from({ length: 50 }, (_, i) => ({ u: accounts[10 + i]!, w: accounts[60 + i]! }));
    for (const { u, w } of sybils) await linkUser(u, w);
    for (const { w } of sybils) await tx(w, dep.usdg, usdgAbi, "transfer", [merchant, 1_400_000n]); // 60-cent round-ups
    indexer();
    const before = (await t.sql`select count(*)::int as n from keeper_roundups where user_address = ${returning} and status = 'done' and accrue_tx is not null`)[0]!.n as number;
    // room for 10 accrues in the pass: before the fix the 50 never-served wallets all sorted ahead of the returning user
    await runRoundups({ ...ctx, accrueLimits: { perPass: 10, perUserWeek: 100 } });
    const after = (await t.sql`select count(*)::int as n from keeper_roundups where user_address = ${returning} and status = 'done' and accrue_tx is not null`)[0]!.n as number;
    expect(after - before).toBe(1);
    const sybilsServed = (await t.sql`select count(distinct user_address)::int as n from keeper_roundups where status = 'done' and accrue_tx is not null and user_address in ${t.sql(sybils.map((x) => x.u.toLowerCase()))}`)[0]!.n as number;
    // the rest of the pass went to older leftovers of the tests above and then to the flood, in spend order
    expect(sybilsServed).toBeGreaterThan(0);
    expect(sybilsServed).toBeLessThanOrEqual(9);
  }, 600_000);

  test("carried dust older than the carry period is dropped with a reason; younger dust stays carried", async () => {
    const lu = users[1]!.toLowerCase();
    const row = (h: string, ageDays: number) => t.sql`insert into keeper_roundups (chain_id, tx_hash, log_index, block_number, wallet, to_address, spend, status, reason, user_address, created_at)
      values (31337, ${h}, 0, 1, ${wallets[1]!.toLowerCase()}, ${merchant.toLowerCase()}, '999999', 'carried', 'carried: this user''s carried round-ups are still under the keeper minimum', ${lu}, now() - make_interval(days => ${ageDays}))`;
    await row(`0x${"a1".repeat(32)}`, 31);
    await row(`0x${"a2".repeat(32)}`, 2);
    const r = await runRoundups({ ...ctx, accrueLimits: { perPass: 200, perUserWeek: 100, carryMaxAgeDays: 30 } });
    expect(r.notes.join(" ")).toContain("1 carried round-up(s) expired after 30 days");
    const rows = (await t.sql`select tx_hash, status, reason from keeper_roundups where user_address = ${lu} and tx_hash like '0xa%' order by tx_hash`) as unknown as { status: string; reason: string }[];
    expect(rows.map((x) => [x.status, x.reason === EXPIRED])).toEqual([["skipped", true], ["carried", false]]);
  }, 60_000);
});
