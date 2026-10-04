# plynth

Backend for plynth on Robinhood Chain.

## Products

Two products share one core (`contracts/src/core/`, `app/src/chain/`).

- **plynth (consumer).** Spare change and top-ups in USDG, pooled into Stock Token buys and delivered to
  the saver. Contracts in `contracts/src/consumer/`.
- **Plinth (treasury).** A board sets an on-chain policy; desk bots may only trade inside it, and each
  period closes with an on-chain NAV statement. Contracts in `contracts/src/treasury/`.
  `TreasuryFactory` creates a board's treasury in one transaction (EIP-1167 clones of the policy, account,
  period close and approvals contracts, all owned by the board). The API serves it under `/v1/treasury/*`
  (create and policy proposals return unsigned transactions for the board Safe), and
  `bun run treasury:webhooks` delivers HMAC-signed `guard.denied`, `drawdown.state` and `close.committed` events.
  `bun run treasury:valuer` writes a NAV mark per treasury every 60 s (`nav.history`); `bun run treasury:receipts`
  posts an hourly Merkle root of every desk decision to `Receipts` (proofs at
  `/v1/treasury/:account/actions/:id/proof`); `bun run mcp` serves read-only treasury tools plus
  `exceptions_request` over MCP (stdio or streamable HTTP) with board-issued, per-treasury tokens; and
  `TemplateRegistry` lists reviewed policy templates whose authors earn a share of the platform fee.

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
bun app/scripts/download-dbip.ts            # monthly: free IP-to-country database into data/
bun run eligibility                                      # eligibility screen: POST /eligibility/check on :8790
```

## End to end

Both scenarios run on a local anvil fork (nothing is broadcast to a real network), start and stop everything
they need, check every number against the chain, exit non-zero on any mismatch and print the total runtime.

```bash
./scripts/e2e.sh consumer    # testnet fork: kit + consumer stack; API, relayer, indexer, keeper; three users
                             # through Open, Quiet and Hidden; API overview == on-chain truth
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com ./scripts/e2e.sh treasury
                             # mainnet fork: real Stock Tokens, USDG and steakUSDG; factory treasury from the
                             # balanced template; desks over a simulated week; period close; CFO pack
```

They need Postgres (`DATABASE_URL`, a throwaway `plynth_e2e_*` database is created and dropped), anvil, forge
and bun. The scenarios live in `app/scripts/e2e/`.

## Deploy to testnet (46630)

```bash
cd contracts
forge script script/TestnetKit.s.sol:TestnetKit --account <keystore> --sender <address> \
  --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --slow
KEEPER_ADDRESS=<keeper address> MIN_CROWD=3 forge script script/TestnetConsumer.s.sol:TestnetConsumer \
  --account <keystore> --sender <address> --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --slow
```

The kit deploys mock USDG, mock Stock Tokens with feeds, the core contracts and real Uniswap v4 pools; the
consumer script adds SavingsVault, CrowdBuy, StealthClaims and the Hidden Vault and writes every address to
`deployments/46630.json`, which the indexer, keeper, relayer and API read. Treasury: `TreasuryFactory.s.sol`
(writes `deployments/<chainid>-treasury.json`).

## Architecture

```
            users' wallets / frontend                         board Safe
                 |   (unsigned txs from the API)                  |  policy, desks, approvals
                 v                                                v
 +------------------------- Robinhood Chain (4663 / 46630) ----------------------------+
 |  core:      StockTokenRegistry -> Valuer (Chainlink x uiMultiplier) -> StockRouter  |
 |             (Uniswap v4 pools, oracle-guarded)          JitterBeacon (commit-reveal)|
 |  consumer:  SavingsVault -> CrowdBuy -> Open claim | StealthClaims (ERC-5564/6538)  |
 |                                       | ShieldedPool (+ ShieldedTrade, verifiers)   |
 |  treasury:  TreasuryFactory -> TreasuryPolicy / TreasuryAccount (PolicyGuard) /     |
 |             sleeves (cash, equity, perp, basis, private) / PeriodClose / Receipts   |
 +----^------------------^------------------^-------------------------^----------------+
      | logs             | txs              | txs                     | txs
 +----+-----+     +------+------+     +-----+-----+         +---------+------------+
 | indexer  |     |   keeper    |     |  relayer  |         | treasury services:   |
 | ev_logs  |---->| round-ups,  |     | gasless   |         | desks, close, valuer,|
 +----+-----+     | sweeps,     |     | claims /  |         | receipts, risk,      |
      |           | beacon,     |     | withdraws |         | reconciler, webhooks |
      v           | execute,    |     +-----------+         +---------+------------+
 +----------+     | deliver     |                                     |
 | Postgres |<----+-------------+-------------------------------------+
 +----+-----+
      v
 +----------+   tRPC /trpc + REST /v1 (read-only; returns unsigned transactions)
 |   api    |   + optional eligibility and round-up source routes, MCP server for treasuries
 +----------+
