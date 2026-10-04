import { createPublicClient, encodeAbiParameters, http, keccak256, type Address } from "viem";
import { robinhood, robinhoodTestnet } from "viem/chains";

export { robinhood, robinhoodTestnet };

export type Network = "mainnet" | "testnet";

// Each entry was confirmed to have code on-chain on 2026-10-04 (see verify.ts). null = absent on that network.
// usdg: 6 decimals on both networks (symbol "USDG", name "Global Dollar"). The testnet token is a different
// address from mainnet; testnet has no Stock Tokens, so it is useful only for USDG-side flows.
export const contracts = {
  mainnet: {
    entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    uniV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    uniV4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    uniV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    morphoUsdg: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    uniV4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    uniV4PositionDescriptor: "0x9639443158e8c5efa35bd45287bf2effd3d8dc06",
    uniV4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    uniV4ReservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
    uniUniversalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    uniUniversalRouter212: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    steakhouseUsdgVault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
    morphoVaultV2Factory: "0x0FBad98595b0186dA120E41f77C102beb49f803c",
    orderlyVault: "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9",
  },
  testnet: {
    entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    uniV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    uniV4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    uniV3Factory: null,
    morphoUsdg: null,
    usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    uniV4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    uniV4PositionDescriptor: "0x9639443158e8c5efa35bd45287bf2effd3d8dc06",
    uniV4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    uniV4ReservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
    uniUniversalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    uniUniversalRouter212: null,
    steakhouseUsdgVault: null,
    morphoVaultV2Factory: null,
    orderlyVault: "0x2A5b650A894409372DDeE241EDAC92d4152bE24d",
  },
} as const satisfies Record<Network, Record<string, Address | null>>;

// Mainnet only; Stock Tokens are not deployed on testnet.
export const stockTokens = {
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  MSTR: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QCOM: "0x0f17206447090e464C277571124dD2688E48AEA9",
} as const satisfies Record<string, Address>;

export type StockSymbol = keyof typeof stockTokens;

/** USDG (Global Dollar), 6 decimals. Most common counter-currency of Stock Token pools on Uniswap v4. */
export const usdg = { mainnet: contracts.mainnet.usdg, testnet: contracts.testnet.usdg, decimals: 6 } as const;

export type Feed = { feed: Address; decimals: number; multiplierEmbedded: boolean };

/**
 * Chainlink price feeds (proxy addresses) on mainnet, one per Stock Token. They price one TOKEN, not one
 * share: the uiMultiplier is already applied, so never multiply again. They update on deviation during
 * 24/5 market sessions and hold the last price off-hours (no weekend heartbeat): treat stale as "hold".
 * QCOM has no feed (null). Not deployed on testnet.
 */
