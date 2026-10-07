// wagmi (core) + viem on the custom chain "Plynth fork" (31337): MetaMask through the injected connector, plus the
// localhost-only dev wallet. The dashboard is plain DOM (src/site/runtime.js), so this uses @wagmi/core actions.
import {
  connect,
  createConfig,
  disconnect,
  getConnections,
  getPublicClient,
  injected,
  reconnect,
  sendTransaction,
  signMessage,
  signTypedData,
  switchChain,
  waitForTransactionReceipt,
  watchConnections,
  type Config,
} from "@wagmi/core";
import {
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { devWalletAllowed, forkConfig, type ForkConfig } from "./config";
import { devWallet } from "./dev-wallet";
import { simulateTx, type SimClient } from "./simulate";

export function plynthForkChain(cfg: Pick<ForkConfig, "chainId" | "rpcUrl"> & { chainName?: string }) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? "Plynth fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    testnet: true,
  });
}

export type UnsignedTx = { to: Address; data: Hex; value?: string | bigint; chainId?: number };
export type SentTx = { hash: Hex; receipt: TransactionReceipt };
export type WalletKind = "injected" | "dev";

let config: Config | undefined;
let devOk = false;

export function wagmiConfig(): Config {
  if (config) return config;
  const cfg = forkConfig();
  const chain = plynthForkChain(cfg);
  devOk = typeof location !== "undefined" && devWalletAllowed(cfg, location.hostname);
  config = createConfig({
    chains: [chain],
    connectors: devOk
      ? [injected({ shimDisconnect: true }), devWallet({ rpcUrl: cfg.rpcUrl })]
      : [injected({ shimDisconnect: true })],
    transports: { [chain.id]: http(cfg.rpcUrl) },
    ssr: true,
  });
  return config;
}

export const devWalletEnabled = () => {
  wagmiConfig();
  return devOk;
};

export function publicClient(): PublicClient {
  return getPublicClient(wagmiConfig()) as PublicClient;
}

export function currentAccount(): { address: Address; kind: WalletKind } | null {
  const c = getConnections(wagmiConfig())[0];
  if (!c || !c.accounts[0]) return null;
  return {
    address: c.accounts[0],
    kind: c.connector.id === "plynthDevWallet" ? "dev" : "injected",
  };
}

export function onAccountChange(fn: () => void): () => void {
  return watchConnections(wagmiConfig(), { onChange: fn });
}

export async function connectWallet(kind: WalletKind): Promise<Address> {
  const c = wagmiConfig();
  const connector = c.connectors.find((x) =>
    kind === "dev" ? x.id === "plynthDevWallet" : x.type === "injected",
  );
  if (!connector)
    throw new Error(
      kind === "dev"
        ? "Dev wallet is off (VITE_DEV_WALLET=1 on localhost only)."
        : "No browser wallet found. Install MetaMask.",
    );
  const chainId = forkConfig().chainId;
  const res = await connect(c, { connector, chainId });
  // MetaMask: make sure it is on the fork (adds the network if it does not know it).
  if (res.chainId !== chainId) await switchChain(c, { chainId });
  return res.accounts[0]! as Address;
}

export async function disconnectWallet(): Promise<void> {
  await disconnect(wagmiConfig());
}

function need(): Address {
  const a = currentAccount();
  if (!a) throw new Error("Connect a wallet first.");
  return a.address;
}

let lastReceiptBlock: bigint | undefined;

/**
 * Simulates, then signs and sends an unsigned tx (as the API returns it), then waits for its receipt. A call that
 * would revert never reaches the wallet: it throws a SimulationRevert with the decoded reason (todo 41).
 */
export async function sendAndWait(
  tx: UnsignedTx,
  onHash?: (h: Hex) => void,
  label = "Transaction",
): Promise<SentTx> {
  const c = wagmiConfig();
  const chainId = forkConfig().chainId;
  if (tx.chainId !== undefined && tx.chainId !== chainId)
    throw new Error(`transaction is for chain ${tx.chainId}, the wallet is on ${chainId}`);
  const account = need();
  const value = tx.value ? BigInt(tx.value) : 0n;
  const gas = await simulateTx(
    publicClient() as unknown as SimClient,
    { account, to: tx.to, data: tx.data, value },
    label,
    lastReceiptBlock !== undefined ? { minBlock: lastReceiptBlock } : {},
  );
  const hash = await sendTransaction(c, { account, to: tx.to, data: tx.data, value, gas, chainId });
  onHash?.(hash);
  const receipt = await waitForTransactionReceipt(c, { hash, chainId });
  lastReceiptBlock = receipt.blockNumber;
  if (receipt.status !== "success")
    throw Object.assign(new Error(`transaction ${hash} reverted`), { hash });
  return { hash, receipt };
}

/** The block of the last receipt this page saw (reads after an action wait for a node that has it). */
export const lastSeenBlock = () => lastReceiptBlock;

export function signText(message: string): Promise<Hex> {
  return signMessage(wagmiConfig(), { account: need(), message });
}

export function signTyped(td: Parameters<typeof signTypedData>[1]): Promise<Hex> {
  return signTypedData(wagmiConfig(), { ...td, account: need() } as never);
}

let restored: Promise<void> | undefined;
/** After a page load: reconnect the wallet used last (MetaMask's permission or the dev wallet's flag). */
export function restoreConnection(): Promise<void> {
  return (restored ??= reconnect(wagmiConfig()).then(
    () => undefined,
    () => undefined,
  ));
}
