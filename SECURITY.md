# Security

Plynth holds user funds on Robinhood Chain. This file lists how to report a vulnerability, every privileged role
and who holds it, what each role can do and how fast, the risks we accept, and the review history. Related:
[threat model](security/THREAT-MODEL.md), [invariants](security/INVARIANTS.md),
[incident runbook](security/INCIDENT-RUNBOOK.md), [audit history](security/AUDITS.md).

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting on this repository (**Security** tab, **Report a vulnerability**).
  Do not open a public issue, pull request or discussion for a security problem.
- Include the affected contract or service, the commit, a proof of concept (a Foundry test is ideal) and the impact.
- We acknowledge within 72 hours, give a first assessment within 7 days, and agree a disclosure date with you
  (normally after a fix is deployed, at most 90 days).
- Good-faith research is welcome: test on a local fork (`anvil --fork-url https://rpc.mainnet.chain.robinhood.com`)
  or on testnet, never against other users' funds on mainnet, and do not degrade the public services.
- There is no paid bug bounty at the moment.

## Scope and status

| Area | Where | Status |
| --- | --- | --- |
| Contracts | `contracts/src` (not `src/testnet`, which is testnet-only) | Mainnet closed beta since block 88,470,046, deployed **without** the token contracts (PLTH, staking, FeeRouter, insurance pool). Addresses: [`app/deployments/4663.json`](app/deployments/4663.json). |
| Circuits and verifiers | `circuits/`, `contracts/src/consumer/verifiers` (generated) | Same deployment |
| Services | `app/src` (API, indexer, keeper, relayer, eligibility, MCP, treasury services) | Running for the beta |
| SDK | `sdk/` | Not published to npm |
| Web | `web/` | Out of scope for contract findings; report anything that leaks keys or signs unexpected transactions |

