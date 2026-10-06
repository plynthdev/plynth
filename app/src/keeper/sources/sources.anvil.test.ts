// Todo 23 end to end on anvil: one saver with three sources at once (an on-chain USDG spend, an imported
// CSV statement through the API route, and a Plaid item mocked at HTTP level). The vault's weekly cap holds
// across all of them; replays are refused by the vault; an unlinked source accrues nothing; rows older than
// the lookback are skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { http as mswHttp, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { roundupMessage, roundupRoutes } from "@/api";
import { vaultAbi } from "@/abi/keeper";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { runRoundups } from "@/keeper/jobs/roundups";
import { runSpends } from "@/keeper/jobs/spends";
import { runPass } from "@/keeper/keeper";
import { Sealer } from "@/keeper/seal";
import { Sender, viemSenderIO } from "@/keeper/sender";
import { plaidAad, sha256Hex, upsertSource } from "./";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";

const U = 1_000_000n;
const WEEK = 604_800n;
const ALICE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // test-key (anvil #2)
const BOB_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // test-key (anvil #3)
const alice = privateKeyToAccount(ALICE_KEY);
const bob = privateKeyToAccount(BOB_KEY);

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

const plaidServer = setupServer(
  mswHttp.post(`${PlaidEnvironments.sandbox}/transactions/sync`, async ({ request }) => {
    const body = (await request.json()) as any;
    if (body.access_token !== "access-sandbox-alice") return HttpResponse.json({ error_code: "INVALID_ACCESS_TOKEN" }, { status: 400 });
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tx = (id: string, amount: number) => ({ transaction_id: id, account_id: "a", amount, iso_currency_code: "USD", unofficial_currency_code: null, date: day, authorized_date: null, pending: false, merchant_name: "M", name: "M" });
    if (body.cursor) return HttpResponse.json({ added: [], modified: [], removed: [], next_cursor: body.cursor, has_more: false });
    return HttpResponse.json({ added: [tx("pl-1", 12.3), tx("pl-2", 7.8), tx("pl-3", -40)], modified: [], removed: [], next_cursor: "cur-1", has_more: false });
  }),
);

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dep: Record<string, any>;
let dir: string;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let ctx: Ctx;
let sender: Sender;
let wallet: Address;
let merchant: Address;
let api: ReturnType<typeof roundupRoutes>;
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

async function importCsv(who: typeof alice, content: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await who.signMessage({ message: roundupMessage({ action: "import", user: who.address, chainId: 31337, subject: sha256Hex(content), issuedAt }) });
  const r = await api.request("/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: who.address, content, issuedAt, signature }) });
  expect(r.status).toBe(200);
  return (await r.json()) as any;
}

const us = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
const account = async (u: Address) => (await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "accountOf", args: [u] })) as any;

beforeAll(async () => {
  plaidServer.listen({ onUnhandledRequest: "bypass" });
  anvil = await startAnvil();
  pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  wc = createWalletClient({ transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  expect(accounts[2]!.toLowerCase()).toBe(alice.address.toLowerCase());
  expect(accounts[3]!.toLowerCase()).toBe(bob.address.toLowerCase());
  wallet = accounts[5]!;
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
  dir = mkdtempSync(join(tmpdir(), "plynth-sources-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("sources_e2e");

  // Start a fresh vault week so every accrual below lands in one week.
  const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
  await rpc("evm_setNextBlockTimestamp", [Number((now / WEEK + 1n) * WEEK + 3_600n)]);
  await rpc("evm_mine");

  const deployer = accounts[0]!;
  for (const u of [alice.address, bob.address]) {
    await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 100n * U]);
    await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 100n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [100n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 1, multiplier: 1, weeklyCap: 3n * U, fixedTopUp: 0n, mode: 0 }]);
    await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: dep.stocks.mTSLA.token, weightBps: 10_000 }]]);
  }
  // Alice's linked spending wallet spends 1.40 USDG on-chain (round-up 0.60).
  await tx(deployer, dep.usdg, usdgAbi, "mint", [wallet, 10n * U]);
  const nonce = (await pub.readContract({ address: dep.savingsVault, abi: userVaultAbi, functionName: "linkNonce", args: [wallet] })) as bigint;
  const deadline = (await pub.getBlock({ blockTag: "latest" })).timestamp + 3600n;
  const sig = await wc.signTypedData({
    account: wallet,
    domain: { name: "Plynth SavingsVault", version: "1", chainId: 31337, verifyingContract: dep.savingsVault },
    types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "LinkWallet",
    message: { user: alice.address, wallet, nonce, deadline },
  });
  await tx(alice.address, dep.savingsVault, userVaultAbi, "linkSpendingWallet", [wallet, deadline, sig]);
  await tx(wallet, dep.usdg, usdgAbi, "transfer", [merchant, 1_400_000n]);

  // In-process keeper (anvil key #1) with a Plaid client whose HTTP is mocked.
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  const keeperAcct = privateKeyToAccount(ANVIL_KEY_1);
  const kp = createPublicClient({ chain, transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  sender = new Sender(viemSenderIO(kp, keeperAcct, 31337), keeperAcct.address, { pollMs: 50 });
  const sealer = await Sealer.create(crypto.getRandomValues(new Uint8Array(32)));
  const plaid = new PlaidApi(new Configuration({ basePath: PlaidEnvironments.sandbox!, baseOptions: { headers: { "PLAID-CLIENT-ID": "c", "PLAID-SECRET": "s" } } }));
  ctx = { chainId: 31337, db: t.db, pub: kp, account: keeperAcct.address, sender, sealer, dep: keeperDeployment(dep as any, 31337), lookahead: 2, plaid, log: () => {} };
  api = roundupRoutes({ chainId: 31337, db: t.db, sealer });

  // Alice: a Plaid item (as /plaid/exchange would store it) and a CSV statement.
  await upsertSource(ctx, alice.address, "plaid", "item-a", await sealer.seal(new TextEncoder().encode("access-sandbox-alice"), plaidAad(31337, alice.address, "item-a")));
}, 120_000);

