import { createPublicClient, http, type Address } from "viem";
import { robinhood, robinhoodTestnet } from "viem/chains";

export { robinhood, robinhoodTestnet };

export type Network = "mainnet" | "testnet";

// Each entry was confirmed to have code on-chain on 2026-10-04 (see verify.ts). null = absent on that network.
export const contracts = {
  mainnet: {
    entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    uniV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    uniV4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    uniV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    morphoUsdg: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
  },
  testnet: {
    entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    uniV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    uniV4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    uniV3Factory: null,
    morphoUsdg: null,
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

export const stockTokenAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export function client(network: Network) {
  const chain = network === "mainnet" ? robinhood : robinhoodTestnet;
  const url = network === "mainnet" ? process.env.RHC_MAINNET_RPC_URL : process.env.RHC_TESTNET_RPC_URL;
  return createPublicClient({ chain, transport: http(url || undefined) });
}