No contract is upgradeable: a fix ships as a redeploy. The live bytecode is proven equal to the source at the commit
that recorded the deployment (`cd app && bun run verify:explorer`: 45 of 45 runtime codes match, immutables and
library addresses masked), and the live configuration is asserted by `bun run verify:deployment`. Both run daily in
CI. An external AI audit graded the deployed version 3.7/10 with nine Medium findings; they are listed under
[Known issues](#known-issues-in-the-deployed-version) and fixed in the next version. No human audit has been done.

## Roles and holders (mainnet 4663)

All addresses are public and also in [`app/deployments/4663.json`](app/deployments/4663.json).

| Role | Address | Kind | Holds |
| --- | --- | --- | --- |
| OWNER | `0x633601fbBd708EA6B69ba3237c6BfC1502ae602f` | EOA (no code) | Owner of every ownable contract; TemplateRegistry committee; platform close-fee recipient (no token deployed) |
| KEEPER | `0xe022a3C569785D3a7705d0420FfC0F6b211398B1` | EOA, keeper service | `keeper` on JitterBeacon, SavingsVault, CrowdBuy |
| ATTESTER | `0x1C712D7203823ABcc97d356A1fDEf3f4EBBb3E59` | EOA, eligibility service | `attester` on EligibilityRegistry |
| RELAYER | `0x6862ed283418E31DfE7fbA3DFA1F223C1210b91D` | EOA, relayer service | No on-chain role. Submits signature- or proof-bound claims and withdraws and earns the relayer fee |
| CONTROLLER | `0xfbA72736D89a9aE137247146E65b3AAE00Dc8B78` | EOA, treasury services | Named in a treasury's policy by its board: signs period closes and position snapshots, posts receipts, sets private-sleeve keys |
| CASH_DESK, EQUITY_DESK | `0xC008c8fAb7563Fd21Fc107450a262b1a7D1F7f98`, `0x7F7bBFD83747716573ac4513BD10c6279B3ca80E` | EOAs, desk bots | Desk keys a board registers; can only call `TreasuryAccount.execute` inside the policy |
| Deployer | `0x30C7BA93709807eC21b6aFfc4d73659F58238Caa` | EOA | Nothing. `verify:deployment` asserts every owner is OWNER and every `pendingOwner` is zero |
| Board (per treasury) | the board's own address (a Safe is recommended) | | Its treasury only: policy proposals, desks, withdrawals, approvals |

The deploy script refuses duplicate role addresses and an OWNER equal to the deployer, and checks the hand-over before
broadcasting (`contracts/script/MainnetBeta.s.sol`, `checkConfig` and `checkHandoff`).

## What each role can do

This section describes the v2 contracts: the audit fixes, written and in review, **not deployed and not final**. The
perps and treasury parts are still being changed, so their rows may change before the deploy. The live beta ("v1",
block 88,470,046) predates the delays below: there every owner setter is instant; see
[Differences in the live v1 deployment](#differences-in-the-live-v1-deployment).

**Change delay.** Owner setters that could hurt users go through a public 48 h queue (`contracts/src/libs/ChangeDelay.sol`,
`CHANGE_DELAY = 48 hours`): the first call with given arguments only queues it and emits `ChangeQueued(id, data, eta)`;
the identical call after the eta applies it (`ChangeApplied`); `cancelChange(id)` drops it. Only the owner can apply.
Perps use the same pattern with `PerpPool.TIMELOCK` (48 h), treasuries with the policy `TIMELOCK` (48 h). Setters that
stay instant are listed with the reason: each only stops or reduces something, or is a one-time deploy wiring.

| Contract | Caller | Function | Effect | Delay (mainnet) |
| --- | --- | --- | --- | --- |
| StockTokenRegistry | OWNER | `list(token, feed, embedded)` | First listing of a token | Instant (deploy wiring) |
| | OWNER | `list` on a listed or delisted token | Re-points a feed, changes the flag or re-lists | 48 h change delay |
| | OWNER | `delist(token)` | Stops new buys, crowd execution and new perp opens; exits never need a listed token | Instant: only stops new risk |
| StockRouter | OWNER | `setPool(token, key)` | First pool for a token / replacing a pool (the oracle minimum output bounds every trade) | First: instant; replace: 48 h |
| Valuer | OWNER | `closeDays(days)` | Marks market holidays: prices hold (crowd execution, perp opens, LP entry and exit, period closes wait) | Instant: holds only |
| | OWNER | `reopenDay(day)` | Reopens a closed day | Only for a day at least 48 h ahead (`HOLIDAY_NOTICE`) |
| | OWNER | `enableMarketCalendar`, `setSequencerFeed` | Turns on the market-hours hold (one-way); sets the L2 sequencer feed (once) | Instant, one-way / once |
| JitterBeacon | OWNER | `setKeeper(k)` | Rotates the keeper (zero refused) | 48 h change delay |
| | KEEPER | `commit` | Commits a window's secret execution time | Before the window |
| EligibilityRegistry | OWNER | `setAttester` | Rotates the attester; records already on chain stay | Instant: only gates new buys, never exits |
| | ATTESTER | `revoke(user)` | Stops a user's new buys | Instant |
| SavingsVault | OWNER | `setKeeper(k)` | Rotates the keeper / `k = 0` stops round-ups and top-ups | Nonzero: 48 h; zero: instant (withdraw never needs the keeper) |
| | OWNER | `setCrowd`, `setEligibility` | Wiring | Once (deploy) |
| | KEEPER | `accrue`, `pullFixedTopUp` | Moves a saver's own balance to pending within the weekly cap (max 500 USDG); pulls the top-up the saver chose, at most once per 7 days | Instant |
| CrowdBuy | OWNER | `setKeeper(k)` | Rotates the keeper / `k = 0` leaves books to the public fallback | Nonzero: 48 h; zero: instant |
| | OWNER | `setStealthClaims`, `setShieldedPool` | Wiring | Once (deploy) |
| | KEEPER | `execute` (from the beacon time), `joinBatch`, `deliver`, `deliverStealth` | Runs the pooled buy within the slippage band (100 bps); delivers allocations. `deliverStealth` trusts the keeper to compute the stealth address | Instant |
| | anyone | `execute` fallback | From `windowEnd - GRACE`, at half the slippage band, only with a crowd complete before the fallback opened and a price round at most 15 min old | GRACE 1 h |
| ShieldedPool | OWNER | `setDepositsPaused` | Stops deposits and Hidden Vault buy, sell, park and Hidden delivery; never withdraw, transfer, refund or unpark | Instant: emergency stop of new money only |
| | OWNER | `proposeCap(asset, cap)` | Lowering applies at once (and drops a pending raise); raising waits, then anyone calls `applyCap` | Raise: 48 h (`CAP_DELAY`) |
| | OWNER | `setMinDeposit` | Minimum direct deposit (dust guard) | Instant |
| ShieldedTrade | OWNER | `proposeAdapter` / `disablePark` | Adds a park adapter (anyone applies after the delay) / stops new parks; unpark always works | Add: 48 h; disable: instant |
| PerpPool (in progress) | OWNER | `proposeMarket` then `addMarket` | Lists a market (a market can lock collateral and settle payouts against LP funds) | 48 h once LPs exist (instant only before the first LP share) |
| | OWNER | `removeMarket` | Unlists a market with no open interest and no reserve | Instant: cannot move the share price |
| | OWNER | `proposeMakerRegistrar` / `setMakerRegistrar(0)` | Sets / clears the maker-fee registrar (unset on mainnet) | Set: 48 h; clear: instant |
| PerpMarket (in progress) | OWNER | `proposeParams` then `setParams` | Fees (taker <= 1%), off-hours spread 5-30%, borrow <= 1%/h, funding, OI cap, profit cap, liquidation fee | 48 h (`pool.TIMELOCK`) |
| | OWNER | `setParams` lowering only `oiCapBps` | Refuses new opens beyond the lower cap | Instant: reduces risk |
| | OWNER | `proposeGuards` then `setGuards` / raising only the open spread or minimum collateral | Open spread 10-300 bps, minimum hold 5 min-1 d, minimum liquidation reward, minimum collateral | 48 h; raising those two: instant |
| | anyone | `liquidate`, `settleHeld` | Liquidates with a minimum reward; settles a market held longer than 5 days | Permissionless |
| TemplateRegistry | committee (OWNER) | `list`, `delist`, `setCommittee` | Curates policy templates (a board opts in to one) | Instant |
| TreasuryPolicy | board | `propose` / `cancel` | New policy version, tightening included (validated bounds) / cancel it | Activation: 48 h |
| TreasuryAccount (in progress) | board | `registerDesk`, `revokeDesk`, `setPrivateSleeve`, `withdrawToBoard` | Desk keys and adapters; withdrawal is never gated | Instant (the board's own treasury) |
| | board | `setPeriodClose` / `proposePeriodClose` | First wiring / replacing the period close (it can never be cleared; anyone applies) | Once / 48 h |
| | desk key | `execute` | One operation through an allowed adapter; PolicyGuard reverts it on any breach (bands, caps, loss per operation, venues, approvals; v2 adds a daily loss bound and per-position leverage, in progress) | Instant |
| BoardApprovals | board | `approve`, `reject` | One-use ticket for one exact operation, 24 h expiry | Instant |
| PeriodClose, PositionMirror, Receipts, PrivateSleeve | CONTROLLER (named by the policy) | signed close and snapshots, receipt roots, `setKeys` | The chain recomputes NAV at close; the controller holds the private sleeve's spending key | Instant |
| FeeRouter (token, not deployed on mainnet) | OWNER | `setKeeper`, `setTemplateFees`, `setBuyParams` | Keeper, template author share (<= 20%), buyback slippage (<= 5%) and per-push slice | First wiring instant; every later change 48 h (lowering included) |
| | KEEPER | `observe`, `push` | Reference price; fee split and buyback, at most once per hour | Instant |
| ExceptionInsurancePool (token; in progress) | committee (OWNER, immutable) | `approveClaim`, `rejectClaim` | Pays a factory treasury's claim, at most 25% of its NAV per claim | Approve: after a 3-day review delay |

Contracts with no admin: StealthClaims, ThresholdVerifier, park adapters, PolicyGuard (`maxOpLossBps` immutable),
TreasuryFactory, PeriodClose, Receipts, PositionMirror, the sleeves, PLTH,
PlinthStaking. `renounceOwnership` is inherited and not overridden on the OpenZeppelin-owned contracts; using it would
freeze their setters (including the pause) and is not part of any procedure. Ownership transfers are two-step where
listed in the deploy script and are not delayed.

Timers in v2 (immutable, planned mainnet values; perps, treasury and insurance values may still change): change delay, perps timelock, policy and period-close timelock, Hidden Vault cap and
park-adapter delays and the holiday notice 48 h; crowd window 24 h ending 19:30 UTC; beacon GRACE 1 h; public
fallback freshness 15 min; oracle staleness 26 h plus the market-hours calendar; perp LP cooldown 24 h, minimum hold
30 min, held-market settle after 5 days; insurance review 3 days, withdrawal and fee vesting 14 days; unbonding 7 days.

### Differences in the live v1 deployment

The beta at block 88,470,046 runs the earlier contracts (verified byte for byte by `bun run verify:explorer`). There:
every owner setter above is instant (feeds, pools, keepers, perp markets and parameters, maker registrar), there is no
market-hours calendar, the CrowdBuy fallback has no freshness bound, perp markets have a 100% open-interest cap and
no open spread or minimum hold, and the Hidden Vault accepts only the last 100 roots. Those are the audit's open
findings (see [Known issues](#known-issues-in-the-deployed-version)); v2 is meant to replace the deployment once its fixes are finished, reviewed and deployed.

### Emergency levers

In order of use (procedure: [incident runbook](security/INCIDENT-RUNBOOK.md)), all instant by design:
`ShieldedPool.setDepositsPaused(true)`; `StockTokenRegistry.delist(token)`; `Valuer.closeDays` (hold prices);
`PerpMarket.setParams` lowering only `oiCapBps` (to 0: no new opens); raising a market's open spread or minimum
collateral; `ShieldedPool.proposeCap` with a lower cap; `ShieldedTrade.disablePark`; `CrowdBuy.setKeeper(0)` /
`SavingsVault.setKeeper(0)`; `EligibilityRegistry.revoke`; `PerpPool.removeMarket` (no open interest). None of them
blocks a user's exit: SavingsVault withdraw, CrowdBuy cancel and claim, Hidden Vault withdraw, transfer, refund and
unpark, perp close, and board withdrawals stay open. There is no global pause on CrowdBuy, SavingsVault, perps or the
FeeRouter.

## Accepted risks

Each item is a deliberate trade-off for the closed beta, with the reason.

| Risk | Why accepted | Mitigation |
| --- | --- | --- |
| OWNER is a single EOA | Closed beta with invited users | v2 (in review) makes every setter that can hurt users wait 48 h in public (queued changes are events anyone can watch); moving OWNER to a multisig is planned. `verify:deployment` reports OWNER on every run |
| Valuer staleness is 26 h | Chainlink equity feeds stop when the market closes; a shorter bound would hold every weekday gap | v2 (in review) adds a market-hours calendar (weekends and announced holidays hold) and a 15 min freshness bound on the CrowdBuy public fallback (M-1) |
| A holdings proof publishes the nullifiers of the notes it covers, so a later spend links to the prover | Needed so a note cannot be shown twice | Documented in `sdk/README.md`; prove with notes you are about to move, or not at all, if linkage matters |
| The keeper chooses Quiet stealth addresses (`deliverStealth`) | The stealth address cannot be checked on chain | The keeper derives it from the saver's registered meta-address; deliveries are public events a saver can check |
| The treasury controller holds the private sleeve's spending secret | The private sleeve proves value without revealing notes | A board opts in per treasury; the period close recomputes the sleeve's value |
| SDK private sells are sent from the user's own wallet | No relayer for trades yet | Documented; use the relayer-backed withdraw for unlinkable exits |
| Insurance claims are attested by the treasury's own controller | Not deployed on mainnet | Revisit before the token contracts are deployed |
| Every service runs as one Unix user with one env file on the beta server | Single small host | Each service unlocks only its own keystore; separate Unix users and env files are planned |

## Known issues in the deployed version

The deployed contracts are the version the external AI audit reviewed (see [audit history](security/AUDITS.md)).
All of its findings are open on mainnet until a fixed version is deployed:

| Id | Issue | Status |
| --- | --- | --- |
| M-1 | CrowdBuy public fallback can be sandwiched on a stale price | Fix written for v2, in review: the public fallback needs a round at most 15 min old and a crowd complete before it opened; market-hours calendar |
| M-2 | A held market with one small position can block LP exits | In progress for v2 (perps) |
| M-3 | Same-transaction fills at the current oracle price allow front-running oracle updates | In progress for v2 (perps) |
| M-4 | Underwater positions have no liquidation incentive; bad debt inflates LP shares | In progress for v2 (perps and keeper) |
| M-5 | Strangers can push in-flight Hidden Vault proofs out of the 100-root window | Fix written for v2, in review: every published root is accepted; solo inserts wait for a batch of 4 or 2 h |
| M-6 to M-9 | Keeper, statement import, relayer zero-fee and OFX parser denial-of-service issues (services) | Fix in progress (services; no redeploy needed) |
| L-1 to L-3, L-9 | Crowd and Hidden Vault Lows | Fixes written for v2, in review |
| L-4 to L-8, L-10 | Treasury and insurance Lows | In progress for v2 |
| L-11 | Holdings-proof nullifier linkage | Accepted risk (above); the SDK adds an unlinking helper |
| L-12 to L-15 | Service Lows | Fix in progress (services) |

Until the redeploy the beta stays closed and the operator watches the levers above.

## Supply chain and CI

Every push and pull request runs `.github/workflows/ci.yml` on GitHub-hosted runners with a read-only token and no
secrets: Foundry tests with invariants at >= 100,000 calls, coverage, `nargo test` and a check that the committed
verifiers match a fresh circuit build, the SDK and service tests, gitleaks over the whole history, a scoped Slither
run where every Medium or High finding is reviewed in `contracts/slither.triage.json`, and Semgrep. Actions are pinned
to commit SHAs and downloaded tools to versions with checksums; dependencies are exact versions with committed
lockfiles, frozen installs and a 24 h release-age guard (`.github/scripts/check-hygiene.py` enforces all of it).
Mutation testing of CrowdBuy, ShieldedPool and PerpMarket (`contracts/script/mutation.sh`, report in `contracts/mutation/REPORT.md`) scores 94.7% of compiled mutants killed, with every survivor classified.
