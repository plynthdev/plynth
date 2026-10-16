# Plynth Backend

Smart contracts, backend services and the web app for Plynth: savings that buy stock tokens, and policy-enforced treasuries, on Robinhood Chain (chain ID `4663`; testnet `46630`).

Consumer: savers top up USDG and add round-ups of their spending; the savings are pooled into Stock Token buys (Crowd Buy) and delivered openly, quietly to a stealth address (Quiet) or as shielded notes (Hidden Vault). Treasury: a board writes an investment policy, desk bots trade only inside it (every operation is checked against the policy on-chain and reverted on a breach), and each period ends with a NAV statement the chain recomputes from the holdings. No contract here has had an external audit.

## Layout

```
contracts/   Solidity contracts (Foundry)
circuits/    Noir circuits for the Hidden Vault and the private treasury sleeve (UltraHonk)
app/         Bun services: API, indexer, keeper, relayer, eligibility, MCP, treasury services, migrations
sdk/         @plynth/sdk: stealth delivery, crowd buys, shielded vault, statements, relayer client
web/         The site and dashboard (TanStack Start), deployed on Vercel; see Frontend (`web/`)
```

### Contracts (`contracts/src`)

Core (`core/`):

| Contract | What it does |
| --- | --- |
| `StockTokenRegistry` | Board-curated list of canonical Stock Tokens and their price feeds. Unknown tokens are refused |
| `Valuer` | Values Stock Tokens in USD from Chainlink feeds and each token's `uiMultiplier`. A stale feed returns `hold` instead of reverting |
| `StockRouter` | Buys and sells Stock Tokens for USDG through one Uniswap v4 pool per token, with the minimum output set by the oracle |
| `JitterBeacon` | Commit-reveal execution timing (the keeper commits to a secret before a window opens and reveals it at the time it sets; the commitment does not show the time) |
| `EligibilityRegistry` | On-chain record of the eligibility service's signed attestations. Exits never check it |

Consumer (`consumer/`):

| Contract | What it does |
| --- | --- |
| `SavingsVault` | Holds each saver's USDG and turns keeper-attested spends into round-ups, within the saver's caps |
| `CrowdBuy` | Pools many small USDG buys of one Stock Token into one swap, timed by the beacon, with a minimum crowd |
| `StealthClaims` | Holds Quiet deliveries for ERC-5564 stealth addresses until their owner signs a gasless claim |
| `ShieldedPool` | Hidden Vault: USDG and Stock Tokens held as Poseidon2 note commitments, moved with zero-knowledge proofs |
| `ShieldedTrade` | Private sell, buy, park and unpark of shielded notes |
| `ThresholdVerifier` | Checks "holds at least" and "saved at least" proofs against pool state without revealing the notes |
| `park/ERC4626Park`, `park/MorphoBluePark` | Park adapters: USDG in an allow-listed ERC-4626 vault or as a lender in one Morpho Blue market |
| `verifiers/*Verifier` | UltraHonk verifiers generated from `circuits/` (do not edit), `Poseidon2` and `HiddenConstants` |

Treasury (`treasury/`):

| Contract | What it does |
| --- | --- |
| `TreasuryFactory` | One call gives a board a treasury: clones of the policy, account, period close and approvals, wired to the shared guard |
| `TreasuryPolicy` | The board's policy as data. New versions wait a public timelock; every version is kept |
| `TreasuryAccount` | The treasury's wallet. Desks call `execute`; the account runs the operation, asks the guard, and reverts on a breach |
| `PolicyGuard` | Compares the account's state after each operation with the policy (bands, limits, loss bounds, venues) |
| `BoardApprovals` | Board sign-off tickets for large operations, consumed once for one exact operation |
| `PeriodClose` | Commits each period's statement and recomputes NAV, band weights and positions on-chain at commit |
| `Receipts` | Write-once hourly Merkle roots of every desk decision, including guard denials |
| `PositionMirror` | Controller-signed snapshots of positions held at off-chain perp venues |
| `PrivateSleeve` | A shielded equity sleeve whose value enters the period close through a proof |
| `TemplateRegistry` | Reviewed policy templates; the factory can build a treasury from a listed template |
| `sleeves/CashSleeve`, `sleeves/EquitySleeve` | Band adapters: USDG and allow-listed USDG vaults; Stock Token buys and sells through the router |
| `sleeves/PerpSleeve`, `sleeves/BasisSleeve` | Perp exposure for hedging and delta-neutral carry, behind one `IPerpVenue` per venue |
| `sleeves/InHousePerpVenue`, `sleeves/MirroredPerpVenue` | The in-house perp engine as a venue; an off-chain venue seen through `PositionMirror` |

Perps (`perps/`), token (`token/`), testnet (`testnet/`) and shared code:

