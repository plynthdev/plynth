// wagmi (core) + viem on the configured chain (fork 31337, testnet 46630 or mainnet 4663). Two ways to pick a wallet:
// - VITE_WALLETCONNECT_PROJECT_ID set: the Reown AppKit modal (wallet-modal.ts, loaded on demand): installed browser
//   wallets, Coinbase Wallet, and WalletConnect (QR on desktop, deep links on a phone) for Rainbow, Trust, MetaMask
//   Mobile and the rest.
// - not set: the dashboard lists every browser wallet that announced itself through EIP-6963 (name and icon), plus
//   a plain window.ethereum wallet when none did. Never a modal that cannot work.
// The localhost-only 31337 dev wallet is offered in both. The dashboard is plain DOM (src/site/runtime.js), so this
// uses @wagmi/core actions.
import {
  connect,
  createConfig,
  disconnect,
  getConnections,
  hydrate,
  injected,
  reconnect,
  sendTransaction,
  signMessage,
  signTypedData,
  switchChain,
  waitForTransactionReceipt,
  watchConnections,
  watchConnectors,
  type Config,
  type Connector,
  type CreateConnectorFn,
} from "@wagmi/core";
import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { devWalletAllowed, forkConfig, MAINNET_CHAIN_ID, type ForkConfig } from "./config";
import { devWallet } from "./dev-wallet";
import { simulateTx, type SimClient } from "./simulate";
import type { WalletModal } from "./wallet-modal";

export function plynthForkChain(
  cfg: Pick<ForkConfig, "chainId" | "rpcUrl"> & { chainName?: string; explorerUrl?: string },
) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? "Plynth fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    ...(cfg.explorerUrl
      ? { blockExplorers: { default: { name: "Blockscout", url: cfg.explorerUrl } } }
      : {}),
    testnet: cfg.chainId !== MAINNET_CHAIN_ID,
  });
}

export type UnsignedTx = { to: Address; data: Hex; value?: string | bigint; chainId?: number };
export type SentTx = { hash: Hex; receipt: TransactionReceipt };
export type WalletKind = "injected" | "dev";
/** One entry of the no-project-id wallet list. */
export type WalletOption = { uid: string; name: string; icon?: string | undefined };

const DEV_ID = "plynthDevWallet";
/** wagmi's plain window.ethereum connector (the EIP-6963 ones carry the wallet's rdns as id). */
const PLAIN_INJECTED_ID = "injected";

let config: Config | undefined;
let modal: WalletModal | null = null;
let init: Promise<Config> | undefined;
let devOk = false;
const listeners = new Set<() => void>();

/**
 * "A wallet was connected on this browser": only then does a page load fetch the AppKit modal (to restore that
 * session); otherwise it is fetched on the first CONNECT WALLET. A flag, never an address.
 */
const USED = "plynth.wallet.used";
function walletUsed(): boolean {
  try {
    return localStorage.getItem(USED) === "1";
  } catch {
    return false;
  }
}
function rememberUsed(on: boolean) {
  try {
    if (on) localStorage.setItem(USED, "1");
    else localStorage.removeItem(USED);
  } catch {
    // Storage blocked: the modal then loads on the first CONNECT WALLET after each reload, nothing else changes.
  }
}

const notify = () => {
  if (config && getConnections(config).length) rememberUsed(true);
  listeners.forEach((f) => f());
};

/** The project id the modal would use; "" means the EIP-6963 list (also when the id is malformed). */
export const walletModalEnabled = () => Boolean(forkConfig().walletConnectProjectId);

/**
 * Builds the wallet layer once, in the browser: the AppKit modal and its wagmi config when a project id is set,
 * a plain wagmi config with EIP-6963 discovery otherwise. Everything reads the same wagmi config afterwards.
 */
