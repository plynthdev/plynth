// End to end on anvil: the consumer stack (forge script, MIN_CROWD = 3), three savers with linked spending
// wallets, and the real CLIs: `indexer --once` + `keeper --once`, run repeatedly while time is warped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { beaconAbi, crowdAbi, vaultAbi } from "@/abi/keeper";
import { beaconKey } from "./jobs/beacon";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ANVIL_KEY_1, ROOT, keeperTestDb, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";

const U = 1_000_000n;
const DAY = 86_400n;
const GRACE = 3_600n;

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
const permit2UserAbi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

/** SavingsVault.roundUp (R1): (ceil(spend / u) * u - spend) * multiplier, u = roundTo whole USDG. */
const r1 = (spend: bigint, roundTo: bigint, mult: bigint) => {
  const u = roundTo * U;
  const rem = spend % u;
  return rem === 0n ? 0n : (u - rem) * mult;
};

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let t: Awaited<ReturnType<typeof keeperTestDb>>;
let dir: string;
let dep: Record<string, any>;
let accounts: Address[];
let users: Address[];
let wallets: Address[];
let merchant: Address;
let deployer: Address;
let pub: ReturnType<typeof createPublicClient>;
let wc: ReturnType<typeof createWalletClient>;
const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const outputs: string[] = [];

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

function cli(script: string, env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", script, "--once"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: t.url, LOCAL_RPC_URL: anvil.rpc, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  outputs.push(out);
  if (r.exitCode !== 0) throw new Error(`${script} --once failed:\n${out}`);
  return out;
}

const indexer = () => cli("app/src/bin/indexer.ts", { INDEXER_CHAIN: "local", INDEXER_DEPLOYMENTS_DIR: dir });
const keeper = (jobs?: string) =>
  cli("app/src/bin/keeper.ts", {
    KEEPER_CHAIN: "local",
    KEEPER_DEPLOYMENTS_DIR: dir,
    KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
    KEEPER_SECRET_KEY: secretKey,
    ...(jobs ? { KEEPER_JOBS: jobs } : {}),
  });
const cycle = () => {
  indexer();
  return keeper();
};

/** The keeper reveals only at the execution time (the beacon refuses earlier reveals): run beacon passes in
 *  2h steps until it has revealed `key`. Returns the reveal time and the last pass time that did not reveal. */
async function revealByKeeper(key: Hex, jobs = "topups,roundups,sweep,beacon"): Promise<{ executeAt: bigint; lastWithout?: bigint }> {
  let lastWithout: bigint | undefined;
  const b = (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "beacon", args: [key] })) as { windowEnd: bigint };
  const deadline = BigInt(b.windowEnd) - GRACE; // reveals are refused from here on
  for (let i = 0; i < 40; i++) {
    keeper(jobs);
    const st = (await t.sql`select status from keeper_jobs where job_key = ${key.toLowerCase()}`)[0]?.status;
    if (st === "revealed") {
      const executeAt = (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "executeAfter", args: [key] })) as bigint;
      return lastWithout === undefined ? { executeAt } : { executeAt, lastWithout };
    }
    lastWithout = await now();
    const left = deadline - lastWithout;
    const step = left / 2n > 7_200n ? 7_200n : left / 2n > 30n ? left / 2n : 30n; // never jump past the deadline
    await warpTo(lastWithout + step);
  }
  throw new Error("the keeper never revealed");
}

async function now(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: "latest" })).timestamp;
}
async function warpTo(ts: bigint) {
  await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
  await rpc("evm_mine");
}
function windowOf(ts: bigint) {
  const g = BigInt(dep.genesis);
  const start = g + ((ts - g) / DAY) * DAY;
  return { start, end: start + DAY };
}
const book = async (bookId: bigint) => (await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "book", args: [dep.stocks.mTSLA.token, bookId] })) as any;
const tsla = () => dep.stocks.mTSLA.token as Address;

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

async function spend(wallet: Address, to: Address, amount: bigint) {
  await tx(wallet, dep.usdg, usdgAbi, "transfer", [to, amount]);
}

