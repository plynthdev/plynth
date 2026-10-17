# Mutation testing: CrowdBuy, ShieldedPool, PerpMarket

| | |
|---|---|
| Date | 2026-10-16 |
| Tool | `slither-mutate` from slither-analyzer 0.11.6 (Trail of Bits), crytic-compile 0.4.2 |
| Toolchain | forge 1.8.4 (`50af4ef`), solc 0.8.28 |
| Commit mutated | `106c1a4b66224c8810638c7d604dbab5ca1f1b6e` (contracts/src unchanged by this work) |
| Script | `contracts/script/mutation.sh` (output in `contracts/mutation/out/`, gitignored) |
| Campaign runtime | 3 h 24 min of mutant runs (CrowdBuy 66 min, ShieldedPool 65 min, PerpMarket 74 min), plus about 50 min re-running survivors |

## Command

```
contracts/script/mutation.sh            # all three; or: contracts/script/mutation.sh PerpMarket
```

For each contract the script runs (from `contracts/`, with `FOUNDRY_PROFILE=mutation`):

```
slither-mutate <src file> \
  --test-cmd "forge test --threads 4 --match-path '<tests>'" \
  --timeout 240 --mutators-to-run RR,ROR,LOR,MIA,UOR,LIR,AOR \
  --contract-names <Contract> --compile-force-framework foundry \
  --solc-remaps "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/ forge-std/=lib/forge-std/src/" \
  --output-dir mutation/out/<Contract> -v
```

| Contract | Source | Tests run against every mutant |
|---|---|---|
| CrowdBuy | `src/consumer/CrowdBuy.sol` | `test/consumer/{CrowdBuy*,EligibilityGate*}` |
| ShieldedPool | `src/consumer/ShieldedPool.sol` | `test/consumer/{ShieldedPool*,ShieldedTrade*,CrowdBuyHidden*}` (real proofs included) |
| PerpMarket | `src/perps/PerpMarket.sol` | `test/perps/*` |

slither-mutate appends `--fail-fast`. `[profile.mutation]` in `foundry.toml` turns the optimizer off, cuts fuzz runs to 64 and invariant runs to 16 x depth 50, and turns dynamic test linking off (see Finding 1). The script refuses to start with uncommitted changes in `contracts/src` and restores `contracts/src` from git on any exit.

## Mutator subset

The full slither-mutate set is 15 mutators and about 4,300 mutants for these three files (CR comment-out alone is 842, ASOR 430, FHR 189, SBR 306). At 4 to 10 s per compiled mutant on this machine that is over 10 hours, so the campaign uses the documented high-value subset (2,300 mutants):

| Mutator | What it does |
|---|---|
| RR | replaces each statement with `revert()` (finds statements no test executes) |
| ROR | relational operator replacement (`<`, `<=`, `==`, `!=`, ...): boundary and guard checks |
| LOR | `&&` / `||` swap |
| MIA | `if` condition to `true`, `false` and `!(cond)`: condition / require removal |
| UOR | unary operator replacement |
| LIR | literal integer replacement |
| AOR | arithmetic operator replacement |

Left out: CR (comment out a line; RR covers statement removal), ASOR (`+=` variants), BOR (bitwise), FHR (function header / visibility), SBR (Solidity-specific swaps such as `memory`/`storage`), MVIE/MVIV/MWA. Anyone can run them with `MUTATORS=CR,ASOR,... contracts/script/mutation.sh`.

slither-mutate in its default (non `--comprehensive`) mode skips later mutators on a line whose RR mutant survived, so a line no test reaches is reported once, not once per mutator.

## Scores

Mutation score = killed / (killed + survived). Uncompilable mutants (most of them are `revert()` on a declaration) are not counted. No mutant hit the 240 s timeout.

| Contract | Mutants generated | Uncompilable | Compiled | Killed | Survived | Timed out | Score (campaign) | Survived after new tests | Score (after) |
|---|---|---|---|---|---|---|---|---|---|
| CrowdBuy | 525 | 109 | 416 | 377 | 39 | 0 | **90.6%** | 26 | **93.8%** |
| ShieldedPool | 737 | 138 | 599 | 510 | 89 | 0 | **85.1%** | 36 | **94.0%** |
| PerpMarket | 1,038 | 233 | 805 | 640 | 165 | 0 | **79.5%** | 34 | **95.8%** |
| **Overall** | 2,300 | 480 | 1,820 | 1,527 | 293 | 0 | **83.9%** | 96 | **94.7%** |

Of the 96 that still survive, 90 are equivalent mutants (no input can tell them apart from the original), 4 are theoretical gaps that need a zero allocation (not reachable with 18-decimal tokens at real prices) and 2 are exact-equality boundaries in PerpMarket's partial-decrease path. Counting only non-equivalent mutants, the score is 1,724 / 1,730 = **99.7%**.

How the "after" column was produced: every surviving mutant source (saved by slither-mutate) was copied over the contract and the same scoped test command was run again with the new tests in place; `contracts/src` was restored after each run.

CrowdBuy note: its campaign ran before the dynamic-test-linking fix, giving 375 killed / 41 survived. Its 41 survivors were re-run with linking off: 2 were then killed, so the campaign figure above is 377 / 39. ShieldedPool and PerpMarket ran with the fix in place. CrowdBuy MIA_4 (the eligibility check in `join`) is killed by `EligibilityGate.t.sol`, which was outside the first test scope; the script's CrowdBuy glob now includes it.

## Findings

### 1. Dynamic test linking silently truncates tests (test harness bug, affects the default profile)

forge 1.8.4 has `dynamic_test_linking = true` (it is not set in `foundry.toml`, so it is the default). With it, `new SrcContract(...)` inside a test is compiled to a `vm.deployCode` cheatcode call, and a revert from it is matched by a preceding `vm.expectRevert` at the test's top level: **the test ends there and passes, and every line after it never runs.** Example: `CrowdBuy.t.sol:test_R2_slippageCapAt300Bps` expects `BadParam` for slippage 301 and then deploys with 300 and asserts; the trace shows the test stops after the first deployment, so a mutant that rejects 300 survived.

The pattern `vm.expectRevert(...)` directly followed by `new <Contract>(...)` occurs at about 40 places in `contracts/test`. The full suite was re-run with `FOUNDRY_DYNAMIC_TEST_LINKING=false` and all 896 tests pass, so no hidden failure is behind it today, but those tests check less than they read. Recommendation: set `dynamic_test_linking = false` in `[profile.default]` (costs some compile time), or rewrite those sites with try/catch as the new tests do. This change only sets it in `[profile.mutation]`; `[profile.default]` is untouched.

### 2. Real test gaps the run found (all now covered)

CrowdBuy
- Constructor zero-address checks for vault, router and beacon, and the router/vault USDG mismatch, had no test (the zero addresses would revert later with a different error).
- A window between `MIN_WINDOW` and the beacon's GRACE was never tried (only `window == GRACE`).
- A mix entry whose floor share is 0 must not create an order: with the `part != 0` guard removed the book counted a phantom account with no USDG.
- The permissionless fallback was tested only at exactly `windowEnd - GRACE`; a mutant that allowed strangers only at that second survived.
- Quiet delivery to a Hidden-mode user, `allocationOf` before execution, the zero-address checks in `setStealthClaims` / `setShieldedPool`, and `deliverStealth` before StealthClaims is set.

