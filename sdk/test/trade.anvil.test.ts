// Private sell / buy / park end to end on anvil (todo 25): LocalConsumer's ShieldedPool + ShieldedTrade with the
// REAL swap/settle UltraHonk verifiers, StockRouter on the fixed-rate local v4 PoolManager double, and an
// OpenZeppelin ERC-4626 mock vault behind ERC4626Park. Proofs are made client-side with this SDK; a relayer
// account submits every swap (the user's address never appears).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ANVIL_ADDR_1, ANVIL_KEY_0, ROOT, hasBinary, permit2Runtime, startAnvil } from "../../app/src/testing/keeper-helpers";
import {
  VAULT_KEY_MESSAGE,
  approveTx,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  initVault,
  insertPendingTx,
  minOutFor,
  myNotes,
  parkValue,
  proveSettle,
  proveSwap,
  proveWithdraw,
  settleTx,
  shieldedPoolAbi,
  shieldedTradeAbi,
  swapTx,
  syncPool,
  withdrawTx,
  type OwnedNote,
  type PoolState,
  type VaultKeys,
} from "../src/vault";

const U = 1_000_000n;
const E18 = 10n ** 18n;
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function setMultiplier(uint256 m)",
]);
const poolAdminAbi = parseAbi(["function applyCap(address asset)"]);
const tools = hasBinary("anvil") && hasBinary("forge");

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let dep: Record<string, any>;
let pub: PublicClient;
let wc: ReturnType<typeof createWalletClient>;
let deployer: Address, alice: Address, relayer: Address;
let ka: VaultKeys;
let state: PoolState | undefined;

const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });
const usdg = () => getAddress(dep.usdg) as Address;
const tsla = () => getAddress(dep.stocks.mTSLA.token) as Address;
const pool = () => getAddress(dep.shieldedPool) as Address;
const trade = () => getAddress(dep.shieldedTrade) as Address;
const vault = () => getAddress(dep.parkVault) as Address;
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
const write = (account: Address, address: Address, abi: any, functionName: string, args: unknown[]) =>
  send(account, { to: address, data: encodeFunctionData({ abi, functionName, args } as any) });
const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;
const shielded = (asset: Address) => read(pool(), shieldedPoolAbi, "shielded", [asset]) as Promise<bigint>;
const spent = (n: Hex) => read(pool(), shieldedPoolAbi, "nullifierSpent", [n]) as Promise<boolean>;
const deadline = async () => (await now()) + 3600n;

async function deposit(asset: Address, raw: bigint) {
  await send(alice, approveTx(asset, pool(), raw));
  await send(alice, depositTx(pool(), asset, raw, ka));
  await warp(3601n);
  await send(relayer, insertPendingTx(pool(), 100n));
}
async function notes(): Promise<OwnedNote[]> {
  state = await syncPool(pub, pool(), state, { fromBlock: BigInt(dep.deployBlock), trade: trade() });
  return myNotes(state, ka).filter((n) => !n.spent && n.leafIndex !== null);
}
const find = async (asset: Address, pred: (n: OwnedNote) => boolean = () => true) => (await notes()).find((n) => n.asset === asset && pred(n))!;

beforeAll(async () => {
  if (!tools) return;
  await initVault();
  anvil = await startAnvil(["--gas-limit", "60000000"]);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  pub = createPublicClient({ chain, transport: http(anvil.rpc) }) as PublicClient;
  wc = createWalletClient({ chain, transport: http(anvil.rpc) });
  const accounts = (await rpc("eth_accounts")) as Address[];
  [deployer, , alice, , relayer] = accounts as [Address, Address, Address, Address, Address];
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
  for (const a of [usdg(), tsla(), vault()]) await write(deployer, pool(), poolAdminAbi, "applyCap", [a]);
  await write(relayer, trade(), shieldedTradeAbi, "applyAdapter", [vault()]);
  await write(deployer, usdg(), tokenAbi, "mint", [alice, 100_000n * U]);
  await write(deployer, tsla(), tokenAbi, "mint", [alice, 100n * E18]);
  ka = deriveVaultKeys(await wc.signMessage({ account: alice, message: VAULT_KEY_MESSAGE }));
}, 240_000);

afterAll(async () => {
  if (!tools) return;
  await destroyProver();
  await anvil?.stop();
});

