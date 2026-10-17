# Audit history

Every security review of this code, newest first, with what it found and what changed. No review so far is a human
audit: the internal passes were multi-agent AI reviews run by the team, and the external one is an AI audit. A human
audit is required before large deposits.

## 2026-10-16: internal v2 review (multi-agent AI), grade 4.9 / 10

The audit fixes above, reviewed as new code before any deploy: seven area reviewers with the audit checklist, a
skeptic pass on every finding, and the lead re-running the Medium proofs of concept. Scored state: the contract fixes
and the services as they stood, before the CI, docs and invariant work was merged. **0 High, 5 Medium, 25 Low**, and
several Info items. Three of the Mediums came from the fixes themselves. The Hidden Vault fixes held up completely.

| Id | Finding | Status |
| --- | --- | --- |
| V2-M1 | The market calendar knew no holidays or early closes, and never expired (fails open about 10 trading days a year) | Fixed in code in v2 (merged, not deployed), pending independent re-review: NYSE closures and early closes to Labor Day 2029, `calendarValidUntil` fails closed |
| V2-M2 | Dust positions fill all 100 slots of a perp market for about 0.6 USDG | Fixed in code in v2, pending independent re-review: collateral and size floors after every open, increase and partial decrease; `retire` |
| V2-M3 | The minimum liquidation reward could be farmed from the LP pool with dust-collateral positions | Fixed in code in v2, pending independent re-review: the pool's top-up is capped at the position's own collateral |
| V2-M4 | The OFX parser still had one quadratic regex | Fixed in the services code, pending independent re-review: a linear scan, statements parsed in a worker |
| V2-M5 | Sybils with 1 USDG each bought keeper transactions and stalled the core jobs | Fixed in the services code, pending independent re-review: a 25-cent minimum imported round-up and a time, gas and per-user budget per pass |
| V2-L1 to V2-L11 | Perps (settle on a stale delisted price, parameter bounds, OI cap), crowd fallback reach and band, sequencer feed setter, ChangeDelay expiry and ownership changes, a griefable perp deploy, private-sleeve sweep, per-position leverage, margin rescue, insurance cap | Fixed in code in v2 (merged, not deployed), pending independent re-review. V2-L5: no sequencer-uptime feed exists on Robinhood Chain, accepted (SECURITY.md) |
| V2-L12 to V2-L18 | tRPC batching, rate-limiter sweep cost, hidden delivery reverts, treasury read gating and log scans, relayer fees vs gas, dropped nonces | Fixed in the services code, pending independent re-review |
| V2-L19 | Unparks were not relayed, and there is no relayed private transfer | Unparks relayed. The private transfer stays unrelayed (no fee field in the transfer proof): accepted (SECURITY.md) |
| V2-L20 to V2-L24 | Post-deploy check passed with the hand-over pending, instant safety setters, EOA OWNER accepted, treasury services sharing one user, loose mainnet values | Fixed in code, pending independent re-review: strict post-deploy check, delayed or two-step setters (the rest accepted with reasons in SECURITY.md), contract OWNER required unless explicitly allowed, separate Unix users, mainnet value pins |
| V2-L25 | Dependency ranges | Fixed in code, pending independent re-review: exact pins, a committed circuits lockfile, a test that enforces both |
| I-2, I-8 | Swap slippage not in the proof; a held perp market holds LP flows for the first 5 days | Accepted (SECURITY.md) |

Slither was re-run on the merged tree (0.11.6): every Medium and High finding in a new or changed function was reviewed
and recorded in `contracts/slither.triage.json` with its reason; none is a defect.

## 2026-10-16: external AI audit (rubric v2, full mode) — grade 3.7 / 10

Commit reviewed: `c52ef3d` on the public repository (124 commits), which is the source of the live mainnet beta
(the bytecode match in `bun run verify:explorer` proves the deployed contracts equal that source).

| Category | Weight | Score | Main deductions |
| --- | --- | --- | --- |
| A On-chain security | 35% | 0.7 | 5 Medium, 11 Low |
| B Off-chain services | 15% | 4.0 | 4 Medium, 4 Low |
| C Testing | 15% | 6.7 | No CI; no mutation testing; invariant configs under 100k calls; no invariants for staking, FeeRouter or real treasury sleeves |
| D Privileged operations | 10% | 6.0 | Instant feed and pool changes; no role list with holders; post-deploy check did not assert owners or roles; live deployment not verified; no runbook |
| E Dependencies | 5% | 7.5 | Version ranges (viem); release-age guard only in web; non-frozen postinstall |
| F Hygiene and CI | 10% | 4.5 | No CI or scanners; no SECURITY.md; floating pragmas |
| G Docs | 10% | 4.5 | No threat model, invariants doc or audit history; README contradicted the deployment |

What held up, in the auditor's words summarised: Hidden Vault soundness (nullifiers bound to note position,
commitments bind asset, amount, owner and blinding, every amount range-checked, withdrawals bind recipient, fee,
amount and deadline, verifiers wired with the right public inputs, circuit bytecode reproducible 6/6); exits never
blocked by pause or eligibility; the treasury policy guard cannot be bypassed; CrowdBuy and StockRouter oracle-bound
outputs and exact rounding; EIP-712 stealth claims; PerpPool reserves; relayer, eligibility and MCP token handling;
834/834 Foundry tests, 94-98% line coverage, 110/110 Noir tests. Its 21 proofs of concept ran against the real contracts, verifiers and services.

### Findings and status

