// Quiet delivery end to end on anvil, against the real ERC-5564 Announcer / ERC-6538 Registry bytecode:
// users register meta-addresses -> crowd executes -> keeper delivers into StealthClaims and releases split parts
// to fresh stealth addresses across executions -> the SDK scan finds them with the viewing key -> the relayer
// claims each part to a fresh address. The user's main wallet never touches a stealth address. Last: a Quiet user
// whose deliver is still pending when they claim openly gets no stealth parts (E1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addressOfPrivateKey, decodeAnnouncementLog, generateKeys, KEY_DERIVATION_MESSAGE, keyForHit, metaAddress, registerTx, scan, signClaim, announcementEvent, type ScanHit, type StealthKeys } from "@plynth/sdk/stealth";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, getAddress, http, pad, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beaconAbi, crowdAbi } from "@/abi/keeper";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { beaconKey } from "@/keeper/jobs/beacon";
import { runDeliverQuiet, type Plan } from "@/keeper/jobs/quiet";
import { Sender, TxUnconfirmed, viemSenderIO } from "@/keeper/sender";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";
import { relayerApp } from "./app";
import { chainDeps } from "./chain";

const RELAYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex; // test-key (anvil #9)
const U = 1_000_000n;
const DAY = 86_400n;

const usdgAbi = parseAbi([
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
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
]);
const scAbi = parseAbi([
  "function pooled(address token) view returns (uint256)",
  "function balanceOf(address token, address stealth) view returns (uint256)",
  "function nonces(address stealth) view returns (uint256)",
]);
const registryAbi = parseAbi(["function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)"]);

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
const keys: StealthKeys[] = [];
const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const alloc0: bigint[] = [];

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
const tsla = () => dep.stocks.mTSLA.token as Address;
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

/** Spends from every linked wallet, then runs passes until a book executes. Returns the executed book id. */
async function fillAndExecute(spendUsd: bigint): Promise<bigint> {
  for (const w of wallets) await tx(w, dep.usdg, usdgAbi, "transfer", [merchant, spendUsd]);
  cycle(); // accrue + sweep into the open book + commit beacons ahead
  const [bookId] = (await read(dep.crowdBuy, crowdAbi, "openBook", [tsla()])) as [bigint, any];
  const w = windowStart(await now()) + DAY;
  await warpTo(w + 5n);
  keeper("beacon"); // reveal
  const executeAt = (await read(dep.jitterBeacon, beaconAbi, "executeAfter", [beaconKey(tsla(), w)])) as bigint;
  await warpTo((executeAt > (await now()) ? executeAt : await now()) + 1n);
  expect(cycle("execute")).toContain("execute: ok actions=1");
  return bookId;
}

async function announcements() {
  const logs = await pub.getLogs({ address: dep.erc5564Announcer, event: announcementEvent, args: { caller: dep.crowdBuy }, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" });
  return logs.map((l) => decodeAnnouncementLog(l as any));
}

beforeAll(async () => {
  anvil = await startAnvil();
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
  expect(typeof dep.stealthClaims).toBe("string");
  dir = mkdtempSync(join(tmpdir(), "plynth-quiet-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("quiet");

  // Users 0 and 1 choose Quiet and register meta-addresses derived from a wallet signature; user 2 stays Open.
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 1_000n * U]);
    await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [{ roundTo: 10, multiplier: 1, weeklyCap: 500n * U, fixedTopUp: 0n, mode: i < 2 ? 1 : 0 }]);
    await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: tsla(), weightBps: 10_000 }]]);
    await tx(deployer, dep.usdg, usdgAbi, "mint", [wallets[i]!, 200n * U]);
    await link(u, wallets[i]!);
    if (i < 2) {
      const k = generateKeys(await wc.signMessage({ account: u, message: KEY_DERIVATION_MESSAGE }));
      keys.push(k);
      const r = registerTx(metaAddress(k), dep.erc6538Registry);
      const hash = await wc.sendTransaction({ account: u, to: r.to, data: r.data, chain: null });
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    }
  }
}, 180_000);

afterAll(async () => {
  await anvil?.stop();
  await t?.drop();
});