describe.skipIf(!tools)("private sell / buy / park on anvil (real verifiers)", () => {
  test("private sell -> v2 USDG note; buy back with it directly; settle + withdraw", async () => {
    expect(dep.shieldedTrade).toBeString();
    await deposit(tsla(), 10n * E18);
    const stockNote = await find(tsla());
    expect(stockNote.raw).toBe(10n * E18);

    // Sell 4 mTSLA ($250) for >= 990 USDG; the relayer keeps 0.01 mTSLA.
    const s = await proveSwap({ keys: ka, tree: state!.tree, note: stockNote, amountIn: 4n * E18, relayerFee: E18 / 100n, assetOut: usdg(), minOut: 980n * U, deadline: await deadline() });
    const r = await send(relayer, swapTx(trade(), s, 100));
    expect(r.from.toLowerCase()).toBe(relayer.toLowerCase());
    expect(r.gasUsed).toBeLessThan(8_000_000n);
    expect(await spent(s.pub.nullifier)).toBe(true);
    expect(await read(tsla(), tokenAbi, "balanceOf", [relayer])).toBe(E18 / 100n);

    const usdgNote = await find(usdg());
    expect(usdgNote.version).toBe(2);
    expect(usdgNote.raw).toBeGreaterThanOrEqual(990n * U);
    expect(usdgNote.raw).toBeLessThan(997_500_000n); // 3.99 x $250, minus the pool fee
    expect(await shielded(usdg())).toBe(usdgNote.raw);
    expect((await find(tsla())).raw).toBe(6n * E18); // the v1 change note
    expect(await shielded(tsla())).toBe(6n * E18);

    // Buy mTSLA back with the unsettled v2 USDG note.
    const b = await proveSwap({ keys: ka, tree: state!.tree, note: usdgNote, amountIn: usdgNote.raw, assetOut: tsla(), minOut: 39n * E18 / 10n, deadline: await deadline() });
    await send(relayer, swapTx(trade(), b, 100));
    const bought = await find(tsla(), (n) => n.version === 2);
    expect(bought.raw).toBeGreaterThan(39n * E18 / 10n);
    expect(bought.raw).toBeLessThan(4n * E18);
    expect(await shielded(usdg())).toBe(0n);

    // Settle the v2 stock note, then withdraw it publicly.
    const st = await proveSettle({ keys: ka, tree: state!.tree, note: bought });
    await send(relayer, settleTx(trade(), st));
    const settled = await find(tsla(), (n) => n.version !== 2 && n.raw === bought.raw);
    expect(settled).toBeDefined();
    const before = (await read(tsla(), tokenAbi, "balanceOf", [alice])) as bigint;
    const w = await proveWithdraw({ keys: ka, tree: state!.tree, note: settled, amount: settled.raw, recipient: alice });
    await send(relayer, withdrawTx(pool(), w));
    expect((await read(tsla(), tokenAbi, "balanceOf", [alice])) - before).toBe(bought.raw);
  }, 180_000);

  test("slippage revert leaves the note unspent; the same note sells afterwards", async () => {
    const note = await find(tsla(), (n) => n.raw === 6n * E18);
    const tooGreedy = await proveSwap({ keys: ka, tree: state!.tree, note, amountIn: E18, assetOut: usdg(), minOut: 300n * U, deadline: await deadline() });
    await expect(send(relayer, swapTx(trade(), tooGreedy, 100))).rejects.toThrow();
    expect(await spent(tooGreedy.pub.nullifier)).toBe(false);
    expect(await shielded(tsla())).toBe(6n * E18);
    const ok = await proveSwap({ keys: ka, tree: state!.tree, note, amountIn: E18, assetOut: usdg(), minOut: minOutFor(250n * U, 100), deadline: await deadline() });
    await send(relayer, swapTx(trade(), ok, 100));
    expect(await spent(ok.pub.nullifier)).toBe(true);
  }, 120_000);

  test("multiplier change mid-flight: raw note amounts are exactly what was proven", async () => {
    const note = await find(tsla(), (n) => n.raw === 5n * E18);
    const s = await proveSwap({ keys: ka, tree: state!.tree, note, amountIn: 2n * E18, assetOut: usdg(), minOut: 490n * U, deadline: await deadline() });
    await write(deployer, tsla(), tokenAbi, "setMultiplier", [2n * E18]); // e.g. a 2:1 split lands mid-flight
    const tslaBefore = await shielded(tsla());
    await send(relayer, swapTx(trade(), s, 100));
    expect(tslaBefore - (await shielded(tsla()))).toBe(2n * E18);
    expect((await find(tsla(), (n) => n.raw === 3n * E18)).version).toBe(1);
    await write(deployer, tsla(), tokenAbi, "setMultiplier", [E18]);
  }, 120_000);

  test("park USDG in the ERC-4626 vault, vault gains 1%, unpark returns the gain", async () => {
    await deposit(usdg(), 1000n * U);
    const cash = await find(usdg(), (n) => n.raw === 1000n * U);
    const p = await proveSwap({ keys: ka, tree: state!.tree, note: cash, amountIn: 1000n * U, assetOut: vault(), minOut: 1n, deadline: await deadline() });
    await send(relayer, swapTx(trade(), p));
    const shares = await find(vault());
    expect(shares.version).toBe(2);
    expect(await parkValue(pub, trade(), vault(), shares.raw)).toBe(1000n * U);

    const totalAssets = (await read(usdg(), tokenAbi, "balanceOf", [vault()])) as bigint;
    await write(deployer, usdg(), tokenAbi, "mint", [vault(), totalAssets / 100n]); // +1%
    const value = await parkValue(pub, trade(), vault(), shares.raw);
    expect(value).toBeGreaterThanOrEqual(1010n * U - 1n);
    expect(value).toBeLessThanOrEqual(1010n * U);

    const u = await proveSwap({ keys: ka, tree: state!.tree, note: shares, amountIn: shares.raw, assetOut: usdg(), minOut: value, deadline: await deadline() });
    await send(relayer, swapTx(trade(), u));
    const back = await find(usdg(), (n) => n.version === 2 && n.raw === value);
    expect(back.raw).toBe(value);
    expect(await shielded(vault())).toBe(0n);
  }, 180_000);
});