ShieldedPool
- `tradeInsert` (ShieldedTrade hook) had no direct tests: empty or mismatched batches, the 512-byte note boundary, skipping zero leaves, publishing the new root (a mutant that never published a root after a trade insert survived) and never publishing the zero root.
- Fee-on-transfer / rebasing tokens in `deposit` and `tradeCredit` (`TransferAmountMismatch`) in both directions.
- Boundaries: `tradeCredit` up to exactly the cap, a change note of exactly 512 bytes, a deposit of exactly `MAX_RAW`, a nullifier exactly equal to P, cap delay exactly `MIN_CAP_DELAY`.
- `insertPending` and `readyCount` were only tested at exactly `createdAt + MIN_PENDING_DELAY`; `readyCount` ignoring its `limit`; `insertPending` over only refunded entries must not publish a root; a transfer with one or no output commitments.
- Admin paths: zero verifiers in the constructor, zero `setTrade`, zero asset in `setMinDeposit` / `proposeCap`, `proposeCap` equal to the current cap, `applyCap` after (not at) the ETA, `refundPending` out of range, `treeOf`, and the `TreeArchived` tree id.

PerpMarket
- None of the views had a direct test: `exitValueOf`, `equityOf`, `isLiquidatable`, `traderPnl` (sum of both sides and the profit cap), `staleWithOpenInterest` with equal sides, `price`. Any arithmetic in `exitValueOf` could be changed without a failing test.
- The partial-decrease shortfall path (loss larger than the released collateral, taken from the remaining margin) was never executed, nor its two refusals (shortfall above the margin, remaining position above 50x).
- Partial decreases with accrued funding of either sign and with accrued borrow (the pro-rata split and its rounding), the funding index magnitude (`f = rate * dt`) and the `fundingPaidTotal` / `fundingReceivedTotal` statistics in both directions, and the starting funding index of a new position on each side.
- Storage fold vs memory fold consistency: `exitValueOf` now must equal what `close` pays for positions opened after the indices moved.
- Liquidating a healthy position (only the exact boundary was tested, which a `==` mutant also passes), the zero reward for an underwater liquidation, entry guards (`HasPosition`, `ZeroSize`, `NoPosition`), adding margin with no slippage allowance and above a lowered OI cap, `increase` refused below maintenance, token rounding direction per side, default parameters before `setParams`, and the reserve re-sync in `setParams`.

### 3. Tool quirks to know when reading the logs

- ROR on a compound condition rewrites the whole expression and duplicates an operand (for example `a == 0 || b > c` becomes `a == 0 || a == 0 || b >= c`). The one-line description in the log names the intended change, not the compiled source. The tables below show the source line actually compiled, taken from the saved mutant files.
- Mutants are compiled by crytic-compile through `forge build` of the single file; compile failures are cheap and are mostly `revert()` replacing a declaration.

## Tests added

| File | Tests |
|---|---|
| `test/consumer/CrowdBuyMutation.t.sol` (new) | 9 |
| `test/consumer/CrowdBuyQuiet.t.sol` | +1 (`test_deliverQuietRefusesHiddenModeUser`) |
| `test/consumer/ShieldedPoolMutation.t.sol` (new) | 25 |
| `test/perps/PerpMarketMutation.t.sol` (new) | 27 |

Reverts from `new` are checked with try/catch, so the new tests are complete under either linking setting. The full suite (`forge test --no-match-path 'test/fork/*'`) passes with the default profile and with dynamic test linking off: 896 passed, 3 skipped.

## Every surviving mutant

All 293 campaign survivors, with their status after the new tests. Verdicts: **Killed** (a real test gap, now closed, or the harness fix), **Equivalent** (behaves identically for every input or every reachable state), **Gap (not cheap)** / **Gap (boundary)** (still survives; reason given).

### CrowdBuy