beforeAll(async () => {
  anvil = await startAnvil();
  pub = createPublicClient({ transport: http(anvil.rpc) });
  wc = createWalletClient({ transport: http(anvil.rpc) });
  accounts = (await rpc("eth_accounts")) as Address[];
  deployer = accounts[0]!;
  users = accounts.slice(2, 5);
  wallets = accounts.slice(5, 8);
  merchant = accounts[8]!;
  expect(accounts[1]!.toLowerCase()).toBe(ANVIL_ADDR_1.toLowerCase());

  await rpc("anvil_setCode", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Runtime()]);
  const f = Bun.spawnSync(
    ["forge", "script", "script/LocalConsumer.s.sol:LocalConsumer", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"],
    { cwd: join(ROOT, "contracts"), env: { ...process.env, KEEPER_ADDRESS: ANVIL_ADDR_1, MIN_CROWD: "3" }, stdout: "pipe", stderr: "pipe" },
  );
  const fout = f.stdout.toString() + f.stderr.toString();
  const line = fout.split("\n").find((l) => l.includes("PLYNTH_DEPLOYMENT "));
  if (f.exitCode !== 0 || !line) throw new Error(`forge script failed:\n${fout}`);
  dep = JSON.parse(line.slice(line.indexOf("PLYNTH_DEPLOYMENT ") + "PLYNTH_DEPLOYMENT ".length));
  expect((await pub.getCode({ address: dep.crowdBuy }))?.length).toBeGreaterThan(2);
  dir = mkdtempSync(join(tmpdir(), "plynth-keeper-"));
  writeFileSync(join(dir, "31337.json"), JSON.stringify(dep));
  t = await keeperTestDb("e2e");

  // Three savers: deposit 300, settings, mix = 100% mTSLA. User 0 also has a 25 USDG weekly top-up via Permit2.
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, usdgAbi, "mint", [u, 1_000n * U]);
    await tx(u, dep.usdg, usdgAbi, "approve", [dep.savingsVault, 300n * U]);
    await tx(u, dep.savingsVault, userVaultAbi, "deposit", [300n * U]);
    const s = { roundTo: i === 1 ? 5 : 1, multiplier: i === 0 ? 2 : 1, weeklyCap: 500n * U, fixedTopUp: i === 0 ? 25n * U : 0n, mode: 0 };
    await tx(u, dep.savingsVault, userVaultAbi, "setSettings", [s]);
    await tx(u, dep.savingsVault, userVaultAbi, "setMix", [[{ stockToken: tsla(), weightBps: 10_000 }]]);
    await tx(deployer, dep.usdg, usdgAbi, "mint", [wallets[i]!, 200n * U]);
  }
  await tx(users[0]!, dep.usdg, usdgAbi, "approve", [dep.permit2, (1n << 256n) - 1n]);
  await tx(users[0]!, dep.permit2, permit2UserAbi, "approve", [dep.usdg, dep.savingsVault, 1_000n * U, Number((await now()) + 60n * DAY)]);
  // A spend before the wallet is linked is not a round-up.
  await spend(wallets[2]!, merchant, 1_500_000n);
  for (const [i, u] of users.entries()) await link(u, wallets[i]!);
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
  await t?.drop();
});

