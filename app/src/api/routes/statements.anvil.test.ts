// Viewing-key statements end to end on anvil with the real ShieldedPool and UltraHonk verifiers.
// Two users deposit, refund, transfer privately and withdraw across two periods while the test keeps a shadow
// ledger of every note (the same bookkeeping as the pool's invariant handler). Statements must equal the shadow
// ledger, sum with pending deposits to pool.shielded(), value Stock Tokens at the period's last block, and show a
// note spent before period end as spent. Disclosure bundles verify through the API and fail when tampered.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  discloseNotes,
  scanPool,
  statement,
  statementToCsv,
  statementToHtml,
  statementToJson,
  viewingKeyOf,
  type Period,
  type Statement,
} from "@plynth/sdk/statements";
import {
  VAULT_KEY_MESSAGE,
  approveTx,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  initVault,
  insertPendingTx,
  myNotes,
  proveTransfer,
  proveWithdraw,
  refundPendingTx,
  registration,
  shieldedPoolAbi,
  syncPool,
  transferTx,
  withdrawTx,
  type VaultKeys,
} from "@plynth/sdk/vault";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ROOT, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";
import { apiDeployment, BlockTimes, createApp } from "@/api";

const E18 = 10n ** 18n;
const U = 1_000_000n;
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
]);
const feedAbi = parseAbi(["function set(int256 answer)"]);
const vaultAbi = parseAbi(["function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)"]);
const poolAdminAbi = parseAbi(["function applyCap(address asset)"]);

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let dep: Record<string, any>;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let deployer: Address, alice: Address, bob: Address, relayer: Address;
let ka: VaultKeys, kb: VaultKeys;
const pA = {} as Period;
const pB = {} as Period;

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
const tsla = () => getAddress(dep.stocks.mTSLA.token) as Address;
const usdg = () => getAddress(dep.usdg) as Address;
const pool = () => getAddress(dep.shieldedPool) as Address;
const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
const head = () => pub.getBlockNumber({ cacheTime: 0 });
const warpTo = async (ts: bigint) => {
  await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
  await rpc("evm_mine");
};
async function send(account: Address, u: { to: Address; data: Hex }) {
  const hash = await wc.sendTransaction({ account, to: u.to, data: u.data, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`tx to ${u.to} reverted`);
  return r;
}
async function call(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const hash = await wc.writeContract({ account, address, abi, functionName, args, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}
const read = (address: Address, abi: any, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;

/** Shadow ledger: tree-inserted unspent value and queued deposits, per user per asset. */
const shadow = { tree: new Map<string, bigint>(), pending: new Map<string, bigint>() };
const k = (u: Address, a: Address) => `${u}:${a}`.toLowerCase();
const add = (m: Map<string, bigint>, u: Address, a: Address, d: bigint) => m.set(k(u, a), (m.get(k(u, a)) ?? 0n) + d);
const sh = (m: Map<string, bigint>, u: Address, a: Address) => m.get(k(u, a)) ?? 0n;
const snapshot = () => ({ tree: new Map(shadow.tree), pending: new Map(shadow.pending) });
let shadowA: ReturnType<typeof snapshot>;

async function deposit(user: Address, keys: VaultKeys, asset: Address, raw: bigint) {
  await send(user, approveTx(asset, pool(), raw));
  await send(user, depositTx(pool(), asset, raw, keys));
  add(shadow.pending, user, asset, raw);
  return ((await read(pool(), shieldedPoolAbi, "pendingCount")) as bigint) - 1n;
}

const opts = () => ({ chainId: 31337, pool: pool(), deployBlock: BigInt(dep.deployBlock), valuer: getAddress(dep.valuer) as Address, stables: [usdg()] });
const bal = (s: Statement, a: Address) => s.balances.find((b) => b.asset === a)!;
const app = () =>
  createApp({ chainId: 31337, pub, db: undefined as any, dep: apiDeployment(dep as any, 31337), blockTimes: new BlockTimes(pub) });

beforeAll(async () => {
  await initVault();
  anvil = await startAnvil(["--gas-limit", "60000000"]);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  pub = createPublicClient({ chain, transport: http(anvil.rpc) }) as PublicClient;
  wc = createWalletClient({ chain, transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  [deployer, , alice, bob, relayer] = accounts as [Address, Address, Address, Address, Address];
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

  await warpTo((await now()) + 48n * 3600n + 1n);
  for (const a of [tsla(), usdg()]) await call(deployer, pool(), poolAdminAbi, "applyCap", [a]);
  for (const u of [alice, bob]) {
    await call(deployer, tsla(), tokenAbi, "mint", [u, 1_000n * E18]);
    await call(deployer, usdg(), tokenAbi, "mint", [u, 1_000n * U]);
  }
  ka = deriveVaultKeys(await wc.signMessage({ account: alice, message: VAULT_KEY_MESSAGE }));
  kb = deriveVaultKeys(await wc.signMessage({ account: bob, message: VAULT_KEY_MESSAGE }));
  const r = registration(ka);
  await call(alice, dep.savingsVault, vaultAbi, "setHiddenKeys", [r.ownerPk, r.viewingPub]);
}, 240_000);

afterAll(async () => {
  await destroyProver();
  await anvil?.stop();
});

describe("statements on anvil", () => {
  test("period A: deposits, a refund, batch insert", async () => {
    pA.fromBlock = (await head()) + 1n;
    await deposit(alice, ka, tsla(), 100n * E18);
    await deposit(alice, ka, usdg(), 50n * U);
    await deposit(bob, kb, tsla(), 20n * E18);
    const refundId = await deposit(alice, ka, usdg(), 7n * U);
    await send(alice, refundPendingTx(pool(), refundId));
    add(shadow.pending, alice, usdg(), -7n * U);
    await warpTo((await now()) + 7201n); // MIN_PENDING_DELAY + SOLO_INSERT_DELAY: a batch under MIN_INSERT_BATCH (4)
    await send(relayer, insertPendingTx(pool(), 10n));
    for (const [u, a, v] of [[alice, tsla(), 100n * E18], [alice, usdg(), 50n * U], [bob, tsla(), 20n * E18]] as const) {
      add(shadow.pending, u, a, -v);
      add(shadow.tree, u, a, v);
    }
    pA.toBlock = await head();
    shadowA = snapshot();
    // the price moves after period A ends: A must still be valued at 250
    await call(deployer, getAddress(dep.stocks.mTSLA.feed), feedAbi, "set", [300n * 10n ** 8n]);
  }, 120_000);

  test("period B: private transfer alice -> bob, bob withdraws, alice leaves a deposit pending", async () => {
    pB.fromBlock = (await head()) + 1n;
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const aliceTsla = myNotes(state, ka).filter((n) => n.asset === tsla());
    const t = await proveTransfer({ keys: ka, tree: state.tree, inputs: aliceTsla, to: kb, raw: 30n * E18 });
    await send(relayer, transferTx(pool(), t));
    add(shadow.tree, alice, tsla(), -30n * E18);
    add(shadow.tree, bob, tsla(), 30n * E18);

    await syncPool(pub, pool(), state);
    const bobNote = myNotes(state, kb).find((n) => n.raw === 20n * E18)!;
    const w = await proveWithdraw({ keys: kb, tree: state.tree, note: bobNote, amount: 10n * E18, recipient: relayer, relayerFee: 0n });
    await send(relayer, withdrawTx(pool(), w));
    add(shadow.tree, bob, tsla(), -10n * E18);

    await deposit(alice, ka, usdg(), 5n * U);
    pB.toBlock = await head();
  }, 240_000);

  test("statement totals equal the shadow ledger; with pending they sum to pool.shielded", async () => {
    const hist = await scanPool(pub, pool(), BigInt(dep.deployBlock), pB.toBlock);
    for (const [p, sd] of [[pA, shadowA], [pB, shadow]] as const) {
      const sa = await statement(pub, ka, p, { ...opts(), history: hist });
      const sb = await statement(pub, kb, p, { ...opts(), history: hist });
      for (const a of [tsla(), usdg()]) {
        expect(bal(sa, a)?.closing ?? 0n).toBe(sh(sd.tree, alice, a));
        expect(bal(sa, a)?.pending ?? 0n).toBe(sh(sd.pending, alice, a));
        expect(bal(sb, a)?.closing ?? 0n).toBe(sh(sd.tree, bob, a));
        const shielded = (await pub.readContract({ address: pool(), abi: shieldedPoolAbi, functionName: "shielded", args: [a], blockNumber: p.toBlock })) as bigint;
        const sum = (s: Statement) => (bal(s, a)?.closing ?? 0n) + (bal(s, a)?.pending ?? 0n);
        expect(sum(sa) + sum(sb)).toBe(shielded);
      }
    }
  }, 120_000);

  test("period A: valued at the period-end price, movements, refund shown", async () => {
    const s = await statement(pub, ka, pA, opts());
    const t = bal(s, tsla());
    expect(t).toMatchObject({ opening: 0n, in: 100n * E18, out: 0n, closing: 100n * E18, priceUsd18: 250n * E18, multiplier18: E18, hold: false });
    expect(t.usd18).toBe(25_000n * E18);
    expect(bal(s, usdg()).usd18).toBe(50n * E18);
    expect(s.totalUsd18).toBe(25_050n * E18);
    expect(s.movements.map((m) => `${m.type}:${m.symbol}`)).toEqual(["queued:mTSLA", "queued:mUSDG", "queued:mUSDG", "refunded:mUSDG", "in:mTSLA", "in:mUSDG"]);
    expect(s.spendsVisible).toBe(true);
  }, 60_000);

  test("period B: the note spent before period end shows as spent; change in; valued at the new price", async () => {
    const s = await statement(pub, ka, pB, opts());
    const t = bal(s, tsla());
    expect(t).toMatchObject({ opening: 100n * E18, in: 70n * E18, out: 100n * E18, closing: 70n * E18, priceUsd18: 300n * E18 });
    expect(s.notes.find((n) => n.raw === 100n * E18)).toMatchObject({ status: "spent", source: "deposit" });
    expect(s.notes.find((n) => n.raw === 70n * E18)).toMatchObject({ status: "unspent", source: "change" });
    expect(bal(s, usdg())).toMatchObject({ closing: 50n * U, pending: 5n * U });
    const sb = await statement(pub, kb, pB, opts());
    expect(sb.notes.find((n) => n.raw === 30n * E18)).toMatchObject({ source: "received", status: "unspent" });
    expect(sb.notes.find((n) => n.raw === 20n * E18)).toMatchObject({ status: "spent" });
    expect(bal(sb, tsla()).closing).toBe(40n * E18);
  }, 60_000);

  test("viewing key alone: sees every received note, cannot see spends", async () => {
    const s = await statement(pub, viewingKeyOf(ka), pB, opts());
    expect(s.spendsVisible).toBe(false);
    expect(s.notes.filter((n) => n.asset === tsla()).every((n) => n.status === "unknown")).toBe(true);
    expect(bal(s, tsla()).closing).toBe(170n * E18); // 100 (spent, not visible) + 70 change
    expect(s.movements.some((m) => m.type === "out")).toBe(false);
  }, 60_000);

  test("JSON, CSV and HTML outputs", async () => {
    const s = await statement(pub, ka, pB, opts());
    const j = statementToJson(s) as any;
    expect(j.balances.find((b: any) => b.symbol === "mTSLA")).toMatchObject({ closingUnits: "70", usd: "21000" });
    expect(statementToCsv(s)).toContain("balance,");
    const html = statementToHtml(s);
    expect(html).toContain("$21,050.00");
    expect(html).not.toMatch(/<script|src=/i);
  }, 60_000);

  test("disclosure: bundle verifies through the stateless API; tampered amount fails; spent note reported spent", async () => {
    const hist = await scanPool(pub, pool(), BigInt(dep.deployBlock), pB.toBlock);
    const s = await statement(pub, ka, pB, { ...opts(), history: hist });
    const change = s.notes.find((n) => n.raw === 70n * E18)!;
    const spent = s.notes.find((n) => n.raw === 100n * E18)!;
    const bundle = discloseNotes([change, spent], pB, { chainId: 31337, pool: pool(), history: hist });
    const post = (b: unknown) => app().request("/v1/statements/verify", { method: "POST", body: JSON.stringify(b) });
    const r = await post(bundle);
    const v = (await r.json()) as any;
    expect(r.status, JSON.stringify(v)).toBe(200);
    expect(v.ok).toBe(true);
    expect(v.notes.map((n: any) => n.nullifierStatus)).toEqual(["unspent", "spent"]);
    expect(v.totals).toEqual([{ asset: tsla(), raw: (70n * E18).toString() }]);

    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.notes[0].raw = (70n * E18 + 1n).toString();
    const tv = (await (await post(tampered)).json()) as any;
    expect(tv.ok).toBe(false);
    expect(tv.notes[0].error).toMatch(/not in the pool's tree/);

    // period A bundle: the 100 note was unspent at A's end, spent later
    const sA = await statement(pub, ka, pA, { ...opts(), history: hist });
    const bA = discloseNotes(sA.notes.filter((n) => n.raw === 100n * E18), pA, { chainId: 31337, pool: pool(), history: hist });
    const vA = (await (await post(bA)).json()) as any;
    expect(vA.ok).toBe(true);
    expect(vA.notes[0].nullifierStatus).toBe("spent-after-period");
    expect((await (await post({ nope: 1 })).json()).ok).toBe(false);
  }, 60_000);

  test("statements.list: monthly periods from key registration; Ready once the month is over; none without keys", async () => {
    const d = new Date(Number(await now()) * 1000);
    await warpTo(BigInt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 2) / 1000));
    const r = await app().request(`/v1/statements/${alice}`);
    const j = (await r.json()) as any;
    expect(r.status, JSON.stringify(j)).toBe(200);
    expect(j.hidden).toBe(true);
    expect(j.statements.length).toBeGreaterThanOrEqual(2);
    expect(j.statements[0]).toMatchObject({ title: "Viewing-key statement", status: "In progress", label: "Viewing-key statement · In progress" });
    expect(j.statements[1]).toMatchObject({ status: "Ready", label: "Viewing-key statement · Ready" });
    for (const st of j.statements) expect(BigInt(st.period.fromBlock) <= BigInt(st.period.toBlock)).toBe(true);
    expect(BigInt(j.statements[1].period.toBlock) + 1n).toBe(BigInt(j.statements[0].period.fromBlock));
    // periods from the list feed straight into the SDK
    const p = { fromBlock: BigInt(j.statements[1].period.fromBlock), toBlock: BigInt(j.statements[1].period.toBlock) };
    expect((await statement(pub, ka, p, opts())).balances.length).toBeGreaterThan(0);

    const none = (await (await app().request(`/v1/statements/${bob}`)).json()) as any;
    expect(none).toMatchObject({ hidden: false, statements: [] });
    expect((await app().request(`/v1/statements/not-an-address`)).status).toBe(400);
    const trpc = await app().request(`/trpc/statements.list?input=${encodeURIComponent(JSON.stringify({ address: alice }))}`);
    expect(trpc.status).toBe(200);
  }, 120_000);
});