| Contract | What it does |
| --- | --- |
| `PerpMarket` | One oracle-priced pool perp per Stock Token, isolated margin, USDG collateral |
| `PerpPool` | ERC-4626 LP vault over USDG that is the counterparty to every listed market |
| `PLTH` | Fixed-supply token, minted once in the constructor (no mint function, no owner) |
| `PlinthStaking` | Staking with rewards in USDG and PLTH and tiers by staked amount |
| `FeeRouter` | Receives platform fees in USDG and splits them, including a share for template authors |
| `ExceptionInsurancePool` | USDG pool that covers a treasury loss caused by a policy bug, never a market move |
| `MockUSDG`, `MockStockToken`, `MockFeed`, `TestnetPoolSeeder` | Testnet only: stand-ins for assets and feeds that exist only on mainnet |
| `libs/AssetValuation` | One valuation path for every treasury asset, shared by the guard and the sleeves |
| `interfaces/` | `IStockToken` (ERC-8056), ERC-5564/6538, Uniswap v4, Permit2, Chainlink, Morpho and the treasury interfaces |

No contract is upgradeable. OpenZeppelin v5.7.0 and forge-std v1.17.0 are vendored in `contracts/lib`.

### Deployment

Not deployed to mainnet. Deployed to Robinhood Chain testnet (`46630`) with mock assets (mock USDG, three mock Stock Tokens priced from the real mainnet feeds, a mock ERC-4626 USDG vault) and the chain's real Uniswap v4 PoolManager, Permit2 and ERC-5564/6538 contracts. Every testnet address is in [`app/deployments/46630.json`](app/deployments/46630.json) (and `46630-treasury.json`); explorer: <https://explorer.testnet.chain.robinhood.com>.

Timers are deploy-time values with a hard minimum in each contract (10 minutes; the CrowdBuy window at least 1 hour and longer than the beacon GRACE). Mainnet and fork scripts keep the full values (crowd window 1 day, beacon GRACE 1 hour, Hidden Vault cap and park-adapter delays and the treasury policy timelock 48 hours, unbonding 7 days, insurance withdrawals 14 days, LP redeem cooldown 24 hours); `TestnetStack.s.sol` uses a 2 hour window, a 15 minute GRACE and 15 minutes for the rest. Services read them from the contracts.

| Testnet contract | Address |
| --- | --- |
| `SavingsVault` | `0x8a66d61f70aEE77854F5b4595e015cdC72fbda76` |
| `CrowdBuy` | `0x685a849E8808F97fB30584DC80c48BA12eEa3c08` |
| `StealthClaims` | `0x84e12a37567D561dffb16cBEe6B8ce55f9Ae8b94` |
| `ShieldedPool` | `0x84cB78EB01D69082d93660f0341609a9553193Ff` |
| `TreasuryFactory` | `0x8169dda5181b9B5f5662Df1be7eEDA7114A76D03` |
| `PerpPool` | `0x4A43f6c890e9c253aD04d35302FC1cB251977d1b` |
| `PlinthStaking` | `0x1f6924f6c69AADD5D4E1d356c9bD52CF55CF9f2b` |
| `MockUSDG` (mUSDG, 6 dp) | `0x4B27310C5C93eA469802e045735E0A02Df5DE3B8` |