describe("keeper on anvil", () => {
  const SPENDS: [number, bigint][] = [
    [0, 3_400_000n], // 3.40 -> (1 - 0.40) x2 = 1.20
    [1, 12_750_000n], // 12.75, roundTo 5 -> 2.25
    [2, 7_010_000n], // 7.01 -> 0.99
    [0, 9_999_999n], // 9.999999 -> 0.000001 x2: under the 5-cent on-chain minimum, skipped (review v3 R3-SVC-2)
    [2, 20_000_000n], // exact multiple -> 0
  ];
  const settingsOf = (i: number) => ({ roundTo: i === 1 ? 5n : 1n, mult: i === 0 ? 2n : 1n });
  let expected: bigint[];

  test("round-ups: accruals match R1, transfers into Plynth contracts and pre-link spends are skipped, top-up pulled, sweep fills book 0", async () => {
    for (const [i, v] of SPENDS) await spend(wallets[i]!, merchant, v);
    await spend(wallets[0]!, dep.savingsVault, 5n * U); // into a Plynth contract: skipped
    const MIN_ONCHAIN = 50_000n; // 5 cents of USDG
    expect(r1(9_999_999n, 1n, 2n)).toBe(2n); // R1 itself is unchanged; the keeper just does not send it
    expected = users.map((_, i) => SPENDS.filter(([j]) => j === i).reduce((a, [, v]) => { const r = r1(v, settingsOf(i).roundTo, settingsOf(i).mult); return r >= MIN_ONCHAIN ? a + r : a; }, 0n));
    expect(expected).toEqual([1_200_000n, 2_250_000n, 990_000n]);

    const out = cycle();
    expect(out).toContain("roundups: ok actions=3"); // the exact multiple adds 0 and the dust round-up is under the minimum: skipped, never sent
    expect(out).toContain("topups: ok actions=1");
    expect(out).toContain("sweep: ok actions=1");

    const rows = await t.sql`select user_address, added, status, reason, spend from keeper_roundups order by block_number, log_index`;
    expect(rows.filter((r) => r.status === "done")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "skipped").map((r) => r.reason).sort()).toEqual(["no round-up (whole amount): the vault would add 0", "round-up below the keeper minimum of 5 cents per accrual", "transfer into a Plynth contract"]);
    expect(rows.some((r) => BigInt(r.spend) === 1_500_000n)).toBe(false); // pre-link spend never indexed
    for (const [i, u] of users.entries()) {
      const added = rows.filter((r) => r.user_address === u.toLowerCase() && r.status === "done").reduce((a, r) => a + BigInt(r.added), 0n);
      expect(added).toBe(expected[i]!);
      // swept: pending is 0 and the whole round-up is the user's order in book 0
      const [, pending] = (await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "balancesOf", args: [u] })) as [bigint, bigint];
      expect(pending).toBe(0n);
    }
    const b0 = await book(0n);
    expect(b0.accounts).toBe(3);
    expect(b0.usdgTotal).toBe(expected.reduce((a, b) => a + b, 0n));
    expect(b0.executed).toBe(false);
    const acct0 = (await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "accountOf", args: [users[0]!] })) as any;
    expect(acct0.available).toBe(300n * U - expected[0]! + 25n * U);
  }, 120_000);

  test("idempotent: another indexer + keeper pass sends nothing new", async () => {
    const before = await pub.getTransactionCount({ address: ANVIL_ADDR_1 });
    const out = cycle();
    expect(out).toContain("roundups: ok actions=0");
    expect(out).toContain("topups: ok actions=0");
    expect(out).toContain("sweep: ok actions=0");
    expect(out).toContain("beacon: ok actions=0");
    expect(await pub.getTransactionCount({ address: ANVIL_ADDR_1 })).toBe(before);
    // AlreadyAccrued path: forget the keeper's rows, the vault's replay guard still stops a double accrual.
    await t.sql`delete from keeper_roundups`;
    const out2 = keeper("roundups");
    expect(out2).toContain("roundups: ok actions=0");
    expect((await t.sql`select count(*)::int as n from keeper_roundups where reason = 'already accrued'`)[0]!.n).toBe(3); // the dust spend is skipped before any simulation
    expect(await pub.getTransactionCount({ address: ANVIL_ADDR_1 })).toBe(before);
  }, 120_000);

  test("beacon: the next windows are committed with sealed secrets, plaintext never stored", async () => {
    const { start } = windowOf(await now());
    for (const k of [1n, 2n]) {
      const key = beaconKey(tsla(), start + k * DAY);
      const b = (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "beacon", args: [key] })) as any;
      expect(b.windowStart).toBe(start + k * DAY);
      expect(b.commitment).not.toBe(`0x${"0".repeat(64)}`);
      const row = (await t.sql`select status, secret_enc from keeper_jobs where kind = 'beacon' and job_key = ${key.toLowerCase()}`)[0]!;
      expect(row.status).toBe("committed");
      expect(row.secret_enc).toMatch(/^v1\./);
    }
    // the current window was never committed, so execution there is impossible
    const cur = (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "executeAfter", args: [beaconKey(tsla(), start)] })) as bigint;
    expect(cur).toBe((1n << 64n) - 1n);
    expect(beaconKey(tsla(), start)).toBe((await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "beaconKey", args: [tsla(), start] })) as Hex);
  }, 60_000);

  test("book 0 executes after the revealed time and not before; allocations are claimable", async () => {
    const w1 = windowOf(await now()).start + DAY;
    await warpTo(w1 + 5n);
    // Unrevealed: executeAfter is the fallback; an execute-only pass does nothing.
    expect(keeper("execute")).toContain("execute: ok actions=0");
    expect((await book(0n)).executed).toBe(false);

    const key = beaconKey(tsla(), w1);
    const { executeAt, lastWithout } = await revealByKeeper(key); // reveals only once the time has come
    expect(executeAt).toBeGreaterThanOrEqual(w1);
    expect(executeAt).toBeLessThan(w1 + DAY - GRACE);
    expect(executeAt).toBeLessThanOrEqual(await now());
    if (lastWithout !== undefined) expect(executeAt).toBeGreaterThan(lastWithout); // never published early
    expect((await t.sql`select status from keeper_jobs where job_key = ${key.toLowerCase()}`)[0]!.status).toBe("revealed");

    await warpTo((executeAt > (await now()) ? executeAt : await now()) + 1n);
    expect(cycle()).toContain("execute: ok actions=1");
    const b0 = await book(0n);
    expect(b0.executed).toBe(true);
    expect(b0.rawOut).toBeGreaterThan(0n);
    const job = (await t.sql`select tx_hash from keeper_jobs where kind = 'execute' and job_key = ${`${tsla().toLowerCase()}:0`}`)[0]!;
    const rcpt = await pub.getTransactionReceipt({ hash: job.tx_hash });
    const blk = await pub.getBlock({ blockNumber: rcpt.blockNumber });
    expect(blk.timestamp).toBeGreaterThanOrEqual(executeAt);

    let claimed = 0n;
    for (const u of users) {
      const alloc = (await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "allocationOf", args: [tsla(), 0n, u] })) as bigint;
      expect(alloc).toBeGreaterThan(0n);
      await tx(u, dep.crowdBuy, crowdAbi, "claimOpen", [tsla(), 0n]);
      expect((await pub.readContract({ address: tsla(), abi: usdgAbi, functionName: "balanceOf", args: [u] })) as bigint).toBe(alloc);
      claimed += alloc;
    }
    expect(claimed).toBeLessThanOrEqual(b0.rawOut);
  }, 120_000);

  test("keeper offline through a window's reveal: the fallback time still executes book 1", async () => {
    for (const [i, w] of wallets.entries()) await spend(w, merchant, parseUnits("4.5", 6) + BigInt(i));
    cycle(); // accrue + sweep into book 1, commit the window after next
    const b1 = await book(1n);
    expect(b1.accounts).toBe(3);
    const w2 = windowOf(await now()).start + DAY;
    const key = beaconKey(tsla(), w2);
    const committed = (await pub.readContract({ address: dep.jitterBeacon, abi: beaconAbi, functionName: "beacon", args: [key] })) as any;
    expect(committed.commitment).not.toBe(`0x${"0".repeat(64)}`);

    // Keeper is down from before w2 starts until after its reveal deadline.
    const fallback = w2 + DAY - GRACE;
    await warpTo(w2 + 3_600n);
    const early = await pub.simulateContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "execute", args: [tsla()], account: ANVIL_ADDR_1 }).catch((e) => e);
    expect(String(early)).toContain("TooEarly");
    await warpTo(fallback + 60n);
    const out = cycle();
    expect(out).toContain("reveal missed");
    expect(out).toContain("execute: ok actions=1");
    expect((await book(1n)).executed).toBe(true);
    expect((await t.sql`select status from keeper_jobs where job_key = ${key.toLowerCase()}`)[0]!.status).toBe("expired");
    const ex = (await t.sql`select payload from keeper_jobs where kind = 'execute' and job_key = ${`${tsla().toLowerCase()}:1`}`)[0]!;
    expect(BigInt(ex.payload.executeAfter)).toBe(fallback);
  }, 120_000);

  test("keeper offline for a whole window: the pre-committed window after it still runs; weekly top-up repeats", async () => {
    for (const [i, w] of wallets.entries()) await spend(w, merchant, parseUnits("2.25", 6) + BigInt(i));
    cycle(); // book 2, commits up to two windows ahead
    expect((await book(2n)).accounts).toBe(3);
    const w3 = windowOf(await now()).start + DAY;
    const w4 = w3 + DAY;
    // Skip all of w3. Come back at w4's start: w4 was committed before the outage, so it reveals and runs.
    await warpTo(w4 + 1n);
    const { executeAt } = await revealByKeeper(beaconKey(tsla(), w4), "beacon");
    expect(executeAt).toBeLessThan(w4 + DAY - GRACE);
    if (!(await book(2n)).executed) {
      const n = await now();
      await warpTo((executeAt > n ? executeAt : n) + 1n);
      expect(keeper()).toContain("execute: ok actions=1");
    }
    expect((await book(2n)).executed).toBe(true);

    const acct = (await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "accountOf", args: [users[0]!] })) as any;
    await warpTo(acct.lastTopUpAt + 7n * DAY);
    expect(keeper("topups")).toContain("topups: ok actions=1");
    const after = (await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "accountOf", args: [users[0]!] })) as any;
    expect(after.lastTopUpAt).toBeGreaterThan(acct.lastTopUpAt);
  }, 120_000);

  test("the signing key never appears in keeper output", () => {
    const all = outputs.join("\n").toLowerCase();
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(ANVIL_KEY_1.slice(2).toLowerCase());
    expect(all).not.toContain(secretKey.slice(2).toLowerCase());
  });
});