```

## Layout

- `contracts/src/core/` Foundry. `StockTokenRegistry` (board-curated canonical list, fail-closed) and `Valuer`
  (Chainlink price x ERC-8056 `uiMultiplier()`, applied exactly once; stale feed -> `hold`, not revert).
- `app/src/keeper/` Round-ups, weekly top-ups, sweeps into crowd books, JitterBeacon commit-reveal and crowd
  execution. Every action is pre-simulated; the contracts bound what the keeper can do.
- `app/src/api/` Read-only dashboard API (Hono + tRPC, REST mirror under `/v1`): account overview, saving habit,
  activity, settings, Crowd Buy books, health. Transactions come back unsigned (`{to, data, value, chainId}`)
  for the user's own wallet; the API holds no keys. `meta.eligibility` is a self-attestation stub, not KYC.
- `app/src/relayer/` Gasless claims for Quiet delivery: verifies the stealth key's EIP-712 signature off-chain,
  simulates, and sends `StealthClaims.claim` from its own wallet. Rate-limited per IP and per stealth address;
  refuses claims into Plynth contracts.
- `contracts/src/core/EligibilityRegistry.sol` + `app/src/eligibility/` Eligibility screening with free sources:
  an EIP-712 self-attestation signed by the wallet, the IP's country (MMDB database, plus `CF-IPCountry`
  behind Cloudflare) and the OFAC SDN digital-currency addresses (refreshed daily; fails closed when stale).
  A pass returns a 30-day attestation signed by the attester key that anyone can submit to the registry.
  Screens are pluggable, so a KYC vendor can be added as one more. Decisions are stored without the IP.
  The API also serves the route at `/v1/eligibility/check` when `ELIGIBILITY_REGISTRY` is set.
- `sdk/` ERC-5564 scheme 1 stealth addresses (keys from a wallet signature, meta-address, ERC-6538
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
- `app/src/chain/` Shared TypeScript: chain configs, verified addresses, Stock Token ABI, `verify:chain`.

- `.githooks/public-guard.sh` Blocks commits that contain keys, env files or private material (pre-commit hook;
  `bun install` sets `core.hooksPath` to `.githooks`). Run it by hand with `bun run guard`.

## Trust assumptions

What you have to trust, per component. Later components add their own entries here.

- **Unaudited.** No contract here has had an external audit. The Hidden Vault's deposit caps stay 0 on mainnet
  until one exists, and nothing should hold real money before that.
- **Keeper attests round-ups.** The vault cannot see a card or bank statement. The keeper reports each spend and
  the vault credits the round-up; the contract bounds it (one credit per source event, the user's weekly cap,
  only the keeper key may report), but within those bounds you trust the keeper's report.
- **Funding is public.** Deposits, top-ups, withdrawals and book membership are ordinary on-chain transfers.
  Quiet and Hidden hide where the bought Stock Tokens go, not that you saved or how much went into a book.
- **Crowd privacy depends on crowd size.** A book executes only with at least `MIN_CROWD` savers, and delivery
  hides each saver's share among the book's members; a small crowd is a small anonymity set.
- **USDG can be frozen by its issuer.** USDG is a regulated stablecoin; its issuer can freeze an address,
  including a vault or treasury account. Stock Tokens have their own issuer controls.

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

- **PeriodClose.** Recomputes NAV, band weights and the positions hash on-chain at commit, so a statement
  cannot claim holdings the account does not have. You trust the policy's controller to sign only the bundle
  it stored (the chain checks the bundle's hash, not its desk-action log), and the board to appoint the
  PeriodClose: it alone may move the platform fee (0.25%/year of NAV, from idle USDG) out of the account.

IP geolocation by [DB-IP](https://db-ip.com) (IP to Country Lite, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Sanctions data: the OFAC SDN list (US Treasury).

## Chain facts

Every address used here was checked against the live chain; `bun run verify:chain` re-checks them. Robinhood's
Chainlink Stock Token feeds price one token (the multiplier is already embedded).
