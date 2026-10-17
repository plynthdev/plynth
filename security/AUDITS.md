# Audit history

Every security review of this code, newest first, with what it found and what changed. No review so far is a human
audit: the internal passes were multi-agent AI reviews run by the team, and the external one is an AI audit. A human
audit is required before large deposits.

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
| M-1 | CrowdBuy public fallback sandwichable on a stale (26 h) price | Fix written for v2, in review (not deployed) |
| M-2 | A held market with one small position freezes LP exits | In progress for v2 |
| M-3 | Traders can front-run oracle updates (same-transaction fills) | In progress for v2 |
| M-4 | Underwater positions not liquidated; bad debt inflates LP share price | In progress for v2 |
| M-5 | Anyone can expire in-flight Hidden Vault proofs (100-root window) | Fix written for v2, in review (not deployed) |
| M-6 | One saver's malformed privacy keys stop Quiet and Hidden delivery | Service fix, in progress |
| M-7 | Statement import makes the keeper pay for unlimited no-op transactions | Service fix, in progress |
| M-8 | Relayer pays for endless zero-amount withdraws | Service fix, in progress |
| M-9 | One OFX upload blocks the API (quadratic parser) | Service fix, in progress |
| L-1 to L-15 | Never-committed window, delisted mix tokens, `join(user)` griefing, donation vs signed close, per-venue leverage, sleeve book drift, insurance attestation, just-in-time insurance fees, relayer fee race, sleeve withdraw book debit, holdings-proof linkage, tiny stealth claims, API rate limits, public treasury reads, statement-verify amplification | L-1 to L-3 and L-9 written for v2, in review; L-4 to L-8 and L-10 in progress; L-11 accepted (SECURITY.md); L-12 to L-15 in progress with the services |
| D | Instant feed / pool / keeper changes, settings outside the timelock, one Unix user, webhook targets | Written for v2, in review: 48 h public change delay on feed, pool, keeper and fee setters; perps and period-close timelocks still in progress (SECURITY.md) |
| C, E, F, G | Testing, dependencies, hygiene, docs | **Fixed** (below) |

### Fixes for C, D (tooling), E, F and G

| Audit item | Change |
| --- | --- |
| No CI | `.github/workflows/ci.yml`: SHA-pinned actions, `permissions: contents: read`, no secrets, GitHub-hosted runners: forge build and test, coverage, Slither (scoped, triaged), Semgrep, gitleaks over the full history, `nargo test`, verifier freshness and client proving, SDK and app tests, and a daily live-deployment check |
| Invariants under 100k calls | Every suite runs at 256 x 500 = 128,000 calls under `FOUNDRY_PROFILE=ci` ([INVARIANTS.md](INVARIANTS.md)) |
| Invariant gaps | New suites: PlinthStaking, FeeRouter (real staking and insurance), treasury with the real CashSleeve and EquitySleeve; the Hidden Vault suite documented as accounting-only with the real-verifier tests named |
| No mutation testing | `contracts/script/mutation.sh` (slither-mutate, 2,300 mutants over CrowdBuy, ShieldedPool and PerpMarket) and `contracts/mutation/REPORT.md`: score 83.9% from the campaign, 94.7% after 62 new tests that close the real gaps; every remaining survivor classified (90 equivalent) |
| Coverage fails on the full project | Plain `forge coverage` now builds the whole project (one test reshaped) and runs in CI |
| Slither crashes on the generated verifiers | `contracts/script/slither.sh` analyses everything else; every Medium/High finding reviewed per function in `contracts/slither.triage.json`; new ones fail CI |
| Post-deploy check lacks owner and role asserts | `bun run verify:deployment`: owners, pending owners, roles, wiring, timers, feeds, pools, caps; exits 1 on mismatch |
| Live deployment not verified | `bun run verify:explorer`: every deployed runtime code equals the build of the recorded commit (45/45 on mainnet), plus Blockscout verification commands (not yet submitted) |
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