| Id | Finding | Status |
| --- | --- | --- |
| M-1 | CrowdBuy public fallback sandwichable on a stale (26 h) price | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| M-2 | A held market with one small position freezes LP exits | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| M-3 | Traders can front-run oracle updates (same-transaction fills) | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| M-4 | Underwater positions not liquidated; bad debt inflates LP share price | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| M-5 | Anyone can expire in-flight Hidden Vault proofs (100-root window) | Fixed in code in v2 (merged, not deployed), pending independent re-review |
| M-6 | One saver's malformed privacy keys stop Quiet and Hidden delivery | Fixed in the services code, pending independent re-review, plus on-chain key checks in v2 (merged, not deployed) |
| M-7 | Statement import makes the keeper pay for unlimited no-op transactions | Fixed in the services code, pending independent re-review |
| M-8 | Relayer pays for endless zero-amount withdraws | Fixed in the services code, pending independent re-review |
| M-9 | One OFX upload blocks the API (quadratic parser) | Fixed in the services code, pending independent re-review (completed after the v2 review's V2-M4) |
| L-1 to L-15 | Never-committed window, delisted mix tokens, `join(user)` griefing, donation vs signed close, per-venue leverage, sleeve book drift, insurance attestation, just-in-time insurance fees, relayer fee race, sleeve withdraw book debit, holdings-proof linkage, tiny stealth claims, API rate limits, public treasury reads, statement-verify amplification | L-1 to L-10 fixed in v2 (merged, not deployed); L-11 accepted (SECURITY.md); L-12 to L-15 fixed in the services |
| D | Instant feed / pool / keeper changes, settings outside the timelock, one Unix user, webhook targets | Fixed in v2 (merged, not deployed): 48 h public change delay on feed, pool, keeper, attester and fee setters, perps and period-close timelocks (SECURITY.md); treasury webhooks and marks run as their own Unix users with no keys |
| C, E, F, G | Testing, dependencies, hygiene, docs | **Fixed** (below) |

### Fixes for C, D (tooling), E, F and G

| Audit item | Change |
| --- | --- |
| No CI | `.github/workflows/ci.yml`: SHA-pinned actions, `permissions: contents: read`, no secrets, GitHub-hosted runners: forge build and test, coverage, Slither (scoped, triaged), Semgrep, gitleaks over the full history, `nargo test`, verifier freshness and client proving, SDK, web and app tests, and a daily live-deployment check (the workflow has not run on the repository yet) |
| Invariants under 100k calls | Every suite runs at 256 x 500 = 128,000 calls under `FOUNDRY_PROFILE=ci` ([INVARIANTS.md](INVARIANTS.md)) |
| Invariant gaps | New suites: PlinthStaking, FeeRouter (real staking and insurance), treasury with the real CashSleeve and EquitySleeve; the Hidden Vault suite documented as accounting-only with the real-verifier tests named |
| No mutation testing | `contracts/script/mutation.sh` (slither-mutate, 2,300 mutants over CrowdBuy, ShieldedPool and PerpMarket) and `contracts/mutation/REPORT.md`: on v1 (commit 106c1a4): score 83.9% from the campaign, 94.7% after 62 new tests that close the real gaps; every remaining survivor classified (90 equivalent). A v2 campaign is pending |
| Coverage fails on the full project | Plain `forge coverage` now builds the whole project (one test reshaped) and runs in CI |
| Slither crashes on the generated verifiers | `contracts/script/slither.sh` analyses everything else; every Medium/High finding reviewed per function in `contracts/slither.triage.json`; new ones fail CI |
| Post-deploy check lacks owner and role asserts | `bun run verify:deployment`: owners, pending owners, roles, wiring, timers, feeds, pools, caps; exits 1 on mismatch |
| Live deployment not verified | `bun run verify:explorer`: every deployed runtime code equals the build of the recorded commit (45/45 on mainnet), plus `forge verify-contract --verifier sourcify` commands for mainnet (Sourcify lists chain 4663 as supported; Blockscout's API sits behind a Cloudflare challenge). Nothing submitted yet |
| No role list, no runbook | [SECURITY.md](../SECURITY.md), [INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md) |
| Version ranges, release age, non-frozen installs | Exact pins in every package (app, sdk, circuits, web); committed lockfiles; `minimumReleaseAge` in every package; frozen postinstall |
| Floating pragmas | `pragma solidity 0.8.28;` on every deployable contract; enforced by `.github/scripts/check-hygiene.py` |
| No threat model, invariants doc, audit history | [THREAT-MODEL.md](THREAT-MODEL.md), [INVARIANTS.md](INVARIANTS.md), this file |
| README contradicts the deployment | The README's deployment section is generated from `app/deployments` and checked in CI |

## 2026-10-07: internal release-gate delta reviews

Four delta passes over the fixes below (each fix reviewed as new code), then a final delta over everything changed
since. Found D1 to D4 (insurance LP accounting, deposit price floor, router-only fees, a keeper Quiet-delivery
liveness issue) and E1 (a keeper path that could credit a Quiet allocation twice); all fixed with exploit tests; the
last two passes confirmed no further issue. Testnet run after the fixes: 204/204 steps.

## 2026-10-06: internal deep review, two passes

Contracts, circuits and services; 9 then 15 areas, an adversarial verifier per finding. 13 confirmed findings
(S1 to S13), each fixed in its own commit with a test that failed before the fix: zero-value transfers freezing perp
LPs, insurance deposits during a drained queue, a sandwichable buyback, retroactive funding, beacon timing
derivable from the commitment, keeper-only crowd execution, ciphertexts bound into the proofs (`ext_hash`), full-tree
rollover and dust notes, capped perp profit in NAV, hold-gap pair trades, stale LP share prices, insurance
withdrawers earning fees, and a transaction resend after a rate-limited receipt poll.