export function initWallet(): Promise<Config> {
  return (init ??= (async () => {
    const cfg = forkConfig();
    const chain = plynthForkChain(cfg);
    devOk = typeof location !== "undefined" && devWalletAllowed(cfg, location.hostname);
    const extra: CreateConnectorFn[] = devOk ? [devWallet({ rpcUrl: cfg.rpcUrl })] : [];
    // import.meta.env.SSR is a build-time constant: the server bundles never pull in AppKit (nor its optional peers).
    if (cfg.walletConnectProjectId && !import.meta.env.SSR && typeof window !== "undefined") {
      try {
        const { createWalletModal } = await import("./wallet-modal");
        modal = await createWalletModal({
          projectId: cfg.walletConnectProjectId,
          chain,
          rpcUrl: cfg.rpcUrl,
          connectors: extra,
          origin: location.origin,
        });
        config = modal.config;
        modal.onWalletInfo(notify);
      } catch (e) {
        // The modal failed to load (blocked script, network): the browser-wallet list still works.
        console.warn("[plynth] wallet modal unavailable, using the browser-wallet list", e);
        modal = null;
      }
    }
    if (!config) {
      config = createConfig({
        chains: [chain],
        // EIP-6963 discovery (wagmi's default) adds one connector per announced wallet next to these.
        multiInjectedProviderDiscovery: true,
        connectors: [injected({ shimDisconnect: true }), ...extra],
        transports: { [chain.id]: http(cfg.rpcUrl) },
        ssr: true,
      });
      // ssr: nothing is restored until restoreConnection() reconnects; this adds the wallets announced so far.
      await hydrate(config, { reconnectOnMount: false }).onMount();
    }
    watchConnections(config, { onChange: notify });
    watchConnectors(config, { onChange: notify });
    return config;
  })());
}

/** The wagmi config, or undefined before initWallet() finished (server render, first paint). */
export const wagmiConfig = (): Config | undefined => config;

function ready(): Config {
  if (!config) throw new Error("The wallet is still loading, try again in a moment.");
  return config;
}

export const devWalletEnabled = () => {
  if (!config && typeof location !== "undefined")
    devOk = devWalletAllowed(forkConfig(), location.hostname);
  return devOk;
};

let pub: PublicClient | undefined;
/** Reads go straight to the configured RPC (the same transport the wallet layer uses). */
export function publicClient(): PublicClient {
  const cfg = forkConfig();
  return (pub ??= createPublicClient({
    chain: plynthForkChain(cfg),
    transport: http(cfg.rpcUrl),
  }) as PublicClient);
}

export type CurrentAccount = {
  address: Address;
  kind: WalletKind;
  /** Display name of the connected wallet ("MetaMask", "Rabby Wallet", the phone wallet behind WalletConnect). */
  wallet: string;
  icon?: string | undefined;
  chainId: number;
  /** False while the wallet is on another network than the profile's chain. */
  chainOk: boolean;
};

export function currentAccount(): CurrentAccount | null {
  if (!config) return null;
  const c = getConnections(config)[0];
  if (!c || !c.accounts[0]) return null;
  const dev = c.connector.id === DEV_ID;
  const info = dev ? undefined : modal?.walletInfo();
  return {
    address: c.accounts[0],
    kind: dev ? "dev" : "injected",
    wallet: info?.name || walletName(c.connector),
    icon: safeIcon(info?.icon ?? c.connector.icon),
    chainId: c.chainId,
    chainOk: c.chainId === forkConfig().chainId,
  };
}

/** Called on connect, disconnect, account or chain change, and when a browser wallet announces itself. */
export function onAccountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function walletName(c: Pick<Connector, "id" | "name">): string {
  return c.id === PLAIN_INJECTED_ID ? "Browser wallet" : c.name;
}

/** Wallet icons come from the extension (EIP-6963) or AppKit: only images, never another scheme. */
export function safeIcon(icon: string | undefined): string | undefined {
  return icon && /^(data:image\/|https:\/\/)/i.test(icon.trim()) ? icon.trim() : undefined;
}

/**
 * The browser wallets to offer without a project id: every EIP-6963 wallet, and the plain window.ethereum one only
 * when no wallet announced itself (an old extension) but one is injected. The dev wallet has its own button.
 */
export function pickWallets(
  connectors: readonly Pick<Connector, "uid" | "id" | "name" | "type" | "icon">[],
  hasWindowEthereum: boolean,
): WalletOption[] {
  const injectedOnes = connectors.filter((c) => c.type === "injected" && c.id !== DEV_ID);
  const announced = injectedOnes.filter((c) => c.id !== PLAIN_INJECTED_ID);
  const list = announced.length
    ? announced
    : injectedOnes.filter((c) => c.id === PLAIN_INJECTED_ID && hasWindowEthereum);
  return list.map((c) => ({ uid: c.uid, name: walletName(c), icon: safeIcon(c.icon) }));
}

