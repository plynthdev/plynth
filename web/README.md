# plynth web

The Plynth site and dashboard: TanStack Start (React 19, Vite 8, Tailwind 4), wagmi core + viem for the wallet
(Reown AppKit for the multi-wallet modal),
`@plynth/sdk` (`file:../sdk`) for stealth and shielded-vault proofs in the browser. Setup, profiles, environment
and the Vercel settings are in the root README, section "Frontend (`web/`)".

```sh
bun install --cwd ../sdk && bun run --cwd ../sdk build   # the SDK is consumed from its dist/
bun install
bun run dev          # local fork (31337); dev:testnet / dev:mainnet for the other profiles
bun run test         # vitest
bun run build
```

The marketing pages keep the imported static-site runtime (`src/site/runtime.js` plus the layered site CSS): enhance
page-specific behaviour there rather than rewriting it in React, because the app mirrors that interaction model.
The live dashboard is `src/fork/` (same markup and classes as the preview, data from the API, every action a real
transaction simulated first).

## Wallets

`CONNECT WALLET` opens a wallet picker (`src/fork/wallet.ts`, `src/fork/wallet-modal.ts`):

- `VITE_WALLETCONNECT_PROJECT_ID` set (32 hex, a public value, not a secret): the Reown AppKit modal
  (`@reown/appkit` + `@reown/appkit-adapter-wagmi`, WalletConnect's SDK), loaded on demand. It lists the installed
  browser wallets (MetaMask, Rabby, Coinbase Wallet and any EIP-6963 wallet), Coinbase Wallet, and WalletConnect:
  a QR code on desktop and deep links on a phone (Rainbow, Trust, MetaMask Mobile, ...). The profile's chain is the
  only network; a wallet on another network is asked to switch (or add) it. Themed with the site's tokens; email,
  social login, swaps, on-ramp and analytics are off.
- Not set, or malformed: a list of every browser wallet that announced itself (EIP-6963, name and icon), or the
  plain `window.ethereum` wallet, or how to get one. No WalletConnect, never a broken modal.

Get a project id: sign in at https://dashboard.reown.com, create a project (type AppKit, platform Web), copy its
Project ID, add the site's domains (and `localhost` for dev) under the project's allowed domains, and set
`VITE_WALLETCONNECT_PROJECT_ID` in `.env.*.local` and in Vercel's environment variables (then redeploy). The dev
wallet (`VITE_DEV_WALLET=1`) is unchanged: localhost + 31337 only, and the build refuses it for any other chain.
