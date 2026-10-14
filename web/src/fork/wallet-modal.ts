// The multi-wallet modal: Reown AppKit (WalletConnect's SDK) over its wagmi adapter. Loaded with a dynamic import,
// and only when VITE_WALLETCONNECT_PROJECT_ID is set, so the marketing pages never download it and a missing id
// falls back to the EIP-6963 browser-wallet list in wallet.ts instead of a broken modal.
// The chain is the active profile's only network (fork 31337, testnet 46630 or mainnet 4663), defined with viem's
// defineChain in wallet.ts; AppKit shows its own "switch network" view when a wallet is elsewhere.
import type { Config, CreateConnectorFn } from "@wagmi/core";
import { http, type Chain } from "viem";

export type WalletModal = {
  config: Config;
  open(): Promise<void>;
  disconnect(): Promise<void>;
  /** The wallet AppKit says is connected (for WalletConnect: the phone wallet's own name and icon). */
  walletInfo(): { name?: string; icon?: string } | undefined;
  ready(): Promise<void>;
  onWalletInfo(fn: () => void): () => void;
};

/** WalletConnect explorer ids shown first in the modal (installed browser wallets are listed above them anyway). */
export const FEATURED_WALLETS = {
  metamask: "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
  coinbase: "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa",
  rabby: "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1",
  rainbow: "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369",
  trust: "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0",
} as const;

/** The site's tokens (src/site/style.css :root) mapped onto AppKit's theme variables: square, mono, ink on paper. */
export const MODAL_THEME = {
  "--w3m-font-family": "Mono, 'Courier New', monospace",
  "--w3m-accent": "#111314",
  "--w3m-color-mix": "#f3b1d4",
  "--w3m-color-mix-strength": 12,
  "--w3m-border-radius-master": "0px",
  "--w3m-qr-color": "#111314",
  "--w3m-z-index": 1000,
} as const;

/** Every AppKit extra that is not "connect a wallet" stays off (privacy product: no analytics, no email/social). */
export const MODAL_FEATURES = {
  analytics: false,
  email: false,
  socials: false as const,
  swaps: false,
  onramp: false,
  send: false,
  receive: false,
  history: false,
  pay: false,
  reownAuthentication: false,
  legalCheckbox: false,
  allWallets: true,
};

export async function createWalletModal(opts: {
  projectId: string;
  chain: Chain;
  rpcUrl: string;
  /** Extra wagmi connectors (the localhost-only dev wallet). */
  connectors: CreateConnectorFn[];
  origin: string;
}): Promise<WalletModal> {
  const [{ createAppKit }, { WagmiAdapter }, { coinbaseWallet }, { OptionsController }] =
    await Promise.all([
      // The full entry: "@reown/appkit/core" is the adapter-less WalletConnect-only build (no wallet list).
      import("@reown/appkit"),
      import("@reown/appkit-adapter-wagmi"),
      import("@wagmi/connectors"),
      import("@reown/appkit-controllers"),
    ]);
  // AppKit 1.8.24 never copies the enableBaseAccount option into its state, so the adapter would still add the Base
  // Account connector (and its SDK's telemetry script) on every page load. Set the flag directly.
  OptionsController.setEnableBaseAccount(false);
  const { chain, projectId } = opts;
  const adapter = new WagmiAdapter({
    projectId,
    networks: [chain],
    // Our own Coinbase Wallet connector (enableCoinbase: false below stops AppKit adding its default one): same
    // wallet, but without the Coinbase SDK's telemetry script.
    connectors: [
      coinbaseWallet({ appName: "Plynth", preference: { options: "all", telemetry: false } }),
      ...opts.connectors,
    ],
    transports: { [chain.id]: http(opts.rpcUrl) },
  });
  const kit = createAppKit({
    // The adapter's optional fields trip exactOptionalPropertyTypes in AppKit's own types; the object is the SDK's.
    adapters: [adapter as never],
    projectId,
    networks: [chain],
    defaultNetwork: chain,
    allowUnsupportedChain: false,
    metadata: {
      name: "Plynth",
      description: "Private savings on Robinhood Chain",
      url: opts.origin,
      icons: [`${opts.origin}/favicon.png`],
    },
    featuredWalletIds: Object.values(FEATURED_WALLETS),
    enableCoinbase: false,
    enableBaseAccount: false,
    enableWalletGuide: false,
    features: MODAL_FEATURES,
    themeMode: "light",
    themeVariables: MODAL_THEME,
  });
  return {
    config: adapter.wagmiConfig,
    open: () => kit.open({ view: "Connect" }).then(() => undefined),
    disconnect: () => kit.disconnect(),
    walletInfo: () => kit.getWalletInfo() ?? undefined,
    ready: () => kit.ready(),
    onWalletInfo: (fn) => kit.subscribeWalletInfo(() => fn()),
  };
}
