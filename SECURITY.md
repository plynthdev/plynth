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
library addresses masked), and the live configuration is asserted by `bun run verify:deployment`. The CI workflow
runs both on a daily schedule once it runs on the repository (it has not run yet). An external AI audit graded the deployed version 3.7/10 with nine Medium findings; they are listed under
[Known issues](#known-issues-in-the-deployed-version); their fixes are merged in v2 in this tree, which is not deployed
yet. No human audit has been done.

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

This section describes the **v2 contracts** in this tree: the fixes for the external audit and for the internal v2
review (see [audit history](security/AUDITS.md)) are merged here, but **v2 is not deployed**. The live mainnet beta
is still v1 (block 88,470,046), where every owner setter is instant; see
[Differences in the live v1 deployment](#differences-in-the-live-v1-deployment). Values marked "mainnet" are the
ones `contracts/script/MainnetBeta.s.sol` deploys and asserts in `checkHandoff`.

**Change delay.** Owner setters that could hurt users go through a public 48 h queue (`contracts/src/libs/ChangeDelay.sol`,
`CHANGE_DELAY = 48 hours`): the first call with given arguments only queues it and emits `ChangeQueued(id, data, eta)`;
the identical call after the eta applies it (`ChangeApplied`); the owner's `cancelChange(id)` drops it. A queued change
can be applied for 14 days after its eta (`CHANGE_EXPIRY`); after that the same call queues it again with a fresh
notice. The change id includes `changeNonce`, which every ownership change bumps, so a change queued by one owner (for
example the deployer) can never be applied by the next one. Contracts using it: StockTokenRegistry, StockRouter,
Valuer, JitterBeacon, EligibilityRegistry, SavingsVault, CrowdBuy, ShieldedPool (no `cancelChange` there, contract
size) and FeeRouter.

Perps use their own proposal timelock (`PerpPool.TIMELOCK`, 48 h on mainnet): `propose*` records an eta, the setter
after the eta applies it once, and `cancel(id)` drops it. In v2 a matured proposal is good for 14 days after its eta
(`PROPOSAL_EXPIRY`; later it needs a fresh proposal), and every proposal id carries `proposalNonce`, which every
ownership change bumps, so a proposal made by the deployer can never be applied by OWNER (as ChangeDelay). Treasuries use the policy `TIMELOCK` (48 h). Setters that stay instant are listed with the reason:
each only stops or reduces something, is one-time deploy wiring, or acts before anybody can be affected.

| Contract | Caller | Function | Effect | Delay (mainnet) |
| --- | --- | --- | --- | --- |
| StockTokenRegistry | OWNER | `list(token, feed, embedded)` | First listing of a token | Instant: nobody holds a position priced by a token before it is listed; users opt in through their own mix, and a perp market on it still needs the pool timelock |
| | OWNER | `list` on a listed or delisted token | Re-points a feed, changes the flag or re-lists | 48 h change delay |
| | OWNER | `delist(token)` | Stops new buys, crowd execution and new perp opens; records `delistedAt`; exits never need a listed token | Instant: only stops new risk |
| StockRouter | OWNER | `setPool(token, key)` | First pool for a token / replacing a pool (the oracle minimum output bounds every trade) | First: instant (same reason as `list`); replace: 48 h |
| Valuer | OWNER | `enableMarketCalendar` | Turns on the market-hours hold: Friday 20:00 to Monday 01:00 UTC, marked days, and every price once the table expires | Instant, one-way (deploy) |
| | OWNER | `closeDays(days)` / `earlyCloseDays(days)` | Marks full-day closures / early closes (held from 17:00 UTC): crowd execution, perp opens, LP entry, period closes wait | Instant: holds only. Weekdays only, at most 16 marked days per UTC year |
| | OWNER | `reopenDay(day)` | Un-marks a day | Only for a day that starts at least 48 h ahead (`HOLIDAY_NOTICE`) |
| | OWNER | `setCalendarValidUntil(t)` | End of the holiday table; from then on every price holds (fails closed) | First value instant (deploy: 2029-10-01 00:00 UTC); later ones forward only, at most 4 years ahead, 48 h change delay |
| | OWNER | `setSequencerFeed(feed)` | L2 sequencer-uptime feed (prices hold while it is down and for 1 h after a restart) | 48 h change delay; must answer like an uptime feed; replaceable, never removable. Unset on mainnet (no such feed exists on Robinhood Chain; accepted risk below) |
| JitterBeacon | OWNER | `setKeeper(k)` | Rotates the keeper (zero refused) | 48 h change delay |
| | KEEPER | `commit` | Commits a window's secret execution time | Before the window |
| EligibilityRegistry | OWNER | `setAttester` | Rotates the attester (the compliance trust root); records already on chain stay | 48 h change delay |
| | ATTESTER | `revoke(user)` | Stops a user's new buys | Instant |
| SavingsVault | OWNER | `setKeeper(k)` | Rotates the keeper / `k = 0` stops round-ups and top-ups | Nonzero: 48 h; zero: instant (withdraw never needs the keeper) |
| | OWNER | `setCrowd`, `setEligibility` | Wiring | Once (deploy) |
| | KEEPER | `accrue`, `pullFixedTopUp` | Moves a saver's own balance to pending within the weekly cap (max 500 USDG); pulls the top-up the saver chose, at most once per 7 days | Instant |
| CrowdBuy | OWNER | `setKeeper(k)` | Rotates the keeper / `k = 0` leaves books to the public fallback | Nonzero: 48 h; zero: instant |
| | OWNER | `setStealthClaims`, `setShieldedPool` | Wiring | Once (deploy) |
| | KEEPER | `execute` (from the beacon time), `joinBatch`, `deliver`, `deliverStealth` | Runs the pooled buy within the slippage band (100 bps; at most 300); joins savers who can join and skips the rest; delivers allocations. Quiet delivery needs a valid ERC-5564 meta-address on record (`metaAddressValid`); `deliverStealth` trusts the keeper to compute the stealth address | Instant |
| | anyone | `execute` fallback | A book the keeper missed (crowd formed, its window's fallback time passed with no execution) runs publicly at any later open-market time, at the pool fee + 10 bps (never more than half the keeper band), on a price round at most 15 min old and newer than the miss | From the window's end minus GRACE (1 h) |
| ShieldedPool | OWNER | `setDepositsPaused` | Stops deposits and Hidden Vault buy, sell, park and Hidden delivery; never withdraw, transfer, refund or unpark | Instant: emergency stop of new money only |
| | OWNER | `proposeCap(asset, cap)` | Lowering applies at once (and drops a pending raise); raising waits, then anyone calls `applyCap` | Raise: 48 h (cap delay) |
| | OWNER | `setMinDeposit(asset, min)` | Minimum direct deposit (dust-note guard) | Raise: instant; lower (including to 0): 48 h change delay |
| | OWNER | `setCrowd`, `setTrade` | Wiring | Once (deploy) |
| | anyone | `insertPending` | Inserts queued deposits into the tree: each at least 1 h old, in batches of at least 4, or alone once the oldest is 2 h old; every published root stays valid | Permissionless |
| ShieldedTrade | OWNER | `proposeAdapter` / `disablePark` | Adds a park adapter (anyone applies after the delay) / stops new parks; unpark always works | Add: 48 h; disable: instant |
| PerpPool | OWNER | `proposeMarket` then `addMarket` | Lists a market (a market can lock collateral and settle payouts against LP funds) | 48 h once LP shares exist; instant only while the pool has none |
| | OWNER | `openDeposits` | Opens LP deposits. Deposits stay closed until then, so nobody can mint a share that would put the deploy's market listings behind the timelock | One-way; the deploy calls it after listing every market |
| | OWNER | `removeMarket` | Unlists a market with no open interest and no reserve | Instant: cannot move the share price |
| | OWNER | `proposeMakerRegistrar` / `setMakerRegistrar(0)` | Sets / clears the maker-fee registrar (v2 deploy: OWNER, set before any LP share exists) | Set: 48 h once LP shares exist; clear: instant |
| | registrar (OWNER) | `setMaker(account, bool)` | Marks an account as a maker: it pays the maker fee (6 bps) instead of the taker fee (10 bps). OWNER registers each treasury's InHousePerpVenue: a hedge open or close there then loses fee in + spread + fee out = 52 bps of size (60 as a taker), which the guard's in-house venue bound covers (see the desk-key row) | Instant: only lowers one account's fee (LP income) |
| PerpMarket | OWNER | `proposeParams` then `setParams` | Taker fee (at most 1%), maker fee (at most the taker fee; 6 bps on mainnet), off-hours spread 5-30%, borrow (at most 1%/h), funding, OI cap (at most 50%; 20% on mainnet), profit cap, liquidation fee. The open spread plus twice the cheaper fee must stay above the feeds' 50 bps deviation threshold | 48 h (`pool.TIMELOCK`); instant only while the market has no open interest and the pool no LP shares |
| | OWNER | `setParams` lowering only `oiCapBps` | Refuses new opens beyond the lower cap | Instant: reduces risk |
| | OWNER | `proposeGuards` then `setGuards` | Open spread 10-300 bps (40 on mainnet), minimum hold 5 min-1 d (30 min), minimum liquidation reward (1 USDG), minimum collateral (100 USDG) and the occupancy floor on size (`slotFloor`: 100 USDG up to the 50th open position, then doubling every 5 positions to 102,400 USDG for the 96th-100th); same round-trip floor | 48 h; raising only the open spread and/or the minimum collateral: instant |
| | OWNER | `retire()` | Winds the market down: opens and increases stop at once; after the pool timelock anyone may `settleRetired` each position at a fresh oracle price (normal fee and profit cap, no hold spread) | Instant stop, settlement after 48 h; one-way |
| | anyone | `liquidate`, `settleHeld`, `settleRetired`, `poke` | Liquidates (minimum reward topped up by the pool at most up to the position's own collateral); settles a market held longer than 5 days (counted from the later of the last price and the delisting); settles a retired market; records the price | Permissionless |
| TemplateRegistry | committee (OWNER) | `list`, `delist` | Curates policy templates (a board opts in to one) | Instant |
| | committee | `setCommittee` then `acceptCommittee` | Hands the committee role over; the new committee must accept | Two-step |
| TreasuryPolicy | board | `propose` / `cancel` | New policy version, tightening included (validated bounds) / cancel it | Activation: 48 h |
| TreasuryFactory | OWNER (two-step `transferOwnership` / `acceptOwnership`) | `setAdapterAllowed` | The allow-list of reviewed adapter runtime codehashes (sleeves, vault-holding sleeves, perp venues) that factory treasuries may register; seeded at deploy with the shipped CashSleeve and EquitySleeve. An adapter bound to one account (PerpSleeve, BasisSleeve, PrivateSleeve, a venue) has its own codehash and is approved per instance | Additions 48 h (ChangeDelay; instant only during the deployer's first-time setup); removals instant |
| TreasuryAccount | board | `proposeDesk` then `registerDesk`; `revokeDesk`, `setPrivateSleeve`, `withdrawToBoard` | Desk keys and adapters; on a factory treasury every new adapter must be on the factory allow-list (checked at proposal and again when applied); withdrawal is never gated | Registration: instant in the setup window (the first 48 h after creation), then 48 h (policy TIMELOCK; a proposal expires 14 days after its eta); revoke and withdraw instant |
| PerpSleeve, BasisSleeve | board | `proposeVenue` then `addVenue` | Adds a perp venue (never removed); on a factory treasury only an allow-listed one | Same setup window, then 48 h |
| | board | `setPeriodClose` / `proposePeriodClose` | First wiring / replacing the period close (it can never be cleared; anyone applies) | Once / 48 h |
| | desk key | `execute` | One operation through an allowed adapter; PolicyGuard reverts it on any breach: bands, order and day caps, loss per operation (`maxOpLossBps`, 50 bps on mainnet; for the gross notional an in-house perp venue opens or closes, that venue's own bound read live from its markets: open spread + 2 x the fee it pays + 10 bps, at most 100 bps, `PolicyGuard.venueLossBps`), loss per 24 h (50 bps of NAV), per-position leverage (an over-cap position may keep or shrink its size, never grow it), venues, approvals | Instant |
| BoardApprovals | board | `approve`, `reject` | One-use ticket for one exact operation, 24 h expiry | Instant |
| PeriodClose, PositionMirror, Receipts, PrivateSleeve | CONTROLLER (named by the policy) | signed close and snapshots, receipt roots, `setKeys` | The chain recomputes NAV at close; the controller holds the private sleeve's spending key. PrivateSleeve `unshield` / `sweep` forward what ShieldedPool recorded paying the sleeve for a nullifier (`withdrawnOf`), once per nullifier, and debit the book only if a treasury_close proof (close or refresh) showed that nullifier is one of the sleeve's own notes; any other note (the board's own, or a sleeve note shielded since the last proof) is forwarded undebited. PeriodClose's drawdown base (`periodStartNav`) is max(checked statement, tracked tokens valued as the guard values them) plus everything withdrawn to the board since the previous close, less the fee, so no withdrawal (before or after the snapshot, kept or returned) lowers it; the insurance claim basis counts only USDG, canonical Stock Tokens and the proven private part, less withdrawals to the board since the measurement | Instant |
| FeeRouter (token, not deployed on mainnet) | OWNER | `setKeeper`, `setTemplateFees`, `setBuyParams` | Keeper, template author share (<= 20%), buyback slippage (<= 5%) and per-push slice | First wiring instant; every later change 48 h (lowering included) |
| | KEEPER | `observe`, `push` | Reference price; fee split and buyback, at most once per hour | Instant |
| ExceptionInsurancePool (token, not deployed on mainnet) | committee (OWNER, immutable) | `approveClaim`, `rejectClaim` | Pays a claim filed by a TreasuryFactory treasury's board. The claims of one treasury in one period together may ask at most 25% of the claim basis (`claimBasisNow`) of the PeriodClose the factory made for it: the treasury's USDG (1:1), canonical Stock Tokens (Valuer) and proven private part at the last close's measurement, less its fee and less everything withdrawn to the board since. No sleeve's own value, cash vault, venue equity or other token counts, so nothing the board writes can raise it. The controller's attestation can only reject | Approve: at least 3 days after filing |

Contracts with no admin: StealthClaims, ThresholdVerifier, park adapters, PolicyGuard (`maxOpLossBps` immutable, the
day-loss bound a constant), TreasuryFactory, PeriodClose, Receipts, PositionMirror, the sleeves, PLTH,
PlinthStaking. `renounceOwnership` is inherited and not overridden on the OpenZeppelin-owned contracts; using it would
freeze their setters (including the pause) and is not part of any procedure. Ownership transfers are two-step where
listed in the deploy script and are not delayed; every ChangeDelay contract voids its queued changes on a transfer.

**Deploy-script rules (mainnet mode).** `MainnetBeta.s.sol` refuses an OWNER without code (a Safe is expected)
unless `ALLOW_EOA_OWNER=1` is set explicitly, `MAX_STALENESS` above 26 h, `MIN_CROWD` below 3, duplicate role
addresses, and a holiday table covering less than 24 months. It lists every perp market before `openDeposits`, and
`verifyDeploymentStrict` fails while any ownership hand-over is still pending.

Timers in v2 (immutable, mainnet values): change delay, perps timelock, policy and period-close timelock, Hidden Vault
cap and park-adapter delays and the holiday notice 48 h; queued changes expire 14 days after their eta; crowd window
24 h ending 19:30 UTC; beacon GRACE 1 h; public fallback freshness 15 min; oracle staleness 26 h plus the market-hours
calendar (table valid until 2029-10-01 00:00 UTC); Hidden Vault insert delay 1 h, solo insert after 2 h; perp LP
cooldown 24 h, minimum hold 30 min, held-market settle after 5 days, retire settlement after 48 h; insurance review
3 days, withdrawal and fee vesting 14 days; unbonding 7 days.

### Differences in the live v1 deployment

The beta at block 88,470,046 runs the earlier contracts (verified byte for byte by `bun run verify:explorer`). There:
every owner setter above is instant (feeds, pools, keepers, attester, minimum deposit, perp markets and parameters,
maker registrar), there is no market-hours calendar, the CrowdBuy fallback has no freshness bound, perp markets have a
100% open-interest cap and no open spread, minimum hold or position floors, LP deposits are open from the start, and
the Hidden Vault accepts only the last 100 roots. Those are the audit's open findings (see
[Known issues](#known-issues-in-the-deployed-version)); they stay open on mainnet until v2 is deployed.

### Emergency levers

In order of use (procedure: [incident runbook](security/INCIDENT-RUNBOOK.md)), all instant by design:
`ShieldedPool.setDepositsPaused(true)`; `StockTokenRegistry.delist(token)`; `Valuer.closeDays` (hold prices; v2);
`PerpMarket.setParams` lowering only `oiCapBps` (to 0: no new opens); raising a market's open spread or minimum
collateral; `PerpMarket.retire` (v2); `ShieldedPool.proposeCap` with a lower cap; `ShieldedTrade.disablePark`;
`CrowdBuy.setKeeper(0)` / `SavingsVault.setKeeper(0)`; `EligibilityRegistry.revoke`; `PerpPool.removeMarket` (no open
interest). None of them blocks a user's exit: SavingsVault withdraw, CrowdBuy cancel and claim, Hidden Vault withdraw,
transfer, refund and unpark, perp close, and board withdrawals stay open. There is no global pause on CrowdBuy,
SavingsVault, perps or the FeeRouter.

## Accepted risks

Each item is a deliberate trade-off, with the reason. "v2" items apply once v2 is deployed.

| Risk | Why accepted | Mitigation |
| --- | --- | --- |
| OWNER is a single EOA on the live v1 beta | Closed beta with invited users | v2 makes every setter that can hurt users wait 48 h in public (queued changes are events anyone can watch, expire after 14 days and die with an ownership change), and its deploy script refuses an EOA OWNER unless explicitly allowed. `verify:deployment` reports OWNER on every run |
| Valuer staleness is 26 h | Chainlink equity feeds stop when the market closes; a shorter bound would hold every weekday gap | v2 holds weekends, NYSE holidays and early closes through the market-hours calendar, and every price-sensitive public path (the CrowdBuy fallback) needs a round at most 15 min old |
| v2: no L2 sequencer-uptime feed | Chainlink's directory for Robinhood Chain mainnet has no sequencer-uptime feed (checked 2026-10-16); the deploy asserts the Valuer's stays unset | If the sequencer stops and restarts, prices are not held for the 1 h grace after the restart. The 26 h staleness, the calendar and the 15 min fallback freshness still apply. If a feed appears, `setSequencerFeed` (48 h, validated) adds it |
| v2: early closes hold from 17:00 UTC all year | NYSE half-days close at 13:00 New York, 17:00 UTC in summer and 18:00 UTC in winter | Winter half-days hold an hour early; this only fails closed |
| v2: the holiday table must be maintained | The calendar cannot derive holidays on chain | The table runs from Thanksgiving 2026 to Labor Day 2029, valid until 2029-10-01 00:00 UTC; after that every price holds until OWNER marks the next holidays and extends `calendarValidUntil` (48 h, at most 4 years ahead). Unscheduled closures are marked at once with `closeDays` |
| v2: `closeDays` / `earlyCloseDays` are instant | They only hold prices | Weekdays only, at most 16 marked days per UTC year; un-marking needs 48 h notice |
| v2: first-time `StockTokenRegistry.list` and `StockRouter.setPool` are instant | Nobody holds a position priced by a token before it is listed; users opt in through their own mix | Perp markets on it still need the pool timelock; changing a listed token's feed or pool waits 48 h |
| v2: `ShieldedPool` has no `cancelChange` | Contract size | A queued `setMinDeposit` lowering applies only if OWNER sends the same call again, and expires 14 days after its eta |
| v2: a missed crowd book can be executed by anyone at any open-market time | A dead or late keeper must never block a book | Only after the window's fallback time has passed with the crowd formed and no execution, on a round at most 15 min old, inside the pool fee + 10 bps, so pushing the pool first loses money |
| v2: perps floors | After every open, increase and partial decrease a position keeps at least `minCollateral` (100 USDG) of collateral and `slotFloor(occupancy)` of size, a floor that doubles with the market's occupancy past 50 positions, so holding all 100 slots needs about 1.02M USDG of size (about 80k USDG a month in borrow and fees) | Below half occupancy nothing changes; a full close, a liquidation and a margin top-up never check the floor, so a busier market never traps a position; treasury hedges through InHousePerpVenue / PerpSleeve follow the same rule |
| v2: a held perp market with open interest blocks LP exits for up to 5 days, and LP deposits for the whole hold | Pricing an LP entry or exit while a market with positions has no trusted price would move value between LPs | Every weekend and holiday is a hold, so this is routine. Past 5 days (`HELD_GRACE`) the market values its open interest at the reserve and stops blocking exits, and anyone may `settleHeld` its positions; `retire` empties a market for good |
| A holdings proof publishes the nullifiers of the notes it covers, so a later spend links to the prover | Needed so a note cannot be shown twice | Documented in `sdk/README.md`; prove with notes you are about to move, or not at all, if linkage matters |
| There is no relayed private transfer | `PublicTransfer` has no fee field, so a relayed transfer would be free for the user and paid by the relayer | A Hidden Vault transfer is sent from the user's own wallet, which links that wallet to the transfer's nullifier (not to the notes' owner keys). Withdraws, swaps (with their settle) and unparks are relayed. This stays until a transfer circuit with a relayer fee ships |
| A private swap's `maxSlippageBps` is not in the proof | Only buy and sell use it, as the StockRouter's oracle guard | The proof's `minOut` always binds the output, whoever submits the swap |
| The keeper chooses Quiet stealth addresses (`deliverStealth`) | The stealth address cannot be checked on chain | The keeper derives it from the saver's registered meta-address, which must be a valid one; deliveries are public events a saver can check |
| The treasury controller holds the private sleeve's spending secret | The private sleeve proves value without revealing notes | A board opts in per treasury; the period close recomputes the sleeve's value |
| Insurance claims are attested by the treasury's own controller | Not deployed on mainnet | In v2 the attestation can only reject; the committee's approval is the independent check, after a 3-day public review, within a per-treasury, per-period cap of 25% of the factory PeriodClose's claim basis (USDG, canonical Stock Tokens and the proven private part at the last close, less withdrawals since). Residual: cash vault and perp-venue value is not insured above that basis |
| v2: a withdrawal to the board counts as drawdown for the rest of its period and the whole next one | So no withdrawal can lower the drawdown base (review4 R4-TREAS-3): a withdrawal made just before the controller's snapshot and returned after used to switch the rule off for a period. The close cannot tell a temporary withdrawal from a real expense, so it treats every withdrawal as permanent | Conservative: DERISK and PAUSED restrict only new risk, never withdrawals or sells. A board that needs a lower base changes the policy's drawdown bands through the policy TIMELOCK (48 h), in public |
| v2: the insurance claim cap counts trusted value only | The basis (`claimBasisNow`) is USDG at 1:1, registry-canonical Stock Tokens at Valuer prices and the proven private part, less withdrawals to the board since the close (review4 R4-TREAS-2). Anything a board writes or chooses (a sleeve's own value, a cash vault's share price, perp-venue equity, other tokens) could be inflated at will | A treasury holding mostly vault shares or venue margin gets a lower cap; the committee's approval and the 3-day review still apply to every claim |
| v2: an adapter on the allow-list is trusted for the values it reports | The guard reads value from sleeves, cash vaults (`convertToAssets`) and venues; only reviewed code can be registered now, but a reviewed CashSleeve is configured by its constructor (the vault list lives in storage), so another deployment of the same code with a different vault list has the same codehash | What a desk can move value INTO stays bounded by the policy's `instrumentAllowRoot` (every increased asset, vault shares included) and `venueAllowRoot` (every venue whose risk goes up), both behind the policy TIMELOCK. New adapters wait 48 h after a treasury's setup window (`proposeDesk`, `proposeVenue`), and the allow-list itself only grows after a 48 h public notice. The drawdown base and the insurance basis read no sleeve's own value |

## Known issues in the deployed version

The deployed contracts are the version the external AI audit reviewed (see [audit history](security/AUDITS.md)).
All of its contract findings are open on mainnet until v2 is deployed:

| Id | Issue | Status |
| --- | --- | --- |
| M-1 | CrowdBuy public fallback can be sandwiched on a stale price | Fixed in code in v2 (merged, not deployed), pending independent re-review: the public fallback needs a round at most 15 min old, runs inside the pool fee + 10 bps, and the market-hours calendar holds weekends, holidays and early closes |
| M-2 | A held market with one small position can block LP exits | Fixed in code in v2 (merged, not deployed), pending independent re-review: the hold stops blocking exits after 5 days, `settleHeld` and `retire` empty a market, and position floors stop dust positions filling the 100 slots |
| M-3 | Same-transaction fills at the current oracle price allow front-running oracle updates | Fixed in code in v2 (merged, not deployed), pending independent re-review: open spread (40 bps), minimum hold for a profit (30 min), a round-trip floor above the feeds' deviation threshold, OI cap 20% |
| M-4 | Underwater positions have no liquidation incentive; bad debt inflates LP shares | Fixed in code in v2 (merged, not deployed), pending independent re-review: a minimum liquidation reward, topped up by the pool at most up to the position's own collateral, and a 100 USDG minimum collateral |
| M-5 | Strangers can push in-flight Hidden Vault proofs out of the 100-root window | Fixed in code in v2 (merged, not deployed), pending independent re-review: every published root is accepted; solo inserts wait for a batch of 4 or 2 h |
| M-6 to M-9 | Keeper, statement import, relayer zero-fee and OFX parser denial-of-service issues (services) | Fixed in the services code, pending independent re-review (no contract redeploy needed) |
| L-1 to L-3, L-9 | Crowd and Hidden Vault Lows | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| L-4 to L-8, L-10 | Treasury and insurance Lows | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| L-11 | Holdings-proof nullifier linkage | Accepted risk (above); the SDK adds an unlinking helper |
| L-12 to L-15 | Service Lows | Fixed in the services code, pending independent re-review |

Until the redeploy the beta stays closed and the operator watches the levers above.

## Supply chain and CI

`.github/workflows/ci.yml` is set to run on every push and pull request and on a daily schedule, on GitHub-hosted runners
with a read-only token and no secrets. It has not run on the repository yet; this describes what it runs, not results: Foundry tests with invariants at >= 100,000 calls, coverage, `nargo test` and a check that the committed
verifiers match a fresh circuit build, the SDK and service tests, gitleaks over the whole history, a scoped Slither
run where every Medium or High finding is reviewed in `contracts/slither.triage.json`, and Semgrep. Actions are pinned
to commit SHAs and downloaded tools to versions with checksums; dependencies are exact versions with committed
lockfiles, frozen installs and a 24 h release-age guard (`.github/scripts/check-hygiene.py` enforces all of it).
Mutation testing of CrowdBuy, ShieldedPool and PerpMarket (`contracts/script/mutation.sh`, report in `contracts/mutation/REPORT.md`) scored 94.7% of compiled mutants killed on v1 (commit 106c1a4), with every survivor classified. A campaign on the v2
contracts has not been run yet.