export const feeds = {
  TSLA: { feed: "0x4A1166a659A55625345e9515b32adECea5547C38", decimals: 8, multiplierEmbedded: true },
  AAPL: { feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", decimals: 8, multiplierEmbedded: true },
  NVDA: { feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", decimals: 8, multiplierEmbedded: true },
  AMZN: { feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", decimals: 8, multiplierEmbedded: true },
  MSFT: { feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", decimals: 8, multiplierEmbedded: true },
  GOOGL: { feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", decimals: 8, multiplierEmbedded: true },
  META: { feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", decimals: 8, multiplierEmbedded: true },
  MSTR: { feed: "0x396118bdFB181e6240E74D243F266B061c0edc3D", decimals: 8, multiplierEmbedded: true },
  SPY: { feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", decimals: 8, multiplierEmbedded: true },
  QCOM: null,
} as const satisfies Record<StockSymbol, Feed | null>;

/** Chainlink USDG / USD on mainnet (8 decimals). */
export const usdgUsdFeed: Feed = { feed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", decimals: 8, multiplierEmbedded: false };

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/**
 * Deepest hookless USDG/Stock Token pool per token on mainnet v4, chosen 2026-10-04 by best V4Quoter
 * output for 100 USDG. Many hooked and spam pools exist; these are the defaults, not the only routes.
 * AMZN and GOOGL could not fill 10,000 USDG in one swap on that date.
 */
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const U = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const v4Pools = {
  TSLA: { id: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e", key: { currency0: stockTokens.TSLA, currency1: U, fee: 3000, tickSpacing: 60, hooks: ZERO } }, // not-a-key
  AAPL: { id: "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb", key: { currency0: U, currency1: stockTokens.AAPL, fee: 3000, tickSpacing: 60, hooks: ZERO } }, // not-a-key
  NVDA: { id: "0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5", key: { currency0: U, currency1: stockTokens.NVDA, fee: 100, tickSpacing: 1, hooks: ZERO } }, // not-a-key
  AMZN: { id: "0x751e89b1e830a959e282377cf53bacc046ff7d6b67c6209504c3db692992c3cd", key: { currency0: stockTokens.AMZN, currency1: U, fee: 2500, tickSpacing: 25, hooks: ZERO } }, // not-a-key
  MSFT: { id: "0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579", key: { currency0: U, currency1: stockTokens.MSFT, fee: 3000, tickSpacing: 60, hooks: ZERO } }, // not-a-key
  GOOGL: { id: "0x43fe16b75cabbf38f5b185d16142b02d1d9200d8f1ba17cb6cf899f562c6197f", key: { currency0: stockTokens.GOOGL, currency1: U, fee: 300, tickSpacing: 3, hooks: ZERO } }, // not-a-key
  META: { id: "0xc58bb68060bcb7b3ea0f6d4a4afef1e57f628722e808db12afb6d1733552872f", key: { currency0: U, currency1: stockTokens.META, fee: 310, tickSpacing: 3, hooks: ZERO } }, // not-a-key
  MSTR: { id: "0xc105b8300ff65d750a0e4e63c7a879e20504069b770713464a5315e797735326", key: { currency0: U, currency1: stockTokens.MSTR, fee: 2400, tickSpacing: 24, hooks: ZERO } }, // not-a-key
  SPY: { id: "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907", key: { currency0: stockTokens.SPY, currency1: U, fee: 500, tickSpacing: 5, hooks: ZERO } }, // not-a-key
  QCOM: { id: "0x106af997d180cf37a574c42c04179f267b9245cf221b1c57fb3e491137915de6", key: { currency0: stockTokens.QCOM, currency1: U, fee: 3500, tickSpacing: 71, hooks: ZERO } }, // not-a-key
} as const satisfies Record<StockSymbol, { id: `0x${string}`; key: PoolKey }>;

/** v4 pool id = keccak256(abi.encode(PoolKey)). */
export function poolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const aggregatorAbi = [
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
] as const;

export const stateViewAbi = [
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
] as const;

export const erc4626Abi = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const vaultV2FactoryAbi = [
  { type: "function", name: "isVaultV2", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * Stock Tokens are beacon proxies; the beacon doubles as an access registry with a BLOCKLIST
 * (isBlocked / blockAccounts) plus global pause. There is no allowlist: fresh EOAs, stealth addresses and
 * contracts can receive and send them (fork-tested 2026-10-04).
 */
export const accessRegistryAbi = [
  { type: "function", name: "isBlocked", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const stockTokenAbi = [
  { type: "function", name: "ACCESS_CONTROLLED_REGISTRY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export function client(network: Network) {
  const chain = network === "mainnet" ? robinhood : robinhoodTestnet;
  const url = network === "mainnet" ? process.env.RHC_MAINNET_RPC_URL : process.env.RHC_TESTNET_RPC_URL;
  // Batch reads into Multicall3: the public RPC rate-limits per request.
  return createPublicClient({ chain, transport: http(url || undefined, { retryCount: 5, retryDelay: 1500 }), batch: { multicall: true } });
}
