# plynth web

The Plynth site and dashboard: TanStack Start (React 19, Vite 8, Tailwind 4), wagmi core + viem for the wallet,
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
