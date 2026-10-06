// Touches, right after the fork starts, the real mainnet state the exercise will use, so anvil fetches it while
// the public RPC still serves the fork block (it keeps ~10-15 minutes of state; rpc-cache.ts pins whatever was
// fetched, and falls back to `latest` for anything first read later).
//
//   warmReal()    before the deploy: feeds, every pool through the real v4 Quoter, each Stock Token's transfer
//                 path (a 1-wei transfer out of the PoolManager, impersonated), a steakUSDG deposit + redeem, the
//                 issuer role checks, Permit2, ERC-5564/6538, Multicall3. Needs only the deployer's USDG.
//   warmPlynth()  after the deploy: a small buy and sell of every listed token through Plynth's StockRouter.
import { encodeFunctionData, getAddress, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { clients, devAccount, log, readForkDeployment, ROLE } from "./lib";
import { U, USDG } from "./fund";

/** Issuer roles on the real Stock Tokens (found by eth_call simulation on 4663, 2026-10-06; chain facts). */
export const TOKEN_PAUSER = getAddress("0xfccf56b674113d9c4eb0f9b3370930ced9e6ab23");
export const TOKEN_BLOCKER = getAddress("0x913ca87347391218e5de2c17c5a0aeba8b0b28fd");
export const V4_QUOTER = getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const STEAK_USDG = getAddress("0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const ANNOUNCER = getAddress("0x55649E01B5Df198D18D95b5cc5051630cfD45564");
const REGISTRY_6538 = getAddress("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538");
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

/** Same table as ForkMainnet.s.sol (chain facts, default hookless USDG pools, 2026-10-04). */
export const STOCKS: { sym: string; token: Address; feed: Address; fee: number; tickSpacing: number; deep: boolean }[] = [
  { sym: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", fee: 3000, tickSpacing: 60, deep: true },
  { sym: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", fee: 3000, tickSpacing: 60, deep: true },
  { sym: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", fee: 100, tickSpacing: 1, deep: true },
  { sym: "AMZN", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", fee: 2500, tickSpacing: 25, deep: false },
  { sym: "MSFT", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", fee: 3000, tickSpacing: 60, deep: true },
  { sym: "GOOGL", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", fee: 300, tickSpacing: 3, deep: false },
  { sym: "META", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", fee: 310, tickSpacing: 3, deep: false },
  { sym: "MSTR", token: "0xec262a75e413fAfD0dF80480274532C79D42da09", feed: "0x396118bdFB181e6240E74D243F266B061c0edc3D", fee: 2400, tickSpacing: 24, deep: true },
  { sym: "SPY", token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", fee: 500, tickSpacing: 5, deep: true },
].map((s) => ({ ...s, token: getAddress(s.token), feed: getAddress(s.feed) }));

const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const tokenAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
  "function pause()",
  "function unpause()",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);
const accessAbi = parseAbi(["function blockAccounts(address[] accounts)", "function unblockAccounts(address[] accounts)", "function paused() view returns (bool)"]);
const routerAbi = parseAbi(["function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient) returns (uint256)", "function sell(address stockToken, uint256 rawIn, uint16 maxSlippageBps, address recipient) returns (uint256)"]);
const vaultAbi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const misc = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function allowance(address, address, address) view returns (uint160, uint48, uint48)",
  "function stealthMetaAddressOf(address, uint256) view returns (bytes)",
  "function nonceOf(address) view returns (uint256)",
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)",
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[])",
  "function approve(address, uint256) returns (bool)",
]);

function helpers() {
  const { pub, wallet, rpc } = clients();
  const d = devAccount(ROLE.deployer);
  const w = wallet(d);
  const call = async (to: Address, data: Hex, from: Address = d.address) => {
    try {
      await pub.call({ account: from, to, data });
    } catch {}
  };
  const send = async (to: Address, data: Hex) => {
    try {
      const r = await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to, data }) });
      return r.status === "success";
    } catch (e) {
      log(`warm: tx to ${to} failed (${(e as Error).message.split("\n")[0]})`);
      return false;
    }
  };
  return { pub, w, rpc, d, call, send };
}

export async function warmReal() {
  const { pub, rpc, d, call, send } = helpers();
  const t0 = Date.now();
  let quotes = 0;
  for (const s of STOCKS) {
    await call(s.feed, encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" }));
    await call(s.feed, encodeFunctionData({ abi: feedAbi, functionName: "decimals" }));
    for (const fn of ["uiMultiplier", "newUIMultiplier", "effectiveAt", "paused", "decimals", "totalSupply", "ACCESS_CONTROLLED_REGISTRY"] as const) await call(s.token, encodeFunctionData({ abi: tokenAbi, functionName: fn }));
    const usdgIs0 = BigInt(USDG) < BigInt(s.token);
    const poolKey = { currency0: usdgIs0 ? USDG : s.token, currency1: usdgIs0 ? s.token : USDG, fee: s.fee, tickSpacing: s.tickSpacing, hooks: "0x0000000000000000000000000000000000000000" as Address };
    // $25k only on the deep pools: on a thin pool a big quote walks every initialised tick, one RPC fetch each.
    for (const usd of s.deep ? [100n, 25_000n] : [100n]) {
      let tokens = 0n;
      try {
        const r = await pub.simulateContract({ account: d.address, address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne: usdgIs0, exactAmount: usd * U, hookData: "0x" }] });
        tokens = r.result[0];
      } catch {}
      if (tokens > 0n) await call(V4_QUOTER, encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne: !usdgIs0, exactAmount: tokens, hookData: "0x" }] }));
      quotes += 2;
    }
    // The token's transfer path, once: 1 wei out of the PoolManager (impersonated).
    await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
    await rpc("anvil_setBalance", [POOL_MANAGER, "0xde0b6b3a7640000"]);
    try {
      const h = await rpc<Hex>("eth_sendTransaction", [{ from: POOL_MANAGER, to: s.token, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [d.address, 1n] }) }]);
      await pub.waitForTransactionReceipt({ hash: h });
    } catch {}
    await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
    // Issuer controls: the role checks behind pause / unpause (simulated, nothing changes).
    await call(s.token, encodeFunctionData({ abi: tokenAbi, functionName: "pause" }), TOKEN_PAUSER);
    await call(s.token, encodeFunctionData({ abi: tokenAbi, functionName: "unpause" }), TOKEN_PAUSER);
  }
  const registry = (await pub.readContract({ address: STOCKS[0]!.token, abi: tokenAbi, functionName: "ACCESS_CONTROLLED_REGISTRY" })) as Address;
  await call(registry, encodeFunctionData({ abi: accessAbi, functionName: "blockAccounts", args: [[d.address]] }), TOKEN_BLOCKER);
  await call(registry, encodeFunctionData({ abi: accessAbi, functionName: "unblockAccounts", args: [[d.address]] }), TOKEN_BLOCKER);
  await call(registry, encodeFunctionData({ abi: accessAbi, functionName: "paused" }));

  // steakUSDG (Morpho Vault V2): views, then a real deposit and redeem.
  await call(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "totalAssets" }));
  await call(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "convertToAssets", args: [10n ** 18n] }));
  await call(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "convertToShares", args: [U] }));
  await call(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "previewRedeem", args: [10n ** 24n] }));
  await call(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "maxWithdraw", args: [d.address] }));
  if (await send(USDG, encodeFunctionData({ abi: misc, functionName: "approve", args: [STEAK_USDG, maxUint256] }))) {
    if (await send(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [5_000n * U, d.address] }))) {
      const sh = (await pub.readContract({ address: STEAK_USDG, abi: vaultAbi, functionName: "balanceOf", args: [d.address] })) as bigint;
      await send(STEAK_USDG, encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [sh / 2n, d.address, d.address] }));
    }
  }

  // Canonical contracts: Permit2, ERC-6538 registry, ERC-5564 announcer, Multicall3.
  await call(PERMIT2, encodeFunctionData({ abi: misc, functionName: "DOMAIN_SEPARATOR" }));
  await call(PERMIT2, encodeFunctionData({ abi: misc, functionName: "allowance", args: [d.address, USDG, d.address] }));
  await call(REGISTRY_6538, encodeFunctionData({ abi: misc, functionName: "DOMAIN_SEPARATOR" }));
  await call(REGISTRY_6538, encodeFunctionData({ abi: misc, functionName: "nonceOf", args: [d.address] }));
  await call(REGISTRY_6538, encodeFunctionData({ abi: misc, functionName: "stealthMetaAddressOf", args: [d.address, 1n] }));
  await call(ANNOUNCER, encodeFunctionData({ abi: misc, functionName: "announce", args: [1n, d.address, `0x02${"11".repeat(32)}`, "0x00"] }));
  await call(MULTICALL3, encodeFunctionData({ abi: misc, functionName: "aggregate3", args: [[]] }));
  log(`warmed ${STOCKS.length} Stock Tokens (feeds, ${quotes} pool quotes, transfer paths, issuer roles), steakUSDG, Permit2, ERC-5564/6538, Multicall3 in ${Math.round((Date.now() - t0) / 1000)}s`);
}