| # | Line | Mutated source line | Verdict | Why |
|---|---|---|---|---|
| LOR_0 | CrowdBuy.sol:169 | `if (address(vault_) == address(0)  &&  address(router_) == address(0) ) {` | Killed | test gap closed: `test_constructorRejectsEachZeroAddress` |
| MIA_0 | CrowdBuy.sol:169 | `if (false) {` | Killed | test gap closed: `test_constructorRejectsEachZeroAddress` |
| ROR_0 | CrowdBuy.sol:172 | `if (minCrowd_ <= 0 \|\| slippageBps_ > MAX_SLIPPAGE_BPS \|\| slippageBps_ > MAX_SLIPPAGE_BPS) revert BadPar...` | Equivalent | `minCrowd_ <= 0` is `== 0` for uint (the mutant also duplicates an operand, a tool quirk) |
| ROR_1 | CrowdBuy.sol:172 | `if (minCrowd_ == 0 \|\| minCrowd_ == 0 \|\| slippageBps_ >= MAX_SLIPPAGE_BPS) revert BadParam();` | Killed | harness fix: `test_R2_slippageCapAt300Bps` never ran past its first `expectRevert` + `new` under dynamic test linking |
| ROR_2 | CrowdBuy.sol:172 | `if (minCrowd_ == 0 \|\| minCrowd_ == 0 \|\| slippageBps_ == MAX_SLIPPAGE_BPS) revert BadParam();` | Killed | harness fix (same test as above) |
| ROR_3 | CrowdBuy.sol:173 | `if (window_ < MIN_WINDOW \|\| window_ < MIN_WINDOW \|\| window_ == beacon_.GRACE()) revert BadWindow();` | Killed | test gap closed: `test_constructorRejectsWindowShorterThanGrace` |
| MIA_1 | CrowdBuy.sol:180 | `if (false) revert BadParam();` | Killed | test gap closed: `test_constructorRejectsRouterWithAnotherUsdg` |
| MIA_2 | CrowdBuy.sol:196 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_setStealthClaimsAndShieldedPoolRejectZero` |
| MIA_3 | CrowdBuy.sol:205 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_setStealthClaimsAndShieldedPoolRejectZero` |
| MIA_4 | CrowdBuy.sol:218 | `if (false) revert SavingsVault.NotEligible(user);` | Killed | out of the original test scope: killed by EligibilityGate.t.sol, now in the CrowdBuy test glob |
| ROR_4 | CrowdBuy.sol:220 | `if (amount <= 0) revert NothingPending();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_5 | CrowdBuy.sol:223 | `for (uint256 i; i != n; ++i) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_0 | CrowdBuy.sol:223 | `for (uint256 i; i < n; i++) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| MIA_5 | CrowdBuy.sol:226 | `if (true) _addOrder(mix[i].stockToken, user, part);` | Killed | test gap closed: `test_joinSkipsZeroPartsAndCountsNoAccount` (a zero part used to count a phantom account) |
| ROR_6 | CrowdBuy.sol:226 | `if (part > 0) _addOrder(mix[i].stockToken, user, part);` | Equivalent | `part > 0` is `part != 0` for uint |
| ROR_7 | CrowdBuy.sol:226 | `if (part >= 0) _addOrder(mix[i].stockToken, user, part);` | Killed | test gap closed: `test_joinSkipsZeroPartsAndCountsNoAccount` |
| ROR_8 | CrowdBuy.sol:235 | `if (order <= 0) revert NoOrder();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_6 | CrowdBuy.sol:268 | `if (false) revert AlreadyExecuted(); // unreachable: the current book is never executed` | Equivalent | unreachable guard: the current book is never executed |
| ROR_9 | CrowdBuy.sol:273 | `if (block.timestamp != end - beacon.GRACE()) revert NotKeeper();` | Killed | test gap closed: `test_permissionlessFallbackWorksAfterTheFallbackMoment` |
| ROR_10 | CrowdBuy.sol:276 | `if (lastExecutedWindow[asset] >= start + 1) revert AlreadyExecutedThisWindow(start);` | Equivalent | lastExecutedWindow is never above the current `start + 1` (time is monotonic) |
| MIA_7 | CrowdBuy.sol:280 | `if (false) revert MarketOnHold(asset);` | Equivalent | the router reverts with an identically encoded `MarketOnHold(address)` |
| RR_0 | CrowdBuy.sol:303 | `if (!b.executed \|\| b.usdgTotal == 0) revert();` | Killed | test gap closed: `test_allocationIsZeroBeforeExecution` |
| MIA_8 | CrowdBuy.sol:310 | `if (true) IERC20(asset).safeTransfer(msg.sender, raw);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) |
| ROR_11 | CrowdBuy.sol:310 | `if (raw > 0) IERC20(asset).safeTransfer(msg.sender, raw);` | Equivalent | `raw > 0` is `raw != 0` for uint |
| ROR_12 | CrowdBuy.sol:310 | `if (raw >= 0) IERC20(asset).safeTransfer(msg.sender, raw);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) |
| ROR_13 | CrowdBuy.sol:331 | `if (vault.settingsOf(user).mode < MODE_QUIET) revert NotQuiet(user);` | Killed | test gap closed: `test_deliverQuietRefusesHiddenModeUser` (CrowdBuyQuiet.t.sol) |
| ROR_14 | CrowdBuy.sol:332 | `if (sc.registry().stealthMetaAddressOf(user, STEALTH_SCHEME).length <= 0) revert NoMetaAddress(user);` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_9 | CrowdBuy.sol:334 | `if (true) {` | Gap (not cheap) | differs only for a zero Quiet allocation (StealthClaims.pool reverts on 0); unreachable with 18-decimal tokens at real prices |
| ROR_15 | CrowdBuy.sol:334 | `if (raw > 0) {` | Equivalent | `raw > 0` is `raw != 0` for uint |
| ROR_16 | CrowdBuy.sol:334 | `if (raw >= 0) {` | Gap (not cheap) | same as the line above |
| ROR_17 | CrowdBuy.sol:345 | `if (vault.settingsOf(user).mode < MODE_HIDDEN) revert NotHidden(user);` | Equivalent | the vault caps mode at 2, so `< 2` and `!= 2` agree |
| ROR_18 | CrowdBuy.sol:347 | `if (ownerPk <= 0) revert NoHiddenKeys(user);` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_10 | CrowdBuy.sol:349 | `if (true) {` | Gap (not cheap) | differs only for a zero Hidden allocation (ShieldedPool rejects 0); unreachable with 18-decimal tokens at real prices |
| ROR_19 | CrowdBuy.sol:349 | `if (raw > 0) {` | Equivalent | `raw > 0` is `raw != 0` for uint |
| ROR_20 | CrowdBuy.sol:349 | `if (raw >= 0) {` | Gap (not cheap) | same as the line above |
| MIA_11 | CrowdBuy.sol:364 | `if (false) revert QuietNotConfigured();` | Killed | test gap closed: `test_deliverStealthNeedsStealthClaims` |
| ROR_21 | CrowdBuy.sol:394 | `if (b.openedAt <= 0) {` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_22 | CrowdBuy.sol:399 | `if (orders[user] <= 0) b.accounts += 1;` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_23 | CrowdBuy.sol:418 | `if (orderOf[asset][bookId][user] <= 0) revert NoOrder();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_24 | CrowdBuy.sol:425 | `if (s.settledAccounts >= b.accounts) {` | Equivalent | settledAccounts never exceeds accounts |
| AOR_0 | CrowdBuy.sol:426 | `uint256 d = b.rawOut % s.settledRaw;` | Equivalent | `rawOut % settledRaw` equals `rawOut - settledRaw` whenever dust < settledRaw (dust < accounts); differs only if every allocation is 0 |

### ShieldedPool

| # | Line | Mutated source line | Verdict | Why |
|---|---|---|---|---|
| MIA_0 | ShieldedPool.sol:190 | `if (false) revert DelayTooShort();` | Killed | test gap closed: `test_capDelayMinimumIsInclusive` |
| ROR_0 | ShieldedPool.sol:190 | `if (capDelay_ <= MIN_CAP_DELAY) revert DelayTooShort();` | Killed | test gap closed: `test_capDelayMinimumIsInclusive` |
| ROR_1 | ShieldedPool.sol:190 | `if (capDelay_ == MIN_CAP_DELAY) revert DelayTooShort();` | Killed | test gap closed: `test_capDelayMinimumIsInclusive` |
| LOR_0 | ShieldedPool.sol:192 | `if (address(transferVerifier_) == address(0)  &&  address(withdrawVerifier_) == address(0)) {` | Killed | test gap closed: `test_constructorRejectsEachZeroVerifier` |
| MIA_1 | ShieldedPool.sol:192 | `if (false) {` | Killed | test gap closed: `test_constructorRejectsEachZeroVerifier` |
| MIA_2 | ShieldedPool.sol:213 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_setTradeRejectsZero` |
| MIA_3 | ShieldedPool.sol:227 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_setMinDepositAndProposeCapRejectZeroAsset` |
| MIA_4 | ShieldedPool.sol:234 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_setMinDepositAndProposeCapRejectZeroAsset` |
| ROR_2 | ShieldedPool.sol:235 | `if (newCap < cap[asset]) {` | Killed | test gap closed: `test_proposeCapEqualToCurrentAppliesNowAndClearsProposal` |
| ROR_3 | ShieldedPool.sol:249 | `if (p.eta <= 0) revert NoProposal();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_4 | ShieldedPool.sol:250 | `if (block.timestamp != p.eta) revert TooEarly(p.eta);` | Killed | test gap closed: `test_applyCapWorksAfterEtaNotOnlyAtIt` |
| ROR_5 | ShieldedPool.sol:284 | `if (pendingId > _pending.length) revert NotPending(pendingId);` | Killed | test gap closed: `test_refundPendingOutOfRangeIsNotPending` |
| ROR_6 | ShieldedPool.sol:286 | `if (p.state > PendingState.Queued) revert NotPending(pendingId);` | Equivalent | a stored pending entry is never in state None, so `> Queued` and `!= Queued` agree |
| ROR_7 | ShieldedPool.sol:302 | `while (i != end && maxCount != 0 && maxCount != 0) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_8 | ShieldedPool.sol:302 | `while (i < end && i < end && maxCount > 0) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_9 | ShieldedPool.sol:304 | `if (p.state <= PendingState.Queued) {` | Equivalent | a stored pending entry is never in state None, so `<= Queued` and `== Queued` agree |
| ROR_10 | ShieldedPool.sol:305 | `if (block.timestamp != uint256(p.createdAt) + MIN_PENDING_DELAY) break;` | Killed | test gap closed: `test_insertPendingAndReadyCountLongAfterTheDelay` |
| UOR_0 | ShieldedPool.sol:310 | `inserted++;` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_1 | ShieldedPool.sol:312 | `i++;` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_2 | ShieldedPool.sol:313 | `maxCount--;` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_11 | ShieldedPool.sol:315 | `if (i <= start) revert NothingToInsert();` | Equivalent | `i` never drops below `start` |
| MIA_5 | ShieldedPool.sol:317 | `if (true) _publishRoot(root);` | Killed | test gap closed: `test_insertPendingOverOnlyRefundedEntriesPublishesNoRoot` |
| ROR_12 | ShieldedPool.sol:317 | `if (inserted > 0) _publishRoot(root);` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_13 | ShieldedPool.sol:317 | `if (inserted >= 0) _publishRoot(root);` | Killed | test gap closed: `test_insertPendingOverOnlyRefundedEntriesPublishesNoRoot` |
| MIA_6 | ShieldedPool.sol:331 | `if (false) revert ZeroAddress();` | Killed | test gap closed: `test_transferRejectsZeroAsset` |
| ROR_14 | ShieldedPool.sol:351 | `for (uint256 i; i != 2; ++i) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_3 | ShieldedPool.sol:351 | `for (uint256 i; i < 2; i++) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| RR_0 | ShieldedPool.sol:352 | `if (pub.outCommitments[i] == 0) revert();` | Killed | test gap closed: `test_transferWithOneZeroOutputInsertsOneLeaf` |
| MIA_7 | ShieldedPool.sol:356 | `if (true) _publishRoot(root);` | Killed | test gap closed: `test_transferWithNoOutputsPublishesNoRoot` |
| ROR_15 | ShieldedPool.sol:356 | `if (root > 0) _publishRoot(root);` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_16 | ShieldedPool.sol:356 | `if (root >= 0) _publishRoot(root);` | Killed | test gap closed: `test_transferWithNoOutputsPublishesNoRoot` |
| ROR_17 | ShieldedPool.sol:364 | `if (pub.encryptedChange.length >= MAX_NOTE_BYTES) revert NoteTooLarge();` | Killed | test gap closed: `test_withdrawAcceptsChangeNoteOfExactlyMaxBytes` |
| ROR_18 | ShieldedPool.sol:382 | `if (pub.changeCommitment > 0) {` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_8 | ShieldedPool.sol:393 | `if (true) token.safeTransfer(pub.recipient, toRecipient);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| ROR_19 | ShieldedPool.sol:393 | `if (toRecipient > 0) token.safeTransfer(pub.recipient, toRecipient);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| ROR_20 | ShieldedPool.sol:393 | `if (toRecipient >= 0) token.safeTransfer(pub.recipient, toRecipient);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| MIA_9 | ShieldedPool.sol:394 | `if (true) token.safeTransfer(msg.sender, pub.relayerFee);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| ROR_21 | ShieldedPool.sol:394 | `if (pub.relayerFee > 0) token.safeTransfer(msg.sender, pub.relayerFee);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| ROR_22 | ShieldedPool.sol:394 | `if (pub.relayerFee >= 0) token.safeTransfer(msg.sender, pub.relayerFee);` | Equivalent | skips only a zero-amount ERC-20 transfer (gas only) (a token that reverts on zero transfers would differ) |
| ROR_23 | ShieldedPool.sol:415 | `if (capped && capped && held + amount >= cap[asset]) revert CapExceeded(held, amount, cap[asset]);` | Killed | test gap closed: `test_tradeCreditCapIsInclusive` |
| MIA_10 | ShieldedPool.sol:421 | `if (false) revert TransferAmountMismatch(received, amount);` | Killed | test gap closed: `test_tradeCreditRejectsSkewedTransfers` |
| ROR_24 | ShieldedPool.sol:421 | `if (received < amount) revert TransferAmountMismatch(received, amount);` | Killed | test gap closed: `test_tradeCreditRejectsSkewedTransfers` |
| ROR_25 | ShieldedPool.sol:421 | `if (received > amount) revert TransferAmountMismatch(received, amount);` | Killed | test gap closed: `test_tradeCreditRejectsSkewedTransfers` |
| LOR_1 | ShieldedPool.sol:428 | `if (n == 0  &&  notes.length != n) revert BadAmount();` | Killed | test gap closed: `test_tradeInsertRejectsEmptyAndMismatchedBatches` |
| MIA_11 | ShieldedPool.sol:428 | `if (false) revert BadAmount();` | Killed | test gap closed: `test_tradeInsertRejectsEmptyAndMismatchedBatches` |
| ROR_26 | ShieldedPool.sol:428 | `if (n < 0 \|\| notes.length != n \|\| notes.length != n) revert BadAmount();` | Killed | test gap closed: `test_tradeInsertRejectsEmptyAndMismatchedBatches` |
| ROR_27 | ShieldedPool.sol:428 | `if (n <= 0 \|\| notes.length != n \|\| notes.length != n) revert BadAmount();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_28 | ShieldedPool.sol:428 | `if (n == 0 \|\| n == 0 \|\| notes.length < n) revert BadAmount();` | Killed | test gap closed: `test_tradeInsertRejectsEmptyAndMismatchedBatches` |
| ROR_29 | ShieldedPool.sol:428 | `if (n == 0 \|\| n == 0 \|\| notes.length > n) revert BadAmount();` | Killed | test gap closed: `test_tradeInsertRejectsEmptyAndMismatchedBatches` |
| ROR_30 | ShieldedPool.sol:430 | `for (uint256 i; i != n; ++i) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_4 | ShieldedPool.sol:430 | `for (uint256 i; i < n; i++) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| MIA_12 | ShieldedPool.sol:431 | `if (false) revert NoteTooLarge();` | Killed | test gap closed: `test_tradeInsertNoteSizeBoundary` |
| ROR_31 | ShieldedPool.sol:431 | `if (notes[i].length >= MAX_NOTE_BYTES) revert NoteTooLarge();` | Killed | test gap closed: `test_tradeInsertNoteSizeBoundary` |
| ROR_32 | ShieldedPool.sol:431 | `if (notes[i].length == MAX_NOTE_BYTES) revert NoteTooLarge();` | Killed | test gap closed: `test_tradeInsertNoteSizeBoundary` |
| RR_1 | ShieldedPool.sol:433 | `if (leaves[i] == 0) revert();` | Killed | test gap closed: `test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| MIA_13 | ShieldedPool.sol:437 | `if (true) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| MIA_14 | ShieldedPool.sol:437 | `if (false) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| MIA_15 | ShieldedPool.sol:437 | `if (!(root != 0)) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| ROR_33 | ShieldedPool.sol:437 | `if (root < 0) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| ROR_34 | ShieldedPool.sol:437 | `if (root > 0) _publishRoot(root);` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_35 | ShieldedPool.sol:437 | `if (root <= 0) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| ROR_36 | ShieldedPool.sol:437 | `if (root >= 0) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| ROR_37 | ShieldedPool.sol:437 | `if (root == 0) _publishRoot(root);` | Killed | test gap closed: `test_tradeInsertPublishesTheNewRoot / test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero` |
| AOR_0 | ShieldedPool.sol:451 | `return (leafIndex / MAX_LEAVES, leafIndex - MAX_LEAVES);` | Killed | test gap closed: `test_treeOfSplitsTreeAndPosition` |
| RR_2 | ShieldedPool.sol:473 | `revert();` | Killed | test gap closed: `test_depositAcceptsExactlyMaxRawAndTopFieldElement (pendingCount)` |
| ROR_38 | ShieldedPool.sol:480 | `for (uint256 i = nextPending; i != end && limit != 0 && limit != 0; ++i) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_39 | ShieldedPool.sol:480 | `for (uint256 i = nextPending; i < end && i < end && limit > 0; ++i) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_40 | ShieldedPool.sol:480 | `for (uint256 i = nextPending; i < end && i < end && limit >= 0; ++i) {` | Killed | test gap closed: `test_readyCountHonoursLimit` |
| UOR_5 | ShieldedPool.sol:480 | `for (uint256 i = nextPending; i < end && limit != 0; i++) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_41 | ShieldedPool.sol:482 | `if (p.state <= PendingState.Queued) {` | Equivalent | a stored pending entry is never in state None, so `<= Queued` and `== Queued` agree |
| ROR_42 | ShieldedPool.sol:483 | `if (block.timestamp != uint256(p.createdAt) + MIN_PENDING_DELAY) break;` | Killed | test gap closed: `test_insertPendingAndReadyCountLongAfterTheDelay` |
| UOR_6 | ShieldedPool.sol:484 | `ready++;` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_7 | ShieldedPool.sol:486 | `++limit;` | Killed | test gap closed: `test_readyCountHonoursLimit` |
| UOR_8 | ShieldedPool.sol:486 | `limit++;` | Killed | test gap closed: `test_readyCountHonoursLimit` |
| UOR_9 | ShieldedPool.sol:486 | `limit--;` | Equivalent | `limit--` and `--limit` as a statement are the same |
| ROR_43 | ShieldedPool.sol:501 | `if (raw <= 0 \|\| raw > MAX_RAW \|\| raw > MAX_RAW) revert BadAmount();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_44 | ShieldedPool.sol:501 | `if (raw == 0 \|\| raw == 0 \|\| raw >= MAX_RAW) revert BadAmount();` | Killed | test gap closed: `test_depositAcceptsExactlyMaxRawAndTopFieldElement` |
| MIA_16 | ShieldedPool.sol:529 | `if (false) revert TransferAmountMismatch(received, raw);` | Killed | test gap closed: `test_depositRejectsSkewedTransfers` |
| ROR_45 | ShieldedPool.sol:529 | `if (received < raw) revert TransferAmountMismatch(received, raw);` | Killed | test gap closed: `test_depositRejectsSkewedTransfers` |
| ROR_46 | ShieldedPool.sol:529 | `if (received > raw) revert TransferAmountMismatch(received, raw);` | Killed | test gap closed: `test_depositRejectsSkewedTransfers` |
| AOR_1 | ShieldedPool.sol:537 | `uint256 pos = index + MAX_LEAVES;` | Equivalent | only the low 20 bits of `pos` are read over 20 levels; `index + 2^20` has the same low bits |
| ROR_47 | ShieldedPool.sol:538 | `for (uint256 level; level != TREE_DEPTH; ++level) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| UOR_10 | ShieldedPool.sol:538 | `for (uint256 level; level < TREE_DEPTH; level++) {` | Equivalent | loop/increment form (`i != n` for `i < n`, `i++` for `++i`) |
| ROR_48 | ShieldedPool.sol:539 | `if (pos & 1 <= 0) {` | Equivalent | `pos & 1 <= 0` is `pos & 1 == 0` for uint |
| ROR_49 | ShieldedPool.sol:550 | `if (index % MAX_LEAVES >= MAX_LEAVES - 1) {` | Equivalent | `index % MAX_LEAVES` is at most `MAX_LEAVES - 1`, so `>=` and `==` agree |
| AOR_2 | ShieldedPool.sol:552 | `emit TreeArchived(index + MAX_LEAVES, root);` | Killed | test gap closed: `test_treeArchivedEventNamesTheFullTree` |
| AOR_3 | ShieldedPool.sol:552 | `emit TreeArchived(index * MAX_LEAVES, root);` | Killed | test gap closed: `test_treeArchivedEventNamesTheFullTree` |
| AOR_4 | ShieldedPool.sol:552 | `emit TreeArchived(index % MAX_LEAVES, root);` | Killed | test gap closed: `test_treeArchivedEventNamesTheFullTree` |
| ROR_50 | ShieldedPool.sol:578 | `if (uint256(x) > P) revert NotAFieldElement();` | Killed | test gap closed: `test_nullifierEqualToPRejected` |

### PerpMarket

| # | Line | Mutated source line | Verdict | Why |
|---|---|---|---|---|
| LIR_0 | PerpMarket.sol:70 | `uint256 public makerFeeBps = 0;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_1 | PerpMarket.sol:70 | `uint256 public makerFeeBps = 115792089237316195423570985008687907853269984665640564039457584007913129639935;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_2 | PerpMarket.sol:70 | `uint256 public makerFeeBps = 1;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_3 | PerpMarket.sol:72 | `uint256 public borrowBpsPerHour = 0;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_4 | PerpMarket.sol:72 | `uint256 public borrowBpsPerHour = 1157920892373161954235709850086879078532699846656405640394575840079131296...` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_5 | PerpMarket.sol:73 | `uint256 public fundingK = 0; // ~0.1%/h when skew equals the pool` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_6 | PerpMarket.sol:73 | `uint256 public fundingK = 115792089237316195423570985008687907853269984665640564039457584007913129639935; /...` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_7 | PerpMarket.sol:73 | `uint256 public fundingK = 1; // ~0.1%/h when skew equals the pool` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_8 | PerpMarket.sol:75 | `uint256 public maxProfitBps = 0;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_9 | PerpMarket.sol:75 | `uint256 public maxProfitBps = 1;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_10 | PerpMarket.sol:76 | `uint256 public liquidationFee = 0;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_11 | PerpMarket.sol:76 | `uint256 public liquidationFee = 115792089237316195423570985008687907853269984665640564039457584007913129639...` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| LIR_12 | PerpMarket.sol:76 | `uint256 public liquidationFee = 1;` | Killed | test gap closed: `test_defaultParamsBeforeSetParams` |
| MIA_0 | PerpMarket.sol:142 | `if (false) _syncReserve(); // params may be set before the pool lists the market` | Killed | test gap closed: `test_setParamsResyncsTheReserveOfAListedMarket` |
| MIA_1 | PerpMarket.sol:186 | `if (false) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_0 | PerpMarket.sol:186 | `if (p.size < 0) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_1 | PerpMarket.sol:186 | `if (p.size <= 0) revert NoPosition();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_2 | PerpMarket.sol:192 | `if (eq == int256(p.size * MAINTENANCE_BPS / BPS)) revert NotLiquidatable();` | Killed | test gap closed: `test_liquidateHealthyPositionReverts` |
| MIA_2 | PerpMarket.sol:194 | `uint256 reward = true ? Math.min(liquidationFee, uint256(eq)) : 0;` | Killed | test gap closed: `test_liquidateUnderwaterPaysNoReward` |
| RR_0 | PerpMarket.sol:234 | `revert();` | Killed | test gap closed: `test_viewsForAnAccountWithoutPosition` |
| RR_1 | PerpMarket.sol:240 | `if (p.size == 0) revert();` | Killed | test gap closed: `test_viewsForAnAccountWithoutPosition` |
| MIA_3 | PerpMarket.sol:242 | `_foldMem(p, true ? lIdx : sIdx, bIdx);` | Killed | test gap closed: `test_payerViewsMatchLiquidation_*` |
| MIA_4 | PerpMarket.sol:242 | `_foldMem(p, false ? lIdx : sIdx, bIdx);` | Killed | test gap closed: `test_payerViewsMatchLiquidation_*` |
| RR_2 | PerpMarket.sol:252 | `if (p.size == 0) revert();` | Killed | test gap closed: `test_viewsForAnAccountWithoutPosition` |
| RR_3 | PerpMarket.sol:254 | `revert();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| RR_4 | PerpMarket.sol:257 | `revert();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| RR_5 | PerpMarket.sol:258 | `revert();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| RR_6 | PerpMarket.sol:259 | `revert();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_0 | PerpMarket.sol:260 | `int256 out = p.collateral.toInt256() / _cappedNet(x, p.size)` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_1 | PerpMarket.sol:260 | `int256 out = p.collateral.toInt256() * _cappedNet(x, p.size)` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_2 | PerpMarket.sol:260 | `int256 out = p.collateral.toInt256() - _cappedNet(x, p.size)` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_3 | PerpMarket.sol:260 | `int256 out = p.collateral.toInt256() % _cappedNet(x, p.size)` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_4 | PerpMarket.sol:261 | `+ Math.mulDiv(p.size, feeBpsFor(account), BPS, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_5 | PerpMarket.sol:261 | `/ Math.mulDiv(p.size, feeBpsFor(account), BPS, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_6 | PerpMarket.sol:261 | `* Math.mulDiv(p.size, feeBpsFor(account), BPS, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_7 | PerpMarket.sol:261 | `% Math.mulDiv(p.size, feeBpsFor(account), BPS, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| RR_7 | PerpMarket.sol:262 | `revert();` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| RR_8 | PerpMarket.sol:267 | `if (p.size == 0) revert();` | Killed | test gap closed: `test_viewsForAnAccountWithoutPosition` |
| MIA_5 | PerpMarket.sol:269 | `_foldMem(p, true ? lIdx : sIdx, bIdx);` | Killed | test gap closed: `test_payerViewsMatchLiquidation_*` |
| MIA_6 | PerpMarket.sol:269 | `_foldMem(p, false ? lIdx : sIdx, bIdx);` | Killed | test gap closed: `test_payerViewsMatchLiquidation_*` |
| AOR_8 | PerpMarket.sol:278 | `return _sidePnl(longs, true, pr) - _sidePnl(shorts, false, pr);` | Killed | test gap closed: `test_traderPnlSumsBothSides` |
| AOR_9 | PerpMarket.sol:283 | `if (longs.size - shorts.size == 0) return false;` | Killed | test gap closed: `test_staleWithOpenInterestWhenSidesAreEqual` |
| ROR_3 | PerpMarket.sol:283 | `if (longs.size + shorts.size <= 0) return false;` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_7 | PerpMarket.sol:307 | `if (false) revert HasPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_4 | PerpMarket.sol:307 | `if (_positions[account].size < 0) revert HasPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_5 | PerpMarket.sol:307 | `if (_positions[account].size > 0) revert HasPosition();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_8 | PerpMarket.sol:308 | `if (false) revert ZeroSize();` | Killed | test gap closed: `test_entryGuards` |
| ROR_6 | PerpMarket.sol:308 | `if (sizeUsd < 0) revert ZeroSize();` | Killed | test gap closed: `test_entryGuards` |
| ROR_7 | PerpMarket.sol:308 | `if (sizeUsd <= 0) revert ZeroSize();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_10 | PerpMarket.sol:312 | `p.fundingIndex = false ? longFundingIndex : shortFundingIndex;` | Killed | test gap closed: `test_newPositionStartsAtItsOwnSideIndex` |
| MIA_9 | PerpMarket.sol:312 | `p.fundingIndex = true ? longFundingIndex : shortFundingIndex;` | Killed | test gap closed: `test_newPositionStartsAtItsOwnSideIndex` |
| MIA_11 | PerpMarket.sol:324 | `if (false) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_8 | PerpMarket.sol:324 | `if (p.size < 0) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_9 | PerpMarket.sol:324 | `if (p.size <= 0) revert NoPosition();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| ROR_10 | PerpMarket.sol:338 | `if (sizeUsd != 0 && hold && hold) revert Hold();` | Equivalent | duplicated operand (tool quirk) and `!= 0` for `> 0` on uint |
| MIA_12 | PerpMarket.sol:341 | `uint256 feeBps = true ? feeBpsFor(account) : 0;` | Killed | test gap closed: `test_addingMarginNeedsNoSlippageAllowanceAndIgnoresOiCap` |
| MIA_13 | PerpMarket.sol:345 | `if (false) revert CollateralTooLow();` | Killed | test gap closed: `test_collateralBelowFeeAndEqualToFee` |
| ROR_11 | PerpMarket.sol:345 | `if (collateral <= fee) revert CollateralTooLow();` | Killed | test gap closed: `test_collateralBelowFeeAndEqualToFee` |
| ROR_12 | PerpMarket.sol:345 | `if (collateral == fee) revert CollateralTooLow();` | Killed | test gap closed: `test_collateralBelowFeeAndEqualToFee` |
| MIA_14 | PerpMarket.sol:348 | `uint256 tokens = Math.mulDiv(sizeUsd, ONE, pr, true ? Math.Rounding.Floor : Math.Rounding.Ceil);` | Killed | test gap closed: `test_tokensRoundAgainstTheTraderOnOpenAndPartialDecrease` |
| MIA_15 | PerpMarket.sol:348 | `uint256 tokens = Math.mulDiv(sizeUsd, ONE, pr, false ? Math.Rounding.Floor : Math.Rounding.Ceil);` | Killed | test gap closed: `test_tokensRoundAgainstTheTraderOnOpenAndPartialDecrease` |
| ROR_13 | PerpMarket.sol:357 | `if (p.collateral < 0 \|\| p.size > p.collateral * MAX_LEVERAGE \|\| p.size > p.collateral * MAX_LEVERAGE) r...` | Equivalent | drops the `collateral == 0` check, but then `size > 0 * 50` reverts Leverage anyway |
| ROR_14 | PerpMarket.sol:357 | `if (p.collateral <= 0 \|\| p.size > p.collateral * MAX_LEVERAGE \|\| p.size > p.collateral * MAX_LEVERAGE) ...` | Equivalent | drops the `collateral == 0` check, but then `size > 0 * 50` reverts Leverage anyway |
| AOR_10 | PerpMarket.sol:358 | `if (_equity(p, pr) < int256(p.size / MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| AOR_11 | PerpMarket.sol:358 | `if (_equity(p, pr) < int256(p.size % MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| AOR_12 | PerpMarket.sol:358 | `if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS % BPS)) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| MIA_16 | PerpMarket.sol:358 | `if (false) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| ROR_15 | PerpMarket.sol:358 | `if (_equity(p, pr) <= int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| ROR_16 | PerpMarket.sol:358 | `if (_equity(p, pr) == int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_increaseRefusedWhenItLeavesThePositionBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| MIA_17 | PerpMarket.sol:361 | `if (true) {` | Killed | test gap closed: `test_addingMarginNeedsNoSlippageAllowanceAndIgnoresOiCap` |
| ROR_17 | PerpMarket.sol:361 | `if (sizeUsd >= 0) {` | Killed | test gap closed: `test_addingMarginNeedsNoSlippageAllowanceAndIgnoresOiCap` |
| ROR_18 | PerpMarket.sol:361 | `if (sizeUsd != 0) {` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_18 | PerpMarket.sol:382 | `if (false) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_19 | PerpMarket.sol:382 | `if (p.size < 0) revert NoPosition();` | Killed | test gap closed: `test_entryGuards` |
| ROR_20 | PerpMarket.sol:382 | `if (p.size <= 0) revert NoPosition();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| MIA_19 | PerpMarket.sol:383 | `if (false) revert ZeroSize();` | Killed | test gap closed: `test_entryGuards` |
| ROR_21 | PerpMarket.sol:383 | `if (sizeUsd < 0) revert ZeroSize();` | Killed | test gap closed: `test_entryGuards` |
| ROR_22 | PerpMarket.sol:383 | `if (sizeUsd <= 0) revert ZeroSize();` | Equivalent | `== 0`/`!= 0` vs `<= 0`/`> 0` on an unsigned or bytes32 value |
| RR_9 | PerpMarket.sol:384 | `if (sizeUsd > p.size) revert();` | Killed | test gap closed: `test_decreaseLargerThanSizeClosesFully` |
| MIA_20 | PerpMarket.sol:400 | `if (false) {` | Equivalent | the proportional path with `sizeUsd == size` gives exactly the full-close numbers |
| MIA_21 | PerpMarket.sol:403 | `x.tokens = Math.mulDiv(p.tokens, sizeUsd, p.size, true ? Math.Rounding.Floor : Math.Rounding.Ceil);` | Killed | test gap closed: `test_tokensRoundAgainstTheTraderOnOpenAndPartialDecrease` |
| MIA_22 | PerpMarket.sol:403 | `x.tokens = Math.mulDiv(p.tokens, sizeUsd, p.size, false ? Math.Rounding.Floor : Math.Rounding.Ceil);` | Killed | test gap closed: `test_tokensRoundAgainstTheTraderOnOpenAndPartialDecrease` |
| AOR_13 | PerpMarket.sol:416 | `p.accruedFunding += x.funding;` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| AOR_14 | PerpMarket.sol:416 | `p.accruedFunding *= x.funding;` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| AOR_15 | PerpMarket.sol:417 | `p.accruedBorrow += x.borrow;` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| AOR_16 | PerpMarket.sol:417 | `p.accruedBorrow *= x.borrow;` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| ROR_23 | PerpMarket.sol:420 | `if (out > 0) {` | Equivalent | `out == 0` pays 0 either way (the other branch computes a zero shortfall) |
| MIA_23 | PerpMarket.sol:422 | `} else if (false) {` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin` |
| MIA_24 | PerpMarket.sol:425 | `if (true) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| MIA_25 | PerpMarket.sol:425 | `if (false) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| MIA_26 | PerpMarket.sol:425 | `if (!(shortfall > p.collateral)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| ROR_24 | PerpMarket.sol:425 | `if (shortfall < p.collateral) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| ROR_25 | PerpMarket.sol:425 | `if (shortfall <= p.collateral) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| ROR_26 | PerpMarket.sol:425 | `if (shortfall >= p.collateral) revert Liquidatable();` | Gap (boundary) | shortfall exactly equal to the margin: the original then reverts Leverage (margin 0), the mutant Liquidatable; only the revert reason differs |
| ROR_27 | PerpMarket.sol:425 | `if (shortfall == p.collateral) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| ROR_28 | PerpMarket.sol:425 | `if (shortfall != p.collateral) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin / test_partialDecreaseShortfallAboveMarginRefused` |
| RR_10 | PerpMarket.sol:426 | `revert();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin` |
| RR_11 | PerpMarket.sol:427 | `revert();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin` |
| RR_12 | PerpMarket.sol:428 | `revert();` | Killed | test gap closed: `test_partialDecreaseShortfallTakenFromMargin` |
| MIA_27 | PerpMarket.sol:431 | `if (false) {` | Killed | test gap closed: `test_fullCloseDeletesThePosition` |
| MIA_28 | PerpMarket.sol:434 | `if (false) revert Leverage();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestExceedsMaxLeverage` |
| ROR_29 | PerpMarket.sol:434 | `if (p.size >= p.collateral * MAX_LEVERAGE) revert Leverage();` | Gap (boundary) | remaining position at exactly 50x after a shortfall; needs an exact-equality fixture |
| ROR_30 | PerpMarket.sol:434 | `if (p.size == p.collateral * MAX_LEVERAGE) revert Leverage();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestExceedsMaxLeverage` |
| AOR_17 | PerpMarket.sol:435 | `if (_equity(p, pr) < int256(p.size / MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| AOR_18 | PerpMarket.sol:435 | `if (_equity(p, pr) < int256(p.size % MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| AOR_19 | PerpMarket.sol:435 | `if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS % BPS)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| MIA_29 | PerpMarket.sol:435 | `if (false) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| ROR_31 | PerpMarket.sol:435 | `if (_equity(p, pr) <= int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| ROR_32 | PerpMarket.sol:435 | `if (_equity(p, pr) == int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();` | Killed | test gap closed: `test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance / test_equityExactlyAtMaintenanceStillTrades` |
| ROR_33 | PerpMarket.sol:446 | `if (net >= cap) net = cap;` | Equivalent | `net >= cap` assigns `cap` when they are equal |
| AOR_20 | PerpMarket.sol:454 | `side.tokens += tokens;` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout / test_fullCloseDeletesThePosition` |
| AOR_21 | PerpMarket.sol:454 | `side.tokens /= tokens;` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout / test_fullCloseDeletesThePosition` |
| AOR_22 | PerpMarket.sol:454 | `side.tokens *= tokens;` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout / test_fullCloseDeletesThePosition` |
| AOR_23 | PerpMarket.sol:454 | `side.tokens %= tokens;` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout / test_fullCloseDeletesThePosition` |
| MIA_30 | PerpMarket.sol:464 | `if (false) return;` | Equivalent | the same-block early return is an optimisation: recomputing with dt = 0 changes no state |
| ROR_34 | PerpMarket.sol:464 | `if (block.timestamp < lastAccrual) return;` | Equivalent | the same-block early return is an optimisation: recomputing with dt = 0 changes no state |
| ROR_35 | PerpMarket.sol:464 | `if (block.timestamp <= lastAccrual) return;` | Equivalent | `<=` and `==` agree (time never goes back) |
| MIA_31 | PerpMarket.sol:466 | `if (false) {` | Killed | test gap closed: `test_fundingIndexAndTotalsWhenLongsPay` |
| ROR_36 | PerpMarket.sol:466 | `if (lIdx >= longFundingIndex) {` | Equivalent | the extra branch runs only when the index did not move and adds `size x 0` |
| ROR_37 | PerpMarket.sol:466 | `if (lIdx == longFundingIndex) {` | Killed | test gap closed: `test_fundingIndexAndTotalsWhenLongsPay` |
| MIA_32 | PerpMarket.sol:469 | `} else if (true) {` | Equivalent | the extra branch runs only when no index moved and adds `size x 0` |
| MIA_33 | PerpMarket.sol:469 | `} else if (false) {` | Killed | test gap closed: `test_fundingTotalsWhenShortsPay` |
| MIA_34 | PerpMarket.sol:469 | `} else if (!(sIdx > shortFundingIndex)) {` | Killed | test gap closed: `test_fundingTotalsWhenShortsPay` |
| ROR_38 | PerpMarket.sol:469 | `} else if (sIdx < shortFundingIndex) {` | Killed | test gap closed: `test_fundingTotalsWhenShortsPay` |
| ROR_39 | PerpMarket.sol:469 | `} else if (sIdx <= shortFundingIndex) {` | Killed | test gap closed: `test_fundingTotalsWhenShortsPay` |
| ROR_40 | PerpMarket.sol:469 | `} else if (sIdx >= shortFundingIndex) {` | Equivalent | the extra branch runs only when the index did not move and adds `size x 0` |
| ROR_41 | PerpMarket.sol:469 | `} else if (sIdx == shortFundingIndex) {` | Killed | test gap closed: `test_fundingTotalsWhenShortsPay` |
| ROR_42 | PerpMarket.sol:469 | `} else if (sIdx != shortFundingIndex) {` | Equivalent | when the short index fell, longs paid and the first branch already ran |
| AOR_24 | PerpMarket.sol:480 | `uint256 dt = block.timestamp % lastAccrual;` | Equivalent | `t % last == t - last` for any `t < 2 x last` (every real timestamp) |
| MIA_35 | PerpMarket.sol:481 | `if (false) return (lIdx, sIdx, bIdx);` | Equivalent | with dt = 0 every formula below returns the inputs |
| ROR_43 | PerpMarket.sol:481 | `if (dt < 0) return (lIdx, sIdx, bIdx);` | Equivalent | with dt = 0 every formula below returns the inputs |
| ROR_44 | PerpMarket.sol:481 | `if (dt <= 0) return (lIdx, sIdx, bIdx);` | Equivalent | `dt <= 0` is `dt == 0` for uint |
| ROR_45 | PerpMarket.sol:484 | `if (rate <= 0) return (lIdx, sIdx, bIdx);` | Equivalent | `rate <= 0` is `rate == 0` for uint |
| AOR_25 | PerpMarket.sol:485 | `uint256 f = rate + dt; // fraction of size (1e18) the heavy side pays` | Killed | test gap closed: `test_fundingIndexAndTotalsWhenLongsPay` |
| AOR_26 | PerpMarket.sol:485 | `uint256 f = rate - dt; // fraction of size (1e18) the heavy side pays` | Killed | test gap closed: `test_fundingIndexAndTotalsWhenLongsPay` |
| AOR_27 | PerpMarket.sol:499 | `p.accruedFunding += _fundingOwed(p.size, idx + p.fundingIndex);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_28 | PerpMarket.sol:500 | `p.accruedBorrow += Math.mulDiv(p.size, borrowIndex + p.borrowIndex, WAD, Math.Rounding.Ceil);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_29 | PerpMarket.sol:506 | `p.accruedFunding += _fundingOwed(p.size, idx + p.fundingIndex);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_30 | PerpMarket.sol:506 | `p.accruedFunding += _fundingOwed(p.size, idx * p.fundingIndex);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_31 | PerpMarket.sol:506 | `p.accruedFunding *= _fundingOwed(p.size, idx - p.fundingIndex);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_32 | PerpMarket.sol:506 | `p.accruedFunding -= _fundingOwed(p.size, idx - p.fundingIndex);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_33 | PerpMarket.sol:507 | `p.accruedBorrow += Math.mulDiv(p.size, bIdx + p.borrowIndex, WAD, Math.Rounding.Ceil);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_34 | PerpMarket.sol:507 | `p.accruedBorrow += Math.mulDiv(p.size, bIdx * p.borrowIndex, WAD, Math.Rounding.Ceil);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_35 | PerpMarket.sol:507 | `p.accruedBorrow *= Math.mulDiv(p.size, bIdx - p.borrowIndex, WAD, Math.Rounding.Ceil);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| AOR_36 | PerpMarket.sol:507 | `p.accruedBorrow -= Math.mulDiv(p.size, bIdx - p.borrowIndex, WAD, Math.Rounding.Ceil);` | Killed | test gap closed: `test_exitValueOfMatchesClosePayout` |
| ROR_46 | PerpMarket.sol:514 | `if (delta > 0) return Math.mulDiv(size, uint256(delta), WAD, Math.Rounding.Ceil).toInt256();` | Equivalent | delta 0 gives 0 on both paths |
| MIA_36 | PerpMarket.sol:535 | `if (false) return 0;` | Equivalent | an empty side has 0 PnL and a 0 cap without the early return |
| ROR_47 | PerpMarket.sol:535 | `if (s.size < 0) return 0;` | Equivalent | an empty side has 0 PnL and a 0 cap without the early return |
| ROR_48 | PerpMarket.sol:535 | `if (s.size <= 0) return 0;` | Equivalent | `s.size <= 0` is `== 0` for uint |
| AOR_37 | PerpMarket.sol:537 | `int256 cap = (s.size + maxProfitBps / BPS).toInt256();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| AOR_38 | PerpMarket.sol:537 | `int256 cap = (s.size - maxProfitBps / BPS).toInt256();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| AOR_39 | PerpMarket.sol:537 | `int256 cap = (s.size * maxProfitBps + BPS).toInt256();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| AOR_40 | PerpMarket.sol:537 | `int256 cap = (s.size * maxProfitBps * BPS).toInt256();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| AOR_41 | PerpMarket.sol:537 | `int256 cap = (s.size * maxProfitBps - BPS).toInt256();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| RR_13 | PerpMarket.sol:538 | `if (v > cap) revert();` | Killed | test gap closed: `test_traderPnlAppliesTheProfitCap` |
| ROR_49 | PerpMarket.sol:539 | `if (v <= -s.collateral.toInt256()) v = -s.collateral.toInt256();` | Equivalent | assigns the same value at equality |
| MIA_37 | PerpMarket.sol:553 | `if (true) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| MIA_38 | PerpMarket.sol:553 | `if (false) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| MIA_39 | PerpMarket.sol:553 | `if (!(x >= 0)) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| ROR_50 | PerpMarket.sol:553 | `if (x < 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| ROR_51 | PerpMarket.sol:553 | `if (x > 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Equivalent | x = 0 gives 0 on both paths |
| ROR_52 | PerpMarket.sol:553 | `if (x <= 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| ROR_53 | PerpMarket.sol:553 | `if (x == 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| ROR_54 | PerpMarket.sol:553 | `if (x != 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
| RR_14 | PerpMarket.sol:554 | `revert();` | Killed | test gap closed: `test_partialDecreaseSplitsAccruedFundingBothSigns` |
