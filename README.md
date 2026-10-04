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
# Hidden Vault circuits only (versions pinned in circuits/VERSIONS):
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash && noirup -v 1.0.0-beta.25
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash && bbup -v 5.2.0
```

## Run

```bash
bun run test:contracts                                   # contract unit tests
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com bun run test:contracts   # + mainnet-fork tests
bun test                                                 # TypeScript tests
bun run verify:chain                                     # re-check every address against the live chain
bun run indexer --once && bun run keeper --once          # one indexer + keeper pass (see .env.example)
bun run api                                              # dashboard API: tRPC at /trpc, REST mirror at /v1
bun run relayer                                          # gasless Quiet claims: POST /claim on :8789
bun apps/eligibility/scripts/download-dbip.ts            # monthly: free IP-to-country database into data/
bun run eligibility                                      # eligibility screen: POST /eligibility/check on :8790
```

## Layout

- `contracts/src/core/` Foundry. `StockTokenRegistry` (board-curated canonical list, fail-closed) and `Valuer`
  (Chainlink price x ERC-8056 `uiMultiplier()`, applied exactly once; stale feed -> `hold`, not revert).
- `apps/keeper/` Round-ups, weekly top-ups, sweeps into crowd books, JitterBeacon commit-reveal and crowd
  execution. Every action is pre-simulated; the contracts bound what the keeper can do.
- `apps/api/` Read-only dashboard API (Hono + tRPC, REST mirror under `/v1`): account overview, saving habit,
  activity, settings, Crowd Buy books, health. Transactions come back unsigned (`{to, data, value, chainId}`)
  for the user's own wallet; the API holds no keys. `meta.eligibility` is a self-attestation stub, not KYC.
- `apps/relayer/` Gasless claims for Quiet delivery: verifies the stealth key's EIP-712 signature off-chain,
  simulates, and sends `StealthClaims.claim` from its own wallet. Rate-limited per IP and per stealth address;
  refuses claims into Plynth contracts.
- `contracts/src/core/EligibilityRegistry.sol` + `apps/eligibility/` Eligibility screening with free sources:
  an EIP-712 self-attestation signed by the wallet, the IP's country (MMDB database, plus `CF-IPCountry`
  behind Cloudflare) and the OFAC SDN digital-currency addresses (refreshed daily; fails closed when stale).
  A pass returns a 30-day attestation signed by the attester key that anyone can submit to the registry.
  Screens are pluggable, so a KYC vendor can be added as one more. Decisions are stored without the IP.
  The API also serves the route at `/v1/eligibility/check` when `ELIGIBILITY_REGISTRY` is set.
- `packages/sdk/` ERC-5564 scheme 1 stealth addresses (keys from a wallet signature, meta-address, ERC-6538
  registration calldata, announcement scanning with view tags, stealth keys, claim signing). Matches the ERC's
  reference vector.
- `circuits/` Hidden Vault Noir circuits (UltraHonk, no per-circuit trusted setup): `transfer` (2-in/2-out,
  one asset) and `withdraw` (1 note -> public amount + change, recipient and relayer fee bound as public
  inputs), on the shared note model in `circuits/hidden` (Poseidon2 commitments/nullifiers, depth-20 tree).
  `bash circuits/scripts/build.sh` regenerates `contracts/src/consumer/verifiers/{Transfer,Withdraw}Verifier.sol`;
  `bun circuits/scripts/fixtures.ts` regenerates the Poseidon2 fixtures and `HiddenConstants.sol`;
  `circuits/scripts/prove.ts` is the client-side prover (noir_js + bb.js). `Poseidon2.sol` equals Noir's hash.
  Testnet and forks only until an external audit (mainnet deposit cap 0).
- Private sell / buy / park (`ShieldedTrade`, circuits `swap` + `settle`): a swap proof spends one note, sends
  `amountIn` through StockRouter (oracle guard) or a park adapter, and fixes the output note except its amount
  (`H(H(asset, ownerPk, blinding), amount)`, a "v2" note the contract completes with what it received, after
  checking the proven `minOut`). Any revert (slippage, oracle hold, cap, deadline) leaves the note unspent.
  `settle` turns a v2 note into a normal note for transfer/withdraw. Park adapters (`contracts/src/consumer/park/`):
  `ERC4626Park` (any allow-listed USDG ERC-4626 vault, e.g. Steakhouse USDG) and `MorphoBluePark` (USDG lender in
  one Morpho Blue market). Adding an adapter takes 48h; unparking is never gated, and park shares can also be
  withdrawn from the pool as shares and redeemed at the adapter directly.
- `packages/chain/` Shared TypeScript: chain configs, verified addresses, Stock Token ABI, `verify:chain`.

- `scripts/public-guard.sh` Blocks commits that contain keys, env files or private material (pre-commit hook;
  `bun install` sets `core.hooksPath` to `.githooks`). Run it by hand with `bun run guard`.

## Trust assumptions

What you have to trust, per component. Later components add their own entries here.

- **StockTokenRegistry.** The registry owner (the board) decides which Stock Tokens and feeds are canonical.
  Unlisted tokens are refused (fail-closed).
- **Valuer.** Chainlink price feeds on Robinhood Chain, and each Stock Token's own `uiMultiplier()`. A stale
  or missing feed returns `hold` instead of a price.
- **Quiet delivery (StealthClaims).** Only users who chose Quiet and registered an ERC-6538 meta-address can be
  delivered quietly. The keeper derives their stealth addresses off-chain; a contract cannot check that, so
  Quiet users trust the keeper to use their meta-address (a wrong one shows up in the user's own scan as a
  missing balance). Credited balances move only with the stealth key's signature; the relayer cannot redirect
  them. Funding and book membership stay public; the user and a stealth address never share a transaction.

- **Eligibility (EligibilityRegistry).** Buying (`SavingsVault.setMix`, `CrowdBuy.join`) needs a current
  attestation from the attester key; the owner sets the registry once and can rotate the attester, who can
  revoke. Exits (withdraw, cancel, claims) never check eligibility, so a revoked user can always leave. The
  screen is not KYC: it trusts the wallet's statement, an IP database and the public sanctions list.
- **Private trade and park (ShieldedTrade).** The pool owner sets the module once, before any deposit; after that
  its code is as trusted as the pool's (it can move pool assets after a valid proof). Its owner can only add park
  adapters (48h timelock) or stop new parks. Swaps trust StockRouter's oracle guard plus the user's own proven
  `minOut`; parked USDG carries the chosen vault's or Morpho market's risk (curator, oracle, liquidity: an
  unpark can wait for liquidity). Buys, sells and parks stop when pool deposits are paused and count against
  caps; unpark and settle never stop.

IP geolocation by [DB-IP](https://db-ip.com) (IP to Country Lite, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Sanctions data: the OFAC SDN list (US Treasury).

## Still to verify

- Chainlink feed addresses for each Stock Token (and whether each feed already embeds the multiplier).
- USDG token address; Orderly and Arcus contracts on 4663.