afterAll(async () => {
  plaidServer.close();
  await anvil?.stop();
  await t?.drop();
});

const indexer = () => {
  const r = Bun.spawnSync(["bun", "app/src/bin/indexer.ts", "--once"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: t.url, LOCAL_RPC_URL: anvil.rpc, INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stdout.toString() + r.stderr.toString());
};
const JOBS: Parameters<typeof runPass>[1] = [
  ["roundups", runRoundups],
  ["spends", runSpends],
];

describe("round-up sources on anvil", () => {
  test("weekly cap respected across on-chain, statement and Plaid sources", async () => {
    const csv = [
      "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
      `${us(2)},${us(1)},COFFEE,Food,Sale,-4.35,`, // 0.65
      `${us(2)},${us(1)},GROCER,Groceries,Sale,-52.10,`, // 0.90
      `${us(1)},${us(1)},TRANSIT,Travel,Sale,-2.75,`, // 0.25
      `${us(40)},${us(40)},OLD,Misc,Sale,-0.01,`, // older than the 30-day lookback
    ].join("\n");
    expect(await importCsv(alice, csv)).toMatchObject({ imported: 4 });
    // Bob imports, then unlinks before the keeper runs: nothing of his may accrue.
    expect(await importCsv(bob, `Date,Description,Amount\n${us(1)},Shop,-9.10\n`)).toMatchObject({ imported: 1 });
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await bob.signMessage({ message: roundupMessage({ action: "unlink", user: bob.address, chainId: 31337, subject: "statement:statement", issuedAt }) });
    const un = await api.request("/sources/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: bob.address, kind: "statement", issuedAt, signature }) });
    expect(un.status).toBe(200);

    indexer();
    const report = await runPass(ctx, JOBS);
    expect(report.ok).toBe(true);

    // Round-ups: on-chain 0.60 + statement 0.65 + 0.90 + 0.25 + Plaid 0.70 + 0.20 = 3.30 > cap 3.00.
    const a = await account(alice.address);
    expect(a.accruedThisWeek).toBe(3n * U);
    expect(a.pending).toBe(3n * U);
    expect(a.available).toBe(97n * U);
    const ev = await t.sql`select source, status, reason, added, amount_cents from roundup_events where user_address = ${alice.address.toLowerCase()}`;
    const onchain = await t.sql`select added from keeper_roundups where status = 'done'`;
    const total = ev.filter((r) => r.status === "done").reduce((s, r) => s + BigInt(r.added ?? 0), 0n) + onchain.reduce((s, r) => s + BigInt(r.added), 0n);
    expect(total).toBe(3n * U);
    expect(ev.filter((r) => r.status === "done")).toHaveLength(5); // 3 statement + 2 Plaid (the refund was never stored)
    expect(ev.find((r) => Number(r.amount_cents) === 1)).toMatchObject({ status: "skipped", reason: "older than 30 days before the source was linked" });
    expect(onchain.map((r) => BigInt(r.added))).toEqual([600_000n]);

    const b = await account(bob.address);
    expect(b.pending).toBe(0n);
    const [bobRow] = await t.sql`select status from roundup_events where user_address = ${bob.address.toLowerCase()}`;
    expect(bobRow!.status).toBe("new");
  }, 60_000);

  test("idempotent: another pass sends nothing", async () => {
    const sent = sender.sent;
    indexer();
    const r = await runPass(ctx, JOBS);
    expect(r.jobs.map((j) => j.actions)).toEqual([0, 0]);
    expect(sender.sent).toBe(sent);
  }, 60_000);

  test("replay protection: if the keeper forgets what it did, the vault refuses every repeat (AlreadyAccrued)", async () => {
    await t.sql`update roundup_events set status = 'new', added = null where user_address = ${alice.address.toLowerCase()} and status = 'done'`;
    const sent = sender.sent;
    const r = await runPass(ctx, JOBS);
    expect(r.ok).toBe(true);
    expect(sender.sent).toBe(sent);
    const rows = await t.sql`select status, reason from roundup_events where user_address = ${alice.address.toLowerCase()} and status <> 'skipped'`;
    expect(rows.every((x) => x.status === "done" && x.reason === "already accrued")).toBe(true);
    expect((await account(alice.address)).accruedThisWeek).toBe(3n * U);
  }, 60_000);

  test("Plaid cursor persisted after the sync", async () => {
    const [s] = await t.sql`select cursor, last_error from roundup_sources where source_key = 'item-a'`;
    expect(s).toEqual({ cursor: "cur-1", last_error: null });
  });
});
