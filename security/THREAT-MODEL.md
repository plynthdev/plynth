# Threat model

What Plynth protects, who can act on it, what we trust each actor with, and where each defence is tested. Roles and
holders are in [SECURITY.md](../SECURITY.md); the invariants are in [INVARIANTS.md](INVARIANTS.md).

## Assets

| Asset | Where it sits | Worst case |
| --- | --- | --- |
| Savers' USDG | SavingsVault (available, pending), CrowdBuy books | Theft; frozen withdrawals |
| Stock Tokens bought for savers | CrowdBuy (until claimed), StealthClaims (Quiet), ShieldedPool notes (Hidden) | Theft; misdelivery; frozen claims |
| Hidden Vault notes | ShieldedPool (USDG, steakUSDG shares, Stock Tokens) | Double spend; forged withdraw; stuck proofs; privacy loss |
| Treasury funds | Each TreasuryAccount and its sleeves | A desk acting outside the board's policy; NAV misreported |
| Perp LP capital | PerpPool | Drained by trader profit, bad debt or a frozen exit |
| Privacy | Stealth deliveries, shielded notes, viewing keys | Linking a saver to their holdings |
| Operator wallets | Keeper, relayer, attester, controller, desk keys (one service each) | Gas drained; a bot key misused within its role |
| Service availability | API, keeper, relayer, indexer | Denial of service that stops deliveries or exits through the UI |

## Actors and what they can do

| Actor | Capabilities | Trust | Defence (tested in) |
| --- | --- | --- | --- |
| Saver | Deposit, set caps and mix, withdraw, cancel, claim, Hidden Vault transfer and withdraw | None | Per-user caps, exits never paused or eligibility-gated (`EligibilityGate.t.sol`, `ShieldedPool.t.sol`) |
| Stranger / attacker | Any public function, front-running, sybil accounts, donations, malformed keys and files, spam | None | Oracle-bound minimum output, MIN_CROWD, nullifiers, rate limits; DoS and griefing are in scope (the audit's M-1, M-5 to M-9) |
| Sybil group | Many funded accounts acting as one | None | MIN_CROWD counts accounts, not people: crowd timing must not depend on it (M-1 fix) |
| MEV searcher | Sandwich pooled swaps, front-run oracle updates | None | Keeper-only execution by default, jittered commit-reveal timing, slippage band from the oracle; public fallback and perp fills fixed for M-1 / M-3 |
| Keeper | Accrue round-ups within caps, pull chosen top-ups, commit timing, execute crowd buys, deliver allocations | Trusted for liveness and for Quiet stealth addresses; never custodial | Cannot move funds anywhere but the saver's own account, the crowd, StealthClaims or the shielded pool; a dead keeper must not block exits (`CrowdBuy.t.sol`, L-1 fix) |
| Relayer | Submits user-signed claims and proof-bound withdraws, earns the fee | Untrusted for funds | Recipient, fee, amount and deadline are bound into the signature or proof (`test_relayerCannotRedirectOrRaiseFee`, `test_realWithdrawBindsRecipientFeeAndAmount`) |
| Attester (eligibility service) | Signs eligibility attestations; revokes | Trusted for who may buy | Attestations bound to user, chain and registry, with an expiry; exits never check eligibility |
| Desk bots | `TreasuryAccount.execute` through allowed adapters | Untrusted beyond their policy | PolicyGuard re-values the account after every operation and reverts any breach; tickets bound to one operation (`TreasuryAccount.t.sol`, `PolicyGuard.t.sol`, treasury invariants) |
| Treasury controller | Signs closes and snapshots, posts receipts, holds the private sleeve's keys | Trusted by the board that names it | NAV, weights and positions recomputed on chain at close; private sleeve value proven |
| Board | Its treasury's policy (48 h timelock), desks, withdrawals, approvals | Trusted for its own treasury only | Cannot touch other treasuries; policy bounds validated on chain |
| Owner | Feeds, pools, markets, keepers, attester, caps, pause | Trusted (single EOA in the beta) | Live v1: timelocks on cap raises, park adapters and policies only. v2 (in review): 48 h public delay on feed, pool, keeper and fee changes; perps and period-close timelocks in progress. Instant setters only stop or reduce risk (SECURITY.md) |
| Operator infrastructure | Hosts the services and their keys | Trusted | Each service has its own key; the API holds none and returns unsigned transactions |
| External contracts | USDG, Stock Tokens (ERC-8056), Chainlink feeds, Uniswap v4 PoolManager, Permit2, ERC-5564/6538, steakUSDG | Trusted as deployed by their issuers | Addresses verified on chain and asserted after deploy (`verify:chain`, `verify:deployment`); staleness holds instead of reverting |
| Robinhood Chain sequencer | Orders and may delay transactions | Trusted for liveness | Timers are hours long; no sequencer-uptime check yet (audit lead) |

## Trust assumptions

1. The UltraHonk verifiers match the circuits: CI rebuilds them from `circuits/` with the pinned toolchain and fails on
   any difference; real proofs from the fixtures are verified in Foundry tests.
2. Chainlink equity feeds report the right price while the market is open; outside market hours the 26 h staleness
   window applies (accepted risk, SECURITY.md).
3. Stock Token issuers do not block the protocol's contracts; a delisted or halted token must still let users exit
   (audit M-2 / L-2 fixes).
4. The deployed bytecode is the reviewed source (`verify:explorer`: every runtime code equals the build of the commit
   that recorded the deployment).
5. OWNER's key is held safely; until it is a multisig, its compromise is the largest single risk (SECURITY.md).

## Attack surfaces and where they are covered

| Surface | Main threats | Coverage |
| --- | --- | --- |
| Crowd execution | Sandwich, stale price, sybil timing, dust and rounding | `CrowdBuy*.t.sol`, `CrowdBuy.invariant.t.sol`, mutation run |
| Hidden Vault | Double spend, forged proofs, wrong public-input order, root window exhaustion, malformed keys | `ShieldedPool*.t.sol`, `HiddenVerifiers.t.sol`, `circuits/*` Noir tests, `ShieldedPool.invariant.t.sol`, mutation run |
| Stealth claims | Redirected claims, replay | `StealthClaims.t.sol` (EIP-712 over every field) |
| Perps | Oracle front-running, bad debt, held markets freezing LPs, first-depositor inflation | `Perp*.t.sol`, `PerpInvariant.t.sol`, mutation run |
| Treasury | Desk outside policy, NAV manipulation by donation, ticket reuse, timelock bypass | `test/treasury/*`, real-sleeve and mock-sleeve invariants |
| Token (not deployed) | Fee capture, reward accounting, insurance claims | `PlinthStaking`, `FeeRouter`, `ExceptionInsurancePool` invariants |
| Services | Gas griefing through the keeper and relayer, parser DoS, API amplification, auth scope | `app/src/**` tests; rate limits; audit M-6 to M-9, L-12 to L-15 |
| Deployment | Wrong owner, role, timer, feed or pool; source mismatch | `verify:deployment`, `verify:explorer` (CI, daily) |

## Out of scope

Bugs in the external contracts above, the chain itself, wallets, and the user's own device; social engineering of
users; regulatory eligibility decisions beyond what the registry enforces.
