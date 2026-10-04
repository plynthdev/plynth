// Threshold proofs end to end on anvil: real ShieldedPool, real UltraHonk verifiers, ThresholdVerifier from
// LocalConsumer. Proofs are made with the SDK and checked through POST /v1/proofs/verify (stateless).
//   holdings: true statement verifies; verifier B cannot reuse verifier A's proof; spending a counted note
//             makes the same proof fail.
//   savings:  deposits in a window verify; self-transfers add pool leaves but never deposit leaves, so they
//             cannot inflate savings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  depositRootAt,
  proveHoldingsAtLeast,
  proveSavingsAtLeast,
  syncDepositTree,
  thresholdVerifierAbi,
  ThresholdNotMet,
  type DepositRootRecord,
  type HoldingsProof,
  type SavingsProof,
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
  syncPool,
  transferTx,
  withdrawTx,
  type VaultKeys,
} from "@plynth/sdk/vault";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ROOT, permit2Runtime, startAnvil } from "@/testing/keeper-helpers";
import { apiDeployment, BlockTimes, createApp } from "@/api";

const U = 1_000_000n;
const tokenAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const poolAdminAbi = parseAbi(["function applyCap(address asset)"]);

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let dep: Record<string, any>;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let deployer: Address, alice: Address, bob: Address, relayer: Address, verifierA: Address, verifierB: Address;
let ka: VaultKeys, kb: VaultKeys;
let fromRoot: DepositRootRecord;
let holdings: HoldingsProof;
let savings: SavingsProof;
const REQ = keccak256(toBytes("loan-application-42"));

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
const usdg = () => getAddress(dep.usdg) as Address;
const pool = () => getAddress(dep.shieldedPool) as Address;
const tv = () => getAddress(dep.thresholdVerifier) as Address;
const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
const warp = async (s: bigint) => {
  await rpc("evm_setNextBlockTimestamp", [Number((await now()) + s)]);
  await rpc("evm_mine");
};
async function send(account: Address, u: { to: Address; data: Hex }) {
  const hash = await wc.sendTransaction({ account, to: u.to, data: u.data, chain: null } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (r.status !== "success") throw new Error(`tx to ${u.to} reverted`);
  return r;
}
const sync = () => send(relayer, { to: tv(), data: encodeFunctionData({ abi: thresholdVerifierAbi, functionName: "syncDeposits", args: [100n] }) });
async function deposit(user: Address, keys: VaultKeys, raw: bigint) {
  await send(user, approveTx(usdg(), pool(), raw));
  await send(user, depositTx(pool(), usdg(), raw, keys));
}
async function insertAll() {
  await warp(3601n);
  await send(relayer, insertPendingTx(pool(), 100n));
}
const app = (d = dep) => createApp({ chainId: 31337, pub, db: undefined as any, dep: apiDeployment(d as any, 31337), blockTimes: new BlockTimes(pub) });
async function verify(proof: unknown, verifier: Address, requestId: Hex = REQ, d = dep) {
  const res = await app(d).request("/v1/proofs/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof, verifier, requestId }) });
  return { status: res.status, body: (await res.json()) as any };
}
const chainReq = (verifier: Address) => ({ chainId: 31337, thresholdVerifier: tv(), verifier, requestId: REQ });

beforeAll(async () => {
  await initVault();
  anvil = await startAnvil(["--gas-limit", "60000000"]);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  pub = createPublicClient({ chain, transport: http(anvil.rpc) }) as PublicClient;
  wc = createWalletClient({ chain, transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  [deployer, , alice, bob, relayer, verifierA, verifierB] = accounts as [Address, Address, Address, Address, Address, Address, Address];
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
  await warp(48n * 3600n + 1n);
  const hash = await wc.writeContract({ account: deployer, address: pool(), abi: poolAdminAbi, functionName: "applyCap", args: [usdg()], chain: null } as any);
  await pub.waitForTransactionReceipt({ hash });
  for (const u of [alice, bob]) {
    const h = await wc.writeContract({ account: deployer, address: usdg(), abi: tokenAbi, functionName: "mint", args: [u, 10_000n * U], chain: null } as any);
    await pub.waitForTransactionReceipt({ hash: h });
  }
  ka = deriveVaultKeys(await wc.signMessage({ account: alice, message: VAULT_KEY_MESSAGE }));
  kb = deriveVaultKeys(await wc.signMessage({ account: bob, message: VAULT_KEY_MESSAGE }));
}, 240_000);

afterAll(async () => {
  await destroyProver();
  await anvil?.stop();
});

describe("threshold proofs on anvil", () => {
  test("history: deposits, deposit-tree syncs, a self-transfer that adds pool leaves only", async () => {
    expect(dep.thresholdVerifier).toBeString();
    await deposit(alice, ka, 100n * U);
    await insertAll();
    await sync();
    let dt = await syncDepositTree(pub, tv(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    fromRoot = depositRootAt(dt, await pub.getBlockNumber({ cacheTime: 0 }))!;
    expect(fromRoot.size).toBe(1);

    await deposit(bob, kb, 50n * U);
    await deposit(alice, ka, 200n * U);
    await deposit(alice, ka, 300n * U);
    await insertAll();
    await sync();

    // alice moves her 300 note to herself: two new pool leaves, no new deposit leaves
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const n300 = myNotes(state, ka).find((n) => n.raw === 300n * U)!;
    await send(relayer, transferTx(pool(), await proveTransfer({ keys: ka, tree: state.tree, inputs: [n300], to: ka, raw: 300n * U })));
    await expect(sync()).rejects.toThrow();
    dt = await syncDepositTree(pub, tv(), dt);
    expect(dt.leaves).toHaveLength(4);
    expect(BigInt((await pub.readContract({ address: tv(), abi: thresholdVerifierAbi, functionName: "depositRoot" })) as Hex)).toBe(dt.roots.at(-1)!.root);
  }, 240_000);

  test("nonce endpoint equals ThresholdVerifier.nonceFor", async () => {
    const res = await app().request(`/v1/proofs/nonce?verifier=${verifierA}&requestId=${REQ}`);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.nonce).toBe(await pub.readContract({ address: tv(), abi: thresholdVerifierAbi, functionName: "nonceFor", args: [verifierA, REQ] }));
  });

  test("holdings: true statement verifies for verifier A, and only for A", async () => {
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const notes = myNotes(state, ka);
    await expect(proveHoldingsAtLeast({ ...chainReq(verifierA), keys: ka, tree: state.tree, notes, asset: usdg(), threshold: 600n * U + 1n })).rejects.toBeInstanceOf(ThresholdNotMet);
    holdings = await proveHoldingsAtLeast({ ...chainReq(verifierA), keys: ka, tree: state.tree, notes, asset: usdg(), threshold: 450n * U });
    const a = await verify(holdings, verifierA);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ ok: true, kind: "plynth.threshold.holdings", asset: usdg(), threshold: (450n * U).toString(), holdings: { notes: 2, padding: 6 } });
    const b = await verify(holdings, verifierB);
    expect(b.body).toEqual({ ok: false, reason: "InvalidProof" });
    expect((await verify(holdings, verifierA, keccak256(toBytes("other request")))).body).toEqual({ ok: false, reason: "InvalidProof" });
    // also served at /proofs/verify (todo path)
    const res = await app().request("/proofs/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof: holdings, verifier: verifierA, requestId: REQ }) });
    expect(((await res.json()) as any).ok).toBe(true);
  }, 120_000);

  test("holdings: spending a counted note makes the same proof fail", async () => {
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const counted = new Set(holdings.claim.nullifiers.map((n) => BigInt(n)));
    const note = myNotes(state, ka).find((n) => n.nullifier !== null && counted.has(n.nullifier))!;
    const w = await proveWithdraw({ keys: ka, tree: state.tree, note, amount: note.raw, recipient: alice });
    await send(relayer, withdrawTx(pool(), w));
    const r = await verify(holdings, verifierA);
    expect(r.body).toEqual({ ok: false, reason: "NullifierSpent" });
  }, 120_000);

  test("savings: deposits in the window verify for A only; transfers cannot inflate them", async () => {
    const dt = await syncDepositTree(pub, tv(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const to = dt.roots.at(-1)!;
    const state = await syncPool(pub, pool(), undefined, { fromBlock: BigInt(dep.deployBlock) });
    const notes = myNotes(state, ka); // includes spent notes and transfer outputs
    // window deposits of alice: 200 + 300 (the 100 is before the window, the self-transfer output is no deposit)
    await expect(proveSavingsAtLeast({ ...chainReq(verifierA), keys: ka, deposits: dt, notes, asset: usdg(), threshold: 500n * U + 1n, from: fromRoot, to })).rejects.toBeInstanceOf(ThresholdNotMet);
    savings = await proveSavingsAtLeast({ ...chainReq(verifierA), keys: ka, deposits: dt, notes, asset: usdg(), threshold: 500n * U, from: fromRoot, to });
    const a = await verify(savings, verifierA);
    expect(a.body).toMatchObject({ ok: true, kind: "plynth.threshold.savings", savings: { depositsInWindow: 3, fromBlock: fromRoot.block.toString(), toBlock: to.block.toString() } });
    expect(Date.parse(a.body.savings.toTime)).toBeGreaterThan(Date.parse(a.body.savings.fromTime));
    expect((await verify(savings, verifierB)).body).toEqual({ ok: false, reason: "InvalidProof" });
    const tampered = { ...savings, claim: { ...savings.claim, threshold: (600n * U).toString() } };
    expect((await verify(tampered, verifierA)).body).toEqual({ ok: false, reason: "InvalidProof" });
  }, 120_000);

  test("bad requests: malformed bundle is a verdict, bad verifier is a 400, no verifier deployed is a 404", async () => {
    expect((await verify({ nope: 1 }, verifierA)).body).toMatchObject({ ok: false, reason: "malformed" });
    expect((await verify(holdings, "0x1234" as Address)).status).toBe(400);
    const { thresholdVerifier: _, ...without } = dep;
    expect((await verify(holdings, verifierA, REQ, without)).status).toBe(404);
  });
});
