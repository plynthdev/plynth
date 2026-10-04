# plynth

Backend for plynth on Robinhood Chain.

## Products

Two products share one core (`contracts/src/core/`, `packages/chain/`).

- **plynth (consumer).** Spare change and top-ups in USDG, pooled into Stock Token buys and delivered to
  the saver. Contracts in `contracts/src/consumer/`.
- **Plinth (treasury).** A board sets an on-chain policy; desk bots may only trade inside it, and each
  period closes with an on-chain NAV statement. Contracts in `contracts/src/treasury/`.

| Network | Chain ID | Public RPC | Explorer |
|---|---|---|---|
| Mainnet | 4663 | https://rpc.mainnet.chain.robinhood.com | https://robinhoodchain.blockscout.com |
| Testnet | 46630 | https://rpc.testnet.chain.robinhood.com | https://explorer.testnet.chain.robinhood.com |

Stock Tokens, the Morpho USDG vault and Uniswap v3 exist **only on mainnet**. Testnet has Uniswap v4,
the ERC-4337 EntryPoint and Permit2. So contracts are tested on a local **fork of mainnet**: a free,
simulated copy of the real chain. Nothing is spent and nothing is sent.

## Setup (Mac)

```bash
brew install oven-sh/bun/bun
curl -L https://foundry.paradigm.xyz | bash && foundryup
git submodule update --init --recursive
bun install
cp .env.example .env
```

## Run

```bash
bun run test:contracts                                   # contract unit tests
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com bun run test:contracts   # + mainnet-fork tests
bun test                                                 # TypeScript tests
bun run verify:chain                                     # re-check every address against the live chain
bun run indexer --once && bun run keeper --once          # one indexer + keeper pass (see .env.example)
bun run api                                              # dashboard API: tRPC at /trpc, REST mirror at /v1
```

## Layout

- `contracts/src/core/` Foundry. `StockTokenRegistry` (board-curated canonical list, fail-closed) and `Valuer`
  (Chainlink price x ERC-8056 `uiMultiplier()`, applied exactly once; stale feed -> `hold`, not revert).
- `apps/keeper/` Round-ups, weekly top-ups, sweeps into crowd books, JitterBeacon commit-reveal and crowd
  execution. Every action is pre-simulated; the contracts bound what the keeper can do.
- `apps/api/` Read-only dashboard API (Hono + tRPC, REST mirror under `/v1`): account overview, saving habit,
  activity, settings, Crowd Buy books, health. Transactions come back unsigned (`{to, data, value, chainId}`)
  for the user's own wallet; the API holds no keys. `meta.eligibility` is a self-attestation stub, not KYC.
- `packages/chain/` Shared TypeScript: chain configs, verified addresses, Stock Token ABI, `verify:chain`.

- `scripts/public-guard.sh` Blocks commits that contain keys, env files or private material (pre-commit hook;
  `bun install` sets `core.hooksPath` to `.githooks`). Run it by hand with `bun run guard`.

## Trust assumptions

What you have to trust, per component. Later components add their own entries here.

- **StockTokenRegistry.** The registry owner (the board) decides which Stock Tokens and feeds are canonical.
  Unlisted tokens are refused (fail-closed).
- **Valuer.** Chainlink price feeds on Robinhood Chain, and each Stock Token's own `uiMultiplier()`. A stale
  or missing feed returns `hold` instead of a price.

## Still to verify

- Chainlink feed addresses for each Stock Token (and whether each feed already embeds the multiplier).
- USDG token address; Orderly and Arcus contracts on 4663.