describe("Quiet delivery on anvil", () => {
  test("users registered real ERC-6538 meta-addresses", async () => {
    for (const [i, k] of keys.entries()) {
      const onChain = (await read(dep.erc6538Registry, registryAbi, "stealthMetaAddressOf", [users[i]!, 1n])) as Hex;
      expect(`st:eth:${onChain}`).toBe(metaAddress(k));
    }
  });

  test("execution -> keeper delivers Quiet users into the pool and releases part 1 of 2 to fresh stealth addresses", async () => {
    const bookId = await fillAndExecute(5_500_000n); // 5.50 -> 4.50 round-up each
    expect(bookId).toBe(0n);
    for (const u of users.slice(0, 2)) alloc0.push((await read(dep.crowdBuy, crowdAbi, "allocationOf", [tsla(), 0n, u])) as bigint);
    const out = cycle("deliver-quiet");
    expect(out).toContain("deliver-quiet: ok actions=4"); // 2 delivers + 2 first parts
    for (const u of users.slice(0, 2)) expect(await read(dep.crowdBuy, crowdAbi, "settled", [tsla(), 0n, u])).toBe(true);
    expect(await read(dep.crowdBuy, crowdAbi, "settled", [tsla(), 0n, users[2]!])).toBe(false); // Open user claims herself
    const anns = await announcements();
    expect(anns).toHaveLength(2);
    const pooled = (await read(dep.stealthClaims, scAbi, "pooled", [tsla()])) as bigint;
    const released = anns.reduce((a, x) => a + BigInt(`0x${x.metadata.slice(2 + 50, 2 + 114)}`), 0n);
    expect(pooled + released).toBe(alloc0[0]! + alloc0[1]!);
    // idempotent: nothing more until another execution happens
    expect(cycle("deliver-quiet")).toContain("deliver-quiet: ok actions=0");
  }, 180_000);

  test("the remaining parts wait for the next execution, then go out", async () => {
    await fillAndExecute(3_000_000n); // book 1 (3.00 -> 7.00 each)
    const out = cycle("deliver-quiet");
    // book 0: two second parts; book 1: two delivers + two first parts
    expect(out).toContain("deliver-quiet: ok actions=6");
    const plans = await t.sql`select job_key, status, payload from keeper_jobs where kind = 'quiet-plan' and job_key like ${`${tsla().toLowerCase()}:0:%`}`;
    expect(plans).toHaveLength(2);
    for (const p of plans) {
      expect(p.status).toBe("done");
      expect(JSON.stringify(p.payload.parts)).not.toContain("stealth"); // user -> stealth link scrubbed
    }
  }, 180_000);

  let hits: ScanHit[][] = [];
  test("the SDK scan finds each user's parts with only their viewing key; book-0 parts sum to the allocation", async () => {
    const anns = await announcements();
    hits = keys.map((k) => scan(anns, k.viewingPrivateKey, k.spendingPublicKey, { callers: [dep.crowdBuy] }));
    expect(hits[0]!.length).toBe(3); // book 0: 2 parts, book 1: first part
    expect(hits[1]!.length).toBe(3);
    const mine = new Set(hits[0]!.map((h) => h.stealthAddress));
    expect(hits[1]!.some((h) => mine.has(h.stealthAddress))).toBe(false);
    expect(new Set(anns.map((a) => a.stealthAddress)).size).toBe(anns.length); // every stealth address fresh
    for (const [i, hs] of hits.entries()) {
      for (const h of hs) {
        expect(h.token).toBe(tsla());
        expect((await read(dep.stealthClaims, scAbi, "balanceOf", [tsla(), h.stealthAddress])) as bigint).toBe(h.amount!);
      }
      // hs[0] went out in the first pass (book 0, part 1); the other book-0 part is one of the later two
      // (the release order inside a pass is shuffled across users and books)
      expect([hs[0]!.amount! + hs[1]!.amount!, hs[0]!.amount! + hs[2]!.amount!]).toContain(alloc0[i]!);
    }
  });

  test("the relayer claims every part to a fresh address; stealth addresses never hold gas", async () => {
    const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
    const account = privateKeyToAccount(RELAYER_KEY);
    const app = relayerApp({
      ...chainDeps({ pub, wallet: createWalletClient({ chain, account, transport: http(anvil.rpc) }), account, chain, stealthClaims: dep.stealthClaims, plynth: Object.values(dep).filter((v): v is string => typeof v === "string" && v.startsWith("0x")) }),
      now: () => Math.floor(Date.now() / 1000),
    });
    const chainNow = await now();
    for (const [i, hs] of hits.entries()) {
      for (const h of hs) {
        const key = keyForHit(h, keys[i]!);
        expect(addressOfPrivateKey(key)).toBe(h.stealthAddress);
        const fresh = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
        const nonce = (await read(dep.stealthClaims, scAbi, "nonces", [h.stealthAddress])) as bigint;
        const { message, sig } = await signClaim(key, 31337, dep.stealthClaims, { token: tsla(), to: fresh, raw: h.amount!, nonce, deadline: chainNow + 3_600n });
        const body = { token: message.token, stealth: message.stealth, to: message.to, raw: message.raw.toString(), deadline: message.deadline.toString(), sig };
        // a claim into a Plynth contract is refused
        const bad = await app.request("/claim", { method: "POST", body: JSON.stringify({ ...body, to: dep.savingsVault }) });
        expect(bad.status).toBe(400);
        const r = await app.request("/claim", { method: "POST", body: JSON.stringify(body) });
        const j = await r.json();
        expect(r.status, JSON.stringify(j)).toBe(200);
        expect((await pub.getTransactionReceipt({ hash: j.txHash })).from.toLowerCase()).toBe(account.address.toLowerCase());
        expect((await read(tsla(), usdgAbi, "balanceOf", [fresh])) as bigint).toBe(h.amount!);
        expect((await read(dep.stealthClaims, scAbi, "balanceOf", [tsla(), h.stealthAddress])) as bigint).toBe(0n);
        expect(await pub.getBalance({ address: h.stealthAddress })).toBe(0n);
        expect(await pub.getTransactionCount({ address: h.stealthAddress })).toBe(0);
      }
    }
    for (const u of users.slice(0, 2)) expect((await read(tsla(), usdgAbi, "balanceOf", [u])) as bigint).toBe(0n);
  }, 120_000);

  test("no transaction ever names both a user and one of their stealth addresses", async () => {
    const stealths = new Set(hits.flat().map((h) => pad(h.stealthAddress.toLowerCase() as Hex)));
    const userWords = new Set(users.slice(0, 2).map((u) => pad(u.toLowerCase() as Hex)));
    const head = await pub.getBlockNumber();
    let checked = 0;
    for (let b = BigInt(dep.deployBlock); b <= head; b++) {
      const blk = await pub.getBlock({ blockNumber: b, includeTransactions: true });
      for (const txn of blk.transactions) {
        const r = await pub.getTransactionReceipt({ hash: txn.hash });
        const blob = (txn.input + r.logs.map((l) => l.topics.join("") + l.data).join("")).toLowerCase();
        const words = new Set<string>();
        for (const w of [...stealths, ...userWords]) if (blob.includes(w.slice(26))) words.add(w);
        const fromUser = users.slice(0, 2).some((u) => u.toLowerCase() === txn.from.toLowerCase());
        const hasStealth = [...stealths].some((s) => words.has(s));
        const hasUser = fromUser || [...userWords].some((u) => words.has(u));
        expect(hasStealth && hasUser).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  }, 120_000);

  test("relayer CLI boots on a lane port and serves /health", async () => {
    const anvilPort = Number(new URL(anvil.rpc).port);
    let port = anvilPort;
    while (port === anvilPort) port = 8550 + Math.floor(Math.random() * 50); // never the test's own anvil
    const proc = Bun.spawn(["bun", "app/src/bin/relayer.ts"], {
      cwd: ROOT,
      env: { ...process.env, RELAYER_CHAIN: "local", LOCAL_RPC_URL: anvil.rpc, RELAYER_DEPLOYMENTS_DIR: dir, RELAYER_PRIVATE_KEY: RELAYER_KEY, RELAYER_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let body: any;
      for (let i = 0; i < 200 && !body; i++) {
        await Bun.sleep(100);
        body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => undefined);
      }
      expect(body).toMatchObject({ ok: true, chainId: 31337, stealthClaims: dep.stealthClaims });
    } finally {
      proc.kill();
      await proc.exited;
    }
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(out.toLowerCase()).not.toContain(RELAYER_KEY.slice(2));
  }, 60_000);

  test("E1: the keeper's deliver is pending, the user's claimOpen lands first: plan skipped, no stealth parts, the pool still covers everyone else", async () => {
    const bookId = await fillAndExecute(2_000_000n); // book 2; book 1's second parts are due with this execution
    cli("app/src/bin/indexer.ts", { INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir });
    const account = privateKeyToAccount(ANVIL_KEY_1);
    const ctx = {
      chainId: 31337,
      db: t.db,
      pub,
      account: account.address,
      sender: new Sender(viemSenderIO(pub, account, 31337), account.address, { pollMs: 50, waitMs: 1_000 }),
      dep: keeperDeployment(dep as any, 31337),
      lookahead: 2,
      splitParts: 2,
      log: () => {},
    } as unknown as Ctx;
    const owed = async () => {
      const plans = (await t.sql`select job_key, payload from keeper_jobs where kind = 'quiet-plan' and status = 'delivered'`) as unknown as { job_key: string; payload: Plan }[];
      let sum = 0n;
      for (const p of plans) {
        const done = new Set((await t.sql`select job_key from keeper_jobs where kind = 'quiet-part' and status = 'done' and job_key like ${`${p.job_key}:%`}`).map((r) => Number(String(r.job_key).split(":").pop())));
        p.payload.parts.forEach((part, i) => (sum += done.has(i) ? 0n : BigInt(part.raw)));
      }
      return sum;
    };

    await rpc("evm_setAutomine", [false]);
    let racer: Address;
    let ours: Hex;
    try {
      expect(await runDeliverQuiet(ctx).catch((e) => e)).toBeInstanceOf(TxUnconfirmed); // first Quiet candidate's deliver is in the mempool
      const [row] = await t.sql`select payload from keeper_jobs where kind = 'quiet-plan' and job_key like ${`${tsla().toLowerCase()}:${bookId}:%`} and payload ? 'deliverTx'`;
      racer = getAddress(row!.payload.user);
      ours = row!.payload.deliverTx.hash;
      const claim = await wc.writeContract({ account: racer, address: dep.crowdBuy, abi: crowdAbi, functionName: "claimOpen", args: [tsla(), bookId], maxPriorityFeePerGas: 50_000_000_000n, maxFeePerGas: 100_000_000_000n, chain: null } as any);
      await rpc("evm_mine");
      expect((await pub.getTransactionReceipt({ hash: claim })).status).toBe("success");
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    expect((await pub.getTransactionReceipt({ hash: ours })).status).toBe("reverted"); // AlreadySettled: the claim won
    const alloc = (await read(dep.crowdBuy, crowdAbi, "allocationOf", [tsla(), bookId, racer])) as bigint;
    expect(alloc).toBeGreaterThan(0n);
    expect((await read(tsla(), usdgAbi, "balanceOf", [racer])) as bigint).toBe(alloc);

    const res = await runDeliverQuiet(ctx);
    expect(res.notes.join(" ")).toContain("claimed openly");
    const key = `${tsla().toLowerCase()}:${bookId}:${racer.toLowerCase()}`;
    const [plan] = await t.sql`select status, payload from keeper_jobs where kind = 'quiet-plan' and job_key = ${key}`;
    expect(plan!.status).toBe("skipped");
    expect(JSON.stringify(plan!.payload.parts)).not.toContain("stealth");
    expect(await t.sql`select 1 from keeper_jobs where kind = 'quiet-part' and job_key like ${`${key}:%`}`).toHaveLength(0);
    // the other Quiet user was delivered and every part still owed is in the pool
    expect(await pub.getTransactionCount({ address: account.address })).toBeGreaterThan(0);
    expect((await read(dep.stealthClaims, scAbi, "pooled", [tsla()])) as bigint).toBe(await owed());
    expect(cycle("deliver-quiet")).toContain("deliver-quiet: ok actions=0");
    expect((await read(dep.stealthClaims, scAbi, "pooled", [tsla()])) as bigint).toBe(await owed());
    expect(await owed()).toBeGreaterThan(0n); // the other user's second part waits for the next execution
  }, 180_000);
});