export function browserWallets(): WalletOption[] {
  if (!config) return [];
  const eth =
    typeof window !== "undefined" &&
    "ethereum" in window &&
    Boolean((window as { ethereum?: unknown }).ethereum);
  return pickWallets(config.connectors, eth);
}

/** Opens the AppKit modal; false when there is none (no project id), so the caller shows the browser-wallet list. */
export async function openWalletModal(): Promise<boolean> {
  await initWallet();
  if (!modal) return false;
  await modal.open();
  return true;
}

/** Connects the dev wallet ("dev"), the plain injected wallet ("injected") or one listed wallet (its connector uid). */
export async function connectWallet(which: WalletKind | string): Promise<Address> {
  const c = await initWallet();
  const connector = c.connectors.find((x) =>
    which === "dev"
      ? x.id === DEV_ID
      : which === "injected"
        ? x.type === "injected" && x.id !== DEV_ID
        : x.uid === which,
  );
  if (!connector)
    throw new Error(
      which === "dev"
        ? "Dev wallet is off (VITE_DEV_WALLET=1 on localhost only)."
        : "No browser wallet found. Install MetaMask or another wallet extension.",
    );
  const chainId = forkConfig().chainId;
  const res = await connect(c, { connector, chainId });
  // Make sure the wallet is on the profile's chain (it adds the network if it does not know it).
  if (res.chainId !== chainId) await switchChain(c, { chainId });
  return res.accounts[0]! as Address;
}

/** Asks the connected wallet to switch to (or add) the profile's chain. */
export async function switchToProfileChain(): Promise<void> {
  await switchChain(ready(), { chainId: forkConfig().chainId });
}

export async function disconnectWallet(): Promise<void> {
  if (!config) return;
  const dev = getConnections(config)[0]?.connector.id === DEV_ID;
  if (modal && !dev) await modal.disconnect();
  else await disconnect(config);
  rememberUsed(false);
}

function need(): Address {
  const a = currentAccount();
  if (!a) throw new Error("Connect a wallet first.");
  return a.address;
}

/** Every signature and transaction is for the profile's chain: switch the wallet first if it wandered off. */
async function onProfileChain(c: Config, chainId: number): Promise<void> {
  const now = getConnections(c)[0]?.chainId;
  if (now !== undefined && now !== chainId) await switchChain(c, { chainId });
}

let lastReceiptBlock: bigint | undefined;

/**
 * Simulates, then signs and sends an unsigned tx (as the API returns it), then waits for its receipt. A call that
 * would revert never reaches the wallet: it throws a SimulationRevert with the decoded reason.
 */
export async function sendAndWait(
  tx: UnsignedTx,
  onHash?: (h: Hex) => void,
  label = "Transaction",
): Promise<SentTx> {
  const c = ready();
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
  await onProfileChain(c, chainId);
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

export async function signText(message: string): Promise<Hex> {
  const c = ready();
  await onProfileChain(c, forkConfig().chainId);
  return signMessage(c, { account: need(), message });
}

export async function signTyped(td: Parameters<typeof signTypedData>[1]): Promise<Hex> {
  const c = ready();
  await onProfileChain(c, forkConfig().chainId);
  return signTypedData(c, { ...td, account: need() } as never);
}

let restored: Promise<void> | undefined;
/**
 * After a page load: build the wallet layer and reconnect the wallet used last (the extension's permission, the
 * WalletConnect session AppKit kept, or the dev wallet's flag). With a project id and no wallet connected on this
 * browser before, nothing is loaded yet: the modal (~0.55 MB gzip) comes with the first CONNECT WALLET.
 */
export function restoreConnection(): Promise<void> {
  if (walletModalEnabled() && !walletUsed()) return (restored ??= Promise.resolve());
  return (restored ??= initWallet()
    .then(async (c) => {
      if (modal) {
        await modal.ready();
        // AppKit restores its own connections; the dev wallet connects around it, so reconnect that one here.
        const dev = c.connectors.filter((x) => x.id === DEV_ID);
        if (dev.length && !getConnections(c).length) await reconnect(c, { connectors: dev });
      } else await reconnect(c);
    })
    .then(
      () => undefined,
      () => undefined,
    ));
}

/** Test hook: forget the wallet layer. */
export function _resetWalletForTests() {
  config = undefined;
  modal = null;
  init = undefined;
  restored = undefined;
  pub = undefined;
  devOk = false;
  listeners.clear();
}
