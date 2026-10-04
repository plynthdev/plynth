import {
  contracts, stockTokens, stockTokenAbi, client, type Network, usdg, feeds, usdgUsdFeed, v4Pools, poolId,
  erc20Abi, aggregatorAbi, stateViewAbi, erc4626Abi, vaultV2FactoryAbi, accessRegistryAbi,
} from "@/chain";
import { configValue } from "@/config";

const rpcFor = (network: Network) => configValue(network === "mainnet" ? "RHC_MAINNET_RPC_URL" : "RHC_TESTNET_RPC_URL");

let failed = 0;
const fail = (msg: string) => { failed++; console.log(`FAIL ${msg}`); };

for (const network of ["mainnet", "testnet"] as Network[]) {
  const c = client(network, rpcFor(network));
  const id = await c.getChainId();
  if (id !== c.chain.id) fail(`${network}: rpc chainId ${id} != ${c.chain.id}`);
  else console.log(`ok   ${network}: chainId ${id}`);

  for (const [name, addr] of Object.entries(contracts[network])) {
    const code = addr ? await c.getCode({ address: addr }) : undefined;
    const present = !!code && code !== "0x";
    if (present !== (addr !== null)) fail(`${network}.${name} expected ${addr ? "code" : "absent"}`);
    else console.log(`ok   ${network}.${name} ${addr ?? "(absent)"}`);
  }
}

const main = client("mainnet", rpcFor("mainnet"));
for (const [sym, address] of Object.entries(stockTokens)) {
  const [onchainSym, mult] = await Promise.all([
    main.readContract({ address, abi: stockTokenAbi, functionName: "symbol" }),
    main.readContract({ address, abi: stockTokenAbi, functionName: "uiMultiplier" }),
  ]);
  if (onchainSym !== sym) fail(`${sym}: on-chain symbol is ${onchainSym}`);
  else console.log(`ok   ${sym} uiMultiplier=${Number(mult) / 1e18}`);
}

// USDG on both networks
for (const network of ["mainnet", "testnet"] as Network[]) {
  const c = client(network, rpcFor(network));
  const address = usdg[network];
  const [sym, dec] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (sym !== "USDG" || dec !== usdg.decimals) fail(`${network}.usdg: ${sym} / ${dec} decimals`);
  else console.log(`ok   ${network}.usdg ${address} USDG ${dec}dp`);
}

// Chainlink feeds: right description, decimals, positive answer
const feedChecks = [...Object.entries(feeds), ["USDG", usdgUsdFeed] as const];
for (const [sym, f] of feedChecks) {
  if (!f) { console.log(`ok   feed ${sym} (none on-chain, recorded null)`); continue; }
  try {
    const [desc, dec, round] = await Promise.all([
      main.readContract({ address: f.feed, abi: aggregatorAbi, functionName: "description" }),
      main.readContract({ address: f.feed, abi: aggregatorAbi, functionName: "decimals" }),
      main.readContract({ address: f.feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
    ]);
    const age = Math.round((Date.now() / 1000 - Number(round[3])) / 3600);
    if (!desc.toUpperCase().includes(sym)) fail(`feed ${sym}: description "${desc}"`);
    else if (dec !== f.decimals) fail(`feed ${sym}: decimals ${dec} != ${f.decimals}`);
    else if (round[1] <= 0n) fail(`feed ${sym}: answer ${round[1]}`);
    else console.log(`ok   feed ${sym} "${desc}" ${Number(round[1]) / 10 ** dec} (${age}h old)`);
  } catch (e) { fail(`feed ${sym}: ${(e as Error).message.split("\n")[0]}`); }
}

// v4 pools: id derives from key, pool initialised with liquidity
for (const [sym, p] of Object.entries(v4Pools)) {
  if (poolId(p.key) !== p.id) { fail(`pool ${sym}: id mismatch`); continue; }
  const liq = await main.readContract({ address: contracts.mainnet.uniV4StateView, abi: stateViewAbi, functionName: "getLiquidity", args: [p.id] });
  if (liq === 0n) fail(`pool ${sym}: zero in-range liquidity`);
  else console.log(`ok   pool ${sym}/USDG fee=${p.key.fee} ts=${p.key.tickSpacing} liquidity=${liq}`);
}

// ERC-4626 USDG vault and its factory
{
  const v = contracts.mainnet.steakhouseUsdgVault;
  const [asset, ta, px, isV2] = await Promise.all([
    main.readContract({ address: v, abi: erc4626Abi, functionName: "asset" }),
    main.readContract({ address: v, abi: erc4626Abi, functionName: "totalAssets" }),
    main.readContract({ address: v, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** 18n] }),
    main.readContract({ address: contracts.mainnet.morphoVaultV2Factory, abi: vaultV2FactoryAbi, functionName: "isVaultV2", args: [v] }),
  ]);
  if (asset.toLowerCase() !== usdg.mainnet.toLowerCase()) fail(`steakhouseUsdgVault asset ${asset}`);
  else if (!isV2) fail(`steakhouseUsdgVault not from morphoVaultV2Factory`);
  else console.log(`ok   steakhouseUsdgVault asset=USDG totalAssets=${Number(ta) / 1e6} USDG share=${Number(px) / 1e6} USDG`);
}

// Stock Token restriction model: blocklist registry, not paused
{
  const reg = await main.readContract({ address: stockTokens.TSLA, abi: stockTokenAbi, functionName: "ACCESS_CONTROLLED_REGISTRY" });
  const [blocked, paused] = await Promise.all([
    main.readContract({ address: reg, abi: accessRegistryAbi, functionName: "isBlocked", args: ["0x000000000000000000000000000000000000dEaD"] }),
    main.readContract({ address: reg, abi: accessRegistryAbi, functionName: "paused" }),
  ]);
  if (blocked) fail(`access registry blocks an arbitrary address: allowlist model?`);
  else console.log(`ok   stock token access registry ${reg} is a blocklist (paused=${paused})`);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall chain facts verified");