export async function warmPlynth() {
  const dep = readForkDeployment();
  if (!dep) throw new Error("not deployed");
  const { pub, w, d, send } = helpers();
  const router = getAddress(dep.stockRouter as string);
  await send(USDG, encodeFunctionData({ abi: misc, functionName: "approve", args: [router, maxUint256] }));
  for (const s of STOCKS) {
    try {
      const sim = await pub.simulateContract({ account: d, address: router, abi: routerAbi, functionName: "buy", args: [s.token, 25n * U, 300, d.address] });
      await pub.waitForTransactionReceipt({ hash: await w.writeContract(sim.request) });
      const bal = (await pub.readContract({ address: s.token, abi: tokenAbi, functionName: "balanceOf", args: [d.address] })) as bigint;
      await send(s.token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [router, maxUint256] }));
      const sell = await pub.simulateContract({ account: d, address: router, abi: routerAbi, functionName: "sell", args: [s.token, bal / 2n, 300, d.address] });
      await pub.waitForTransactionReceipt({ hash: await w.writeContract(sell.request) });
    } catch (e) {
      log(`warm: ${s.sym} buy/sell through StockRouter refused (${(e as Error).message.split("\n")[0]})`);
    }
  }
  log("bought and sold every listed Stock Token once through StockRouter");
}

if (import.meta.main) {
  await warmReal();
  if (readForkDeployment()) await warmPlynth();
  process.exit(0);
}