The deploy scripts in `contracts/script` write every address to `app/deployments/<chainId>.json`; see [Deployment file](#deployment-file).

### Services (`app/src`)

| Service | Entry | What it does |
| --- | --- | --- |
| API | `bin/api.ts` | Read API (Hono, tRPC at `/trpc`, REST mirror at `/v1`). Returns unsigned transactions and holds no keys |
| Indexer | `bin/indexer.ts` | The only process that polls the chain for logs. Writes events to Postgres |
| Keeper | `bin/keeper.ts` | Jobs that send transactions: `refresh-mock-feeds` (testnet kit only), `topups`, `roundups`, `spends`, `sweep`, `beacon`, `execute`, `deliver-quiet`, `deliver-hidden` |
| Relayer | `bin/relayer.ts` | Gasless Quiet claims and Hidden Vault withdraws from its own wallet, rate-limited |
| Eligibility | `bin/eligibility.ts` | Screens a wallet (signed self-attestation, IP country, sanctions list) and signs a registry attestation |
| MCP | `bin/mcp.ts` | Read-only treasury tools and exception requests over MCP (stdio or HTTP), per-treasury tokens |
| Migrate | `bin/migrate.ts` | Applies Drizzle migrations from `app/drizzle` |
| Treasury desks | `bin/treasury-desks.ts` | Rule-only cash and equity desks; exceptions go to a rule juror plus optional local models |
| Treasury close | `bin/treasury-close.ts` | Builds and commits each period's statement once it is due |
| Treasury risk | `bin/treasury-risk.ts` | Drawdown states, exposure and funding watch; pushes off-chain venue snapshots |
| Treasury receipts | `bin/treasury-receipts.ts` | Posts the hourly receipt roots of desk decisions |
| Treasury marks | `bin/treasury-marks.ts` | A NAV mark per treasury every minute |
| Treasury reconciler | `bin/treasury-reconciler.ts` | Venue statement vs on-chain mirror vs fill ledger; opens and resolves breaks |
| Treasury webhooks | `bin/treasury-webhooks.ts` | Signed webhooks for board-facing events (subscriptions CLI and delivery loop) |

Other folders: `abi/` (contract ABI subsets), `chain/` (chains, verified addresses, deployment loader), `db/` (schema), `api/routes/` (per-area procedures), `indexer/handlers/` (event streams), `keeper/jobs/` and `keeper/sources/` (round-up sources: on-chain spends, statement import, bank link), `treasury/` (desks, close, CFO pack, risk, jury, reconciler, receipts, valuer, venues, webhooks, token, policy compiler), `lib/`, `testing/` (test kits and fixtures). Operator scripts are in `app/scripts`; policy templates in `app/templates`.

IP geolocation by [DB-IP](https://db-ip.com) (IP to Country Lite, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Sanctions data: the OFAC SDN list.

## Requirements

- [Bun](https://bun.sh) 1.4+
- [Foundry](https://getfoundry.sh) (solc 0.8.28 is set in `foundry.toml`)
- Postgres 16
- For `circuits/` only: nargo 1.0.0-beta.25 and bb 5.2.0 (pinned in `circuits/VERSIONS`)

## Contracts

```sh
cd contracts
forge build
forge test
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test   # also runs the mainnet-fork tests
```

Testnet deploy of the whole stack in one script (`TestnetStack.s.sol` refuses every chain but 46630). `app/scripts/testnet/setup.ts` runs it after a gas estimate (forge simulation plus the Orbit L1 data fee) and then funds the service wallets; see [Testnet stack](#testnet-stack):

```sh
cd contracts
TESTNET_KEEPER=<keeper> TESTNET_ATTESTER=<attester> TESTNET_COMMITTEE=<committee> \
  forge script script/TestnetStack.s.sol:TestnetStack --keystore <keystore> --password-file <file> --sender <address> \
  --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --slow
```

`TestnetKit.s.sol` + `TestnetConsumer.s.sol` (+ `TestnetPerpKit`, `TestnetTokenKit`, `TreasuryFactory`) deploy the same pieces separately.

## Services

```sh
cd app
bun install          # also installs ../sdk
bun run db:create
bun run migrate
bun run indexer
bun run keeper
bun run api
```

The other services start the same way (`bun run relayer`, `bun run eligibility`, `bun run mcp`, `bun run treasury-desks`, …). Every long-running service listens on its own port with a health check (`GET /health`; the API's is `GET /v1/meta/health`). `--once` runs one pass and exits (indexer, keeper, the treasury loops and `treasury-webhooks run`; `RISK_ONCE=1` for the risk service).

### Configuration

All config comes from environment variables and is checked at startup (`app/src/config.ts`); `app/.env.example` lists every variable once. Blank means unset.

| Variable | Default | Notes |
| --- | --- | --- |
| **shared** | | |
| `DATABASE_URL` | `postgres://localhost:5432/plynth_dev` | Postgres. `bun run db:create && bun run migrate` sets it up. |
| `RHC_MAINNET_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Public RPC (rate-limited). A free Alchemy URL works too |
| `RHC_TESTNET_RPC_URL` | `https://rpc.testnet.chain.robinhood.com` | Testnet RPC |
| `LOCAL_RPC_URL` | `http://127.0.0.1:8545` | RPC when a service's chain is `local` (anvil) |
| `LOG_LEVEL` | `info` | debug \| info \| warn \| error \| silent |
| **indexer (bin/indexer.ts)** | | |
| `INDEXER_CHAIN` | `local` | local \| testnet \| mainnet. The only process that polls the chain for logs. |
| `INDEXER_PORT` | `8787` |  |
| `INDEXER_POLL_MS` | `2000` |  |
| `INDEXER_CONFIRMATIONS` | – | Default 12 (0 on local). |
| `INDEXER_DEPLOYMENTS_DIR` | `app/deployments` | |
| `INDEXER_FROM_BLOCK` | – |  |
| `INDEXER_WALLETS` | – | Comma-separated linked spending wallets to index from the start. |
| `INDEXER_STREAMS_FILE` | – | Optional JSON file of extra streams. |
| **keeper (bin/keeper.ts)** | | |
| `KEEPER_CHAIN` | `local` | One keeper per database, chain and deployment: it takes a Postgres session advisory lock before any job (also with `--once`); a second keeper exits with status 75. The lock is released when the process exits or crashes. |
| `KEEPER_PORT` | `8788` |  |
| `KEEPER_INTERVAL_MS` | `30000` |  |
| `KEEPER_DEPLOYMENTS_DIR` | `app/deployments` |  |
| `KEEPER_SECRET_KEY` | – | 32 bytes (0x-hex or base64) that seal beacon secrets and bank-link tokens at rest (`openssl rand -hex 32`) |
| `KEEPER_PRIVATE_KEY` | – | Signing key: KEEPER_PRIVATE_KEY, or a keystore file + a file holding its password. |
| `KEEPER_KEYSTORE` | – |  |
| `KEEPER_KEYSTORE_PASSWORD_FILE` | – |  |
| `KEEPER_LOOKAHEAD` | `2` | Beacon windows committed ahead. |
| `KEEPER_CONFIRMATIONS` | – | Quiet delivery proofs (receipts, Delivered/Claimed/Credited logs, the keeper's nonce) are read this many blocks below the head, so a reorg can never release or stop a part. Default 2 (0 on local). |
| `KEEPER_JOBS` | – | Comma-separated subset of refresh-mock-feeds,fee-push,topups,roundups,sweep,beacon,execute,deliver-quiet,deliver-hidden,spends (blank = all; this is the pass order: statement/Plaid `spends` run last). |
| `KEEPER_MAX_ACCRUALS_PER_PASS` | `200` | Accrue transactions per job per pass. A spend the vault would credit 0 for (no settings, nothing available, weekly cap used, a whole amount) is skipped without a transaction. |
| `KEEPER_MAX_ACCRUALS_PER_USER_WEEK` | `100` | Accrue transactions per user in any 7 days; further spends that week are skipped. |
| `SPLIT_PARTS` | `2` | Quiet delivery: parts per allocation (1-3), released across consecutive crowd executions. |
| `KEEPER_MOCK_FEED_INTERVAL_S` | `600` | `refresh-mock-feeds` (deployment files with `mockFeeds: true`): a mock feed older than this is re-posted from the real mainnet Chainlink feed of the same stock, read over `RHC_MAINNET_RPC_URL`. The keeper must own the feeds. |
| `KEEPER_MOCK_FEED_KEEP_ALIVE` | `1` | 1 = when the real feed is stale (market closed), post its last answer anyway, so testnet keeps trading. 0 = the testnet market holds, as mainnet does. |
| `KEEPER_MOCK_FEED_REAL_STALE_S` | `86400` | Age (s) after which a real feed counts as stale. |
| `KEEPER_MOCK_FEED_ALIGN_BPS` | `50` | Swap the testnet kit's v4 pool back to the oracle price when it is further off than this (bps; 0 = never). |
| **relayer (bin/relayer.ts)** | | |
| `RELAYER_CHAIN` | `local` | Gasless Quiet claims and Hidden Vault withdraws. Its wallet pays gas. |
| `RELAYER_PORT` | `8791` |  |
| `RELAYER_DEPLOYMENTS_DIR` | `app/deployments` |  |
| `RELAYER_PRIVATE_KEY` | – |  |
| `RELAYER_KEYSTORE` | – |  |
| `RELAYER_KEYSTORE_PASSWORD_FILE` | – |  |
| `RELAYER_TRUST_PROXY` | `0` | 1 = rate-limit by X-Forwarded-For (only behind your own reverse proxy). IPv6 clients are limited per /64. |
| `RELAYER_IP_LIMIT` | `20` |  |
| `RELAYER_STEALTH_LIMIT` | `3` |  |
| `RELAYER_WITHDRAW_MIN_FEES` | – | Minimum withdraw fee per asset, "0xasset:raw,0xasset:raw" in raw token units. Required on mainnet; an unlisted asset is not relayed; amount 0 and fee 0 are always refused. Blank on local/testnet = 0.25 USDG and 0.001 of each Stock Token of the deployment. |
| **api (bin/api.ts)** | | |
| `API_CHAIN` | `local` | Read-only dashboard API; holds no keys (except the optional eligibility attester below). |
| `API_PORT` | `8789` |  |
| `API_DEPLOYMENTS_DIR` | `app/deployments` |  |
| `CORS_ORIGINS` | – | Comma-separated exact origins. Blank = the hosted frontend and http://localhost:5173. |
| `ROUNDUPS_ENABLED` | `0` | Round-up sources beyond on-chain spends (statement import, bank link). `1` mounts `/v1/roundups/*`. The bank link also needs `KEEPER_SECRET_KEY` (tokens are stored sealed with it, so the API and the keeper share it) |
| `ROUNDUPS_MAX_ROWS_PER_WEEK` | `2000` | New statement rows one user may import in any 7 days (re-imports of known rows do not count); over it the import answers 429. |
| `PLAID_ENV` | `sandbox` | sandbox (free) \| production |
| `PLAID_CLIENT_ID` | – |  |
| `PLAID_SECRET` | – |  |
| `PLAID_COUNTRY_CODES` | `US` | Countries offered in the bank-link flow (comma-separated ISO codes) |
| **eligibility (bin/eligibility.ts; also mounted by the API)** | | |
| `ELIGIBILITY_CHAIN` | `local` |  |
| `ELIGIBILITY_PORT` | `8790` |  |
| `ELIGIBILITY_REGISTRY` | – | EligibilityRegistry address. Set = screening enabled (needs the attester key). |
| `ELIGIBILITY_ATTESTER_KEY` | – |  |
| `ELIGIBILITY_KEYSTORE` | – |  |
| `ELIGIBILITY_KEYSTORE_PASSWORD_FILE` | – |  |
| `ELIGIBILITY_IP_DB` | `data/dbip-country-lite.mmdb` | MMDB country database (`bun run download-ip-db`) and the cached OFAC address list. |
| `ELIGIBILITY_SANCTIONS_CACHE` | `data/ofac-sdn-addresses.json` |  |
| `ELIGIBILITY_SANCTIONS_ORACLE` | – | Optional isSanctioned(address) oracle. |
| `ELIGIBILITY_TRUST_PROXY` | `0` | 1 = trust CF-IPCountry / CF-Connecting-IP / X-Forwarded-For (only behind Cloudflare or your own proxy). |
| `ELIGIBILITY_ALLOW_UNKNOWN_IP` | `0` | 1 = let IPs with no known country through (local development only). |
| `ELIGIBILITY_IP_LIMIT` | `10` |  |
| `ELIGIBILITY_ADDRESS_LIMIT` | `5` |  |
| **mcp (bin/mcp.ts; token issuance in the API)** | | |
| `MCP_PORT` | `8792` |  |
| `MCP_TOKEN_SECRET` | – | HMAC key for per-treasury MCP tokens, >= 32 characters, the same for the API and the MCP server. Blank = off. |
| `PLINTH_MCP_TOKEN` | – | The token a local agent uses with `bun run mcp --stdio`. |
| `RPC_URL` | – | RPC for the MCP server (falls back to TREASURY_RPC_URL). |
| `DEPLOYMENT_JSON` | – | Optional deployment JSON (default app/deployments/<chainid>.json + <chainid>-treasury.json). |
| **treasury (shared by the treasury services)** | | |
| `TREASURY_RPC_URL` | – |  |
| `TREASURY_CHAIN_ID` | – | Webhooks CLI only: skips reading the chain id from TREASURY_RPC_URL. |
| `TREASURY_POLL_MS` | – | Receipt polling for sent transactions (default 100 ms on anvil, 2000 ms elsewhere). |
| `TREASURY_ACCOUNT` | – | The treasury the risk service watches. |
| `TREASURY_ACCOUNTS` | – | Treasuries to mark / post receipts for: a comma-separated list and/or every treasury a factory created. |
| `TREASURY_FACTORY` | – |  |
| `TREASURY_CONTROLLER_KEY` | – | The policy controller (close, receipts, mirror snapshots): a key, or a keystore + password or password file. |
| `TREASURY_CONTROLLER_KEYSTORE` | – |  |
| `TREASURY_CONTROLLER_KEYSTORE_PASSWORD` | – |  |
| `TREASURY_CONTROLLER_KEYSTORE_PASSWORD_FILE` | – |  |
| **treasury-desks (bin/treasury-desks.ts)** | | |
| `TREASURY_DESKS_PORT` | `8793` |  |
| `TREASURY_CONFIG` | – | Desk config JSON (contracts, policy template, desk settings). |
| `TREASURY_DESK_INTERVAL_S` | `300` |  |
| `TREASURY_CASH_DESK_KEY` | – |  |
| `TREASURY_CASH_DESK_KEYSTORE` | – |  |
| `TREASURY_CASH_DESK_KEYSTORE_PASSWORD` | – |  |
| `TREASURY_CASH_DESK_KEYSTORE_PASSWORD_FILE` | – |  |
| `TREASURY_EQUITY_DESK_KEY` | – |  |
| `TREASURY_EQUITY_DESK_KEYSTORE` | – |  |
| `TREASURY_EQUITY_DESK_KEYSTORE_PASSWORD` | – |  |
| `TREASURY_EQUITY_DESK_KEYSTORE_PASSWORD_FILE` | – |  |
| `TREASURY_JURY` | `on` | Exception jury: on \| off. Model jurors run on a local Ollama when it answers; the rule juror always runs. |
| `OLLAMA_HOST` | – |  |
| `TREASURY_JURY_MODELS` | – | Comma-separated Ollama models (blank = the built-in defaults). |
| `TREASURY_JURY_TIMEOUT_MS` | – |  |
| **treasury-close (bin/treasury-close.ts)** | | |
| `TREASURY_CLOSE_PORT` | `8794` |  |
| `TREASURY_PERIOD_CLOSE` | – | PeriodClose address. |
| `TREASURY_CLOSE_INTERVAL_S` | `600` |  |
| `TREASURY_CLOSE_SKIP_RECONCILE` | `0` | 1 = do not wait for the reconciler (a treasury with no perp venues). |
| **treasury-risk (bin/treasury-risk.ts)** | | |
| `TREASURY_RISK_PORT` | `8795` |  |
| `TREASURY_POSITION_MIRROR` | – | PositionMirror address (needed to push off-chain venue snapshots). |
| `RISK_STATIC_READERS` | – | Optional JSON file: [{ venue, positions: [{ underlying, tokens }], equityUsd, flowInSeen }] |
| `RISK_WEBHOOK_URLS` | – | Comma-separated URLs for drawdown.state / risk.alert, signed with RISK_WEBHOOK_SECRET. |
| `RISK_WEBHOOK_SECRET` | – |  |
| `RISK_INTERVAL_SEC` | `30` |  |
| `RISK_HYSTERESIS_BPS` | `50` |  |
| `RISK_ONCE` | `0` | 1 = one tick, print the report, exit. |
| **treasury-receipts (bin/treasury-receipts.ts)** | | |
| `TREASURY_RECEIPTS_PORT` | `8796` |  |
| `TREASURY_RECEIPTS` | – | Receipts address. |
| `TREASURY_RECEIPTS_INTERVAL_S` | `300` |  |
| `TREASURY_RECEIPTS_GRACE_S` | `300` | Seconds after an hour ends before it is closed. |
| **treasury-marks (bin/treasury-marks.ts)** | | |
| `TREASURY_MARKS_PORT` | `8797` |  |
| `TREASURY_MARK_INTERVAL_S` | `60` |  |
| **treasury-reconciler (bin/treasury-reconciler.ts)** | | |
| `TREASURY_RECONCILER_PORT` | `8798` |  |
| `TREASURY_RECONCILE_CONFIG` | – | Reconciler config JSON (account, mirror, venues). |
| `TREASURY_RECONCILE_INTERVAL_S` | `3600` |  |
| `ORDERLY_SECRET` | – | Trade-only venue API secret; never logged. |
| `TREASURY_WEBHOOK_URLS` | – | Comma-separated URLs for reconciliation breaks, signed with TREASURY_WEBHOOK_SECRET. |
| `TREASURY_WEBHOOK_SECRET` | – |  |
| **treasury-webhooks (bin/treasury-webhooks.ts)** | | |
| `TREASURY_WEBHOOKS_PORT` | `8799` |  |
| `TREASURY_WEBHOOK_INTERVAL_S` | `15` |  |

Never commit `.env` files or keys; they are ignored by `.gitignore`. Prefer Foundry keystores (`cast wallet import <name> --interactive`) to raw `*_KEY` values.

### Deployment file

The services read contract addresses from `app/deployments/<chainId>.json`, written by `contracts/script/TestnetKit.s.sol` and `TestnetConsumer.s.sol` (every core and consumer address, the stock tokens, the v4 pool ids, `deployBlock`, and `mockFeeds: true` when the feeds are the kit's MockFeeds; `TESTNET_KIT_FILE` writes the kit under another name in the same folder). `TestnetPerpKit.s.sol` and `TestnetTokenKit.s.sol` add `<chainId>-perps.json` and `<chainId>-token.json` next to it, and `TreasuryFactory.s.sol` adds `<chainId>-treasury.json`, which the API and the MCP server merge in. Each service takes its own directory (`*_DEPLOYMENTS_DIR`); the schemas are in `app/src/chain/deployment.ts`, `app/src/keeper/context.ts` and `app/src/indexer/handlers/streams.ts`. The folder is gitignored (local and fork runs write the same chain ids) except the testnet files `46630.json` and `46630-treasury.json`, written by `TestnetStack.s.sol` and `app/scripts/testnet/setup.ts`.

## Frontend (`web/`)

The site and the dashboard. The dashboard reads the API, runs every transaction as an `eth_call` before the wallet sees it (a revert is decoded and shown, nothing is sent), and builds the Hidden Vault proofs in the browser with `@plynth/sdk`.

| | |
| --- | --- |
| Stack | TanStack Start (React 19, Vite 8, Tailwind 4) with Nitro server output, wagmi core + viem, `@plynth/sdk` (`file:../sdk`) |
| Install | `bun install --cwd sdk && bun run --cwd sdk build`, then `cd web && bun install` (the SDK is consumed from its `dist/`) |
| Dev | `bun run dev` (fork), `bun run dev:testnet`, `bun run dev:mainnet` |
| Test | `bun run test` (vitest). `bunx playwright test e2e-local` clicks through a running fork and testnet stack |
| Build | `bun run build` (Cloudflare output by default, `NITRO_PRESET=vercel` for Vercel) |

| Profile | Command | Env file | Chain | Deployment file |
| --- | --- | --- | --- | --- |
| Fork | `bun run dev` | `.env.local` | 31337 | `app/deployments/fork.json` (from `app/scripts/fork/up.sh`) |
| Testnet | `bun run dev:testnet` | `.env.testnet.local` | 46630 | `app/deployments/46630.json` |
| Mainnet | `bun run dev:mainnet` | `.env.mainnet.local` | 4663 | `app/deployments/4663.json`, else the raw `4663-beta.json` |
| Production | `bun run build` | the host's environment | `VITE_CHAIN_ID` | the chain's file, inlined into the bundle at build time |

`vite dev` proxies the API and the relayer under `/__fork/` (no CORS) and reads the deployment file on every request. A build inlines the file instead; when there is none (mainnet before the beta deploy) the build still succeeds and the dashboard says "not deployed yet" instead of offering to connect a wallet. A file for another chain, or a fork-mode run on 4663, is refused. `web/.env.example` lists every variable.

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_CHAIN_ID` | `31337` | 4663 mainnet, 46630 testnet. A production build without it shows the preview dashboard |
| `VITE_RPC_URL` | per chain | `https://rpc.mainnet.chain.robinhood.com`, `https://rpc.testnet.chain.robinhood.com`, fork `http://127.0.0.1:8545` |
| `VITE_API_URL` | `http://127.0.0.1:8789` | A build calls it directly: the API's `CORS_ORIGINS` must list the site's origin |
| `VITE_RELAYER_URL` | `http://127.0.0.1:8791` | Gasless Quiet claims and Hidden withdraws; a build calls it directly |
| `VITE_DEV_WALLET` | `0` | `1` offers a wallet signing with anvil's public dev key, only on a localhost page of chain 31337. A build for any other chain with `1` fails. Always `0` in production |
| `VITE_EXPLORER_URL` | per chain | `https://robinhoodchain.blockscout.com` on mainnet; transaction hashes link to it |
| `VITE_CHAIN_NAME` | per chain | Network name shown to the wallet |
| `VITE_FORK` | – | `0` shows the preview dashboard |
| `FORK_DEPLOYMENT_JSON` | per chain | Build and dev server only: path of the deployment file |
| `NITRO_PRESET` | `cloudflare` | `vercel` on Vercel (`web/vercel.json` sets it in the build command) |

| Vercel setting | Value |
| --- | --- |
| Root Directory | `web` |
| Framework Preset | Other (`web/vercel.json` sets `framework: null`; the build writes `.vercel/output`) |
| Include files outside the root directory | On: the install builds `../sdk` and the build reads `../app/deployments` |
| Install and build commands | From `web/vercel.json`: build `sdk/`, `bun install`, then `NITRO_PRESET=vercel bun run build` |
| Ignored Build Step | `web/vercel.json` `ignoreCommand`: no deploy when nothing under `web/`, `sdk/`, `app/deployments/` or `app/src/chain/` changed |
| Production environment | `VITE_CHAIN_ID=4663`, `VITE_RPC_URL=https://rpc.mainnet.chain.robinhood.com`, `VITE_API_URL`, `VITE_RELAYER_URL`, `VITE_DEV_WALLET=0`, `NITRO_PRESET=vercel` |

`app/deployments/4663*.json` is gitignored, so a Vercel build shows "not deployed yet" until the mainnet file is committed (as `46630.json` is) or the build is given `FORK_DEPLOYMENT_JSON`.

## API

Procedures are served by tRPC at `/trpc` and mirrored as REST under `/v1` with the same input names. The API holds no keys: every `tx` route returns an unsigned transaction (`{ to, data, value, chainId }`) for the user's own wallet or the board's Safe.

| Route | |
| --- | --- |
| `GET /v1/meta/health` | Service, chain and indexer status (503 when degraded) |
| `GET /v1/meta/eligibility` | Eligibility requirements for buying |
| `GET /v1/account/{address}/overview` | Balances, mix, books and deliveries for a saver |
| `GET /v1/account/{address}/habit`, `/activity`, `/settings` | Saving habit, activity history and settings |
| `POST /v1/tx/deposit`, `/withdraw`, `/approveUsdg`, `/setMix`, `/setSettings`, `/claimOpen` | Unsigned saver transactions |
| `GET /v1/crowd/books` | Open Crowd Buy books |
| `GET /v1/statements/{address}`, `POST /v1/statements/verify` | Viewing-key statements: which exist, and verification of a disclosed one |
| `GET /v1/proofs/nonce`, `POST /v1/proofs/verify` | Threshold proofs ("holds at least", "saved at least") |
| `POST /v1/eligibility/check` | Eligibility screen (when `ELIGIBILITY_REGISTRY` is set) |
| `/v1/roundups/*` | Statement import and bank link for round-ups (when `ROUNDUPS_ENABLED=1`) |
| `GET /v1/treasury/templates`, `/v1/treasury/marketplace` | Policy templates and listed marketplace templates |
| `POST /v1/treasury/create` | Unsigned factory transaction for a new treasury |
| `GET /v1/treasury/{account}/policy`, `POST /policy/diff`, `POST /policy/propose` | Current policy, a diff against a proposal, the unsigned proposal |
| `GET /v1/treasury/{account}/desks`, `/positions`, `/actions`, `/exceptions` | Desks, positions, desk decisions and open exceptions |
| `GET /v1/treasury/{account}/nav`, `/nav/history` | Latest NAV and the per-minute marks |
| `GET /v1/treasury/{account}/closes`, `/closes/{index}` | Period statements |
| `GET /v1/treasury/{account}/cfo-pack/{periodEnd}` (+ `/download`) | The verified statement as JSON, CSV and HTML |
| `GET /v1/treasury/{account}/receipts/{hour}`, `/actions/{actionId}/proof` | Hourly receipt roots and an inclusion proof for one decision |
| `GET`, `POST /v1/treasury/{account}/mcp-tokens`, `POST /mcp-tokens/{id}/revoke` | Board-issued MCP tokens |

## Checks

```sh
cd app
bun run typecheck
bun test
bun run smoke [API_URL]       # hits every route and checks the response shape (default http://127.0.0.1:8789)
bun run e2e consumer          # testnet fork: deploy, every service, three savers through Open, Quiet and Hidden
bun run e2e treasury          # mainnet fork: factory treasury, desks over a simulated week, period close, CFO pack

cd ../sdk && bun install && bun run build && bun test
cd ../circuits && bun install --no-save && bun test && for c in */Nargo.toml; do (cd "${c%/*}" && nargo test); done
cd ../web && bun install && bun run test && bun run build   # after the sdk build above
cd .. && .githooks/public-guard.sh   # also the pre-commit hook (`bun install` in app/ sets core.hooksPath)
```

The end-to-end runs use local anvil forks only (nothing is broadcast) and a throwaway `plynth_e2e_*` database.

### Testnet stack

```sh
cd app
bash scripts/testnet/up.sh                      # chain id must be 46630; deploys + funds once, then starts every service
bun run scripts/testnet/exercise.ts             # every transaction that does not wait on real time, through the services
bun run scripts/testnet/exercise.ts --resume    # the time-bound steps that are due (crowd window, 48h timelocks, unbonding)
bun run scripts/testnet/exercise.ts --report-only
bash scripts/testnet/down.sh                    # stops the services
```

Sends real testnet transactions from Foundry keystores (`~/.foundry/keystores/plynth-*`, password files in `~/.plynth-testnet`). Every send first checks that the RPC answers chain id 46630 and refuses anything else (mainnet 4663 by name). State, logs and reports go to `app/.testnet/` (gitignored); the database is `plynth_testnet`. Tester wallets to fund (MetaMask accounts) come from `TESTNET_TESTERS` or `~/.plynth-testnet/testers`.

### Persistent mainnet fork

```sh
cd app
bash scripts/fork/up.sh              # anvil fork of mainnet (chain id 31337), whole stack deployed, services running
bun run scripts/fork/exercise.ts     # every transaction the stack supports, report in app/.fork/reports/
bash scripts/fork/down.sh            # stop (state kept in app/.fork/state.json); reset.sh wipes it
```

`contracts/script/ForkMainnet.s.sol` deploys against the real mainnet USDG, Stock Tokens, Chainlink feeds, v4
pools and steakUSDG (Valuer staleness 7 days on the fork only). The fork runs as chain id 31337 so nothing signed
on it can be replayed on mainnet. A caching proxy (`scripts/fork/rpc-cache.ts`) sits between anvil and the public
RPC, which keeps only recent state. RPC on 127.0.0.1:8545, API on :8789; import only anvil's public dev accounts.
`FORK_STACK=beta` deploys `MainnetBeta.s.sol` (below) in its fork mode instead, with dev accounts as the placeholder
owner and bots (`FORK_BETA_DEPLOYER` = an address to act as by impersonation, `FORK_BETA_TOKEN=false` = no token);
the exercise then also runs its `beta` area (owner hand-over, no caps, pause and cap-lowering levers).

### Mainnet (closed beta)

`contracts/script/MainnetBeta.s.sol` deploys the stack against the real mainnet contracts with mainnet timers (24 h
crowd window, 1 h beacon grace, 48 h timelocks, 7 d unbonding, 14 d insurance delay, 24 h LP cooldown). It refuses
every chain but 4663 (fork mode: 31337 only), needs `OWNER` and the bot addresses (`KEEPER`, `ATTESTER`, `RELAYER`,
`CONTROLLER`, `CASH_DESK`, `EQUITY_DESK`; all distinct, none the deployer), hands every admin role to `OWNER` (two-step
contracts wait for `acceptOwnership()` from `OWNER`; the list is in the output file) and checks the hand-over before
anything is broadcast. No caps: Hidden Vault caps are proposed at the maximum (they apply after the 48 h timelock),
perp open-interest caps at 100%; the owner keeps `setDepositsPaused` and immediate cap-lowering. The token (PLTH,
staking, FeeRouter, insurance) only with `DEPLOY_TOKEN=true`.

```sh
cd contracts
OWNER=<owner> KEEPER=<keeper> ATTESTER=<attester> RELAYER=<relayer> CONTROLLER=<controller> \
CASH_DESK=<cash desk> EQUITY_DESK=<equity desk> \
  forge script script/MainnetBeta.s.sol:MainnetBeta --account <keystore> --password-file <file> --sender <deployer> \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --gas-estimate-multiplier 200 --broadcast --slow
cd ../app
bun scripts/mainnet/dryrun.ts --addresses <public addresses.json>   # same deploy on a fresh local fork + its cost
bash scripts/mainnet/up.sh     # chain id must be 4663; never deploys or funds; refuses until OWNER accepted everything
bash scripts/mainnet/down.sh
```

## License

[MIT](LICENSE)
