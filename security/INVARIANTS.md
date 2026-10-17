# Invariants

Each property in words, and the test that checks it. Stateful invariant suites run random call sequences against a
handler; CI runs every one at 256 runs x 500 calls = **128,000 calls** (`FOUNDRY_PROFILE=ci`, set inline per suite
and in `contracts/foundry.toml`). Local `forge test` uses smaller default values for speed.

```sh
cd contracts
FOUNDRY_PROFILE=ci forge test --match-path 'test/**/*nvariant*'   # every suite at >= 100k calls
```

## Stateful invariant suites

| Module | Invariant (in words) | Test |
| --- | --- | --- |
| SavingsVault | The vault always holds at least the sum of every account's available and pending USDG | [`invariant_R8_balanceCoversAllAccounts`](../contracts/test/consumer/SavingsVault.invariant.t.sol) |
| | A week's round-ups never exceed the saver's weekly cap | [`invariant_R2_weeklyCapHolds`](../contracts/test/consumer/SavingsVault.invariant.t.sol) |
| CrowdBuy | USDG held equals the open orders exactly; Stock Tokens held cover every unclaimed allocation plus dust; no book is over-allocated | [`invariant_R9_balancesCoverObligations`](../contracts/test/consumer/CrowdBuy.invariant.t.sol) |
| | For every settled book, allocations round down and the dust is exactly the remainder | [`invariant_R3_dustIsExactForSettledBooks`](../contracts/test/consumer/CrowdBuy.invariant.t.sol) |
| ShieldedPool (Hidden Vault) | Per asset, the pool's balance covers every unspent note plus pending deposits | [`invariant_poolCoversUnspentNotes`](../contracts/test/consumer/ShieldedPool.invariant.t.sol) |
| | No nullifier is ever spent twice | [`invariant_noNullifierSpentTwice`](../contracts/test/consumer/ShieldedPool.invariant.t.sol) |
| PerpPool / PerpMarket | The pool always reserves every open trader's maximum profit | [`invariant_poolCoversMaxTraderProfit`](../contracts/test/perps/PerpInvariant.t.sol) |
| | The pool's reserves and trader collateral equal the sum over markets and positions, and its USDG covers the collateral | [`invariant_bookkeepingMatches`](../contracts/test/perps/PerpInvariant.t.sol) |
| Treasury (mock sleeves) | After every successful desk operation each band holds, or moved strictly closer from the same side | [`invariant_bandsHoldOrImproveAfterEverySuccess`](../contracts/test/treasury/TreasuryInvariant.t.sol) |
| | Notional executed in any trailing 24 h never exceeds the day cap | [`invariant_dayCapNeverExceeded`](../contracts/test/treasury/TreasuryInvariant.t.sol) |
| | The board can always withdraw everything | [`invariant_boardCanAlwaysWithdraw`](../contracts/test/treasury/TreasuryInvariant.t.sol) |
| Treasury (real CashSleeve and EquitySleeve, StockRouter, ERC-4626 vault) | Bands hold or improve after every success, under oracle moves, pool drift, vault yield, stale feeds and slippage | [`invariant_bandsHoldOrImproveAfterEverySuccess`](../contracts/test/treasury/TreasuryRealSleeves.invariant.t.sol) |
| | Day and per-order caps are never exceeded | [`invariant_dayAndOrderCapsNeverExceeded`](../contracts/test/treasury/TreasuryRealSleeves.invariant.t.sol) |
| | NAV lost in any successful operation is at most `maxOpLossBps` x notional | [`invariant_navLossPerOpBounded`](../contracts/test/treasury/TreasuryRealSleeves.invariant.t.sol) |
| | The sleeves never keep a balance, share or allowance | [`invariant_sleevesKeepNothing`](../contracts/test/treasury/TreasuryRealSleeves.invariant.t.sol) |
| | The board can always withdraw USDG, vault shares and every Stock Token | [`invariant_boardCanAlwaysWithdraw`](../contracts/test/treasury/TreasuryRealSleeves.invariant.t.sol) |
| PlinthStaking | Supply counters equal the sum over stakers | [`invariant_totalsEqualSumOfStakers`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | PLTH balance is exactly staked + unbonding + rewards notified - rewards claimed | [`invariant_plthBalanceConserved`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | Balances cover principal plus every staker's claimable reward, per token | [`invariant_balancesCoverStakeAndClaimable`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | Claimed + claimable never exceeds what was funded | [`invariant_noRewardsBeyondFunding`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | Rewards are lost only to rounding dust (at most 2 wei per call) | [`invariant_rewardsLostOnlyToRounding`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | Each staker's tier matches their stake | [`invariant_tierMatchesStake`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | Unbonding cannot be withdrawn early and pays exactly the unbonding amount | [`invariant_noEarlyWithdraw`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| | `claim` pays exactly what `earned` showed; a just-in-time stake earns nothing | [`invariant_claimMatchesEarnedAndNoJit`](../contracts/test/token/PlinthStaking.invariant.t.sol) |
| FeeRouter (real staking and insurance pool) | Every USDG received went to stakers, insurance, the buyback or a template author, or is still held | [`invariant_usdgConserved`](../contracts/test/token/FeeRouter.invariant.t.sol) |
| | The counterparties' balances moved by exactly the router's flows | [`invariant_counterpartiesReceivedExactly`](../contracts/test/token/FeeRouter.invariant.t.sol) |
| | The router never holds unaccounted USDG; the author ledger is exact | [`invariant_noUnaccountedUsdg`](../contracts/test/token/FeeRouter.invariant.t.sol) |
| | No split exceeds its configured share | [`invariant_splitsWithinConfiguredBps`](../contracts/test/token/FeeRouter.invariant.t.sol) |
| | The buyback spends at most its per-push slice and never fills below its floor | [`invariant_buybackWithinSlice`](../contracts/test/token/FeeRouter.invariant.t.sol) |
| ExceptionInsurancePool | No action but a paid claim lowers anyone's value | [`invariant_noActionButAClaimLowersAnyonesValue`](../contracts/test/token/ExceptionInsurancePool.invariant.t.sol) |
| | No LP action shifts value between other LPs | [`invariant_noLpActionShiftsValueBetweenOthers`](../contracts/test/token/ExceptionInsurancePool.invariant.t.sol) |
| | Fees never reach LPs who are withdrawing | [`invariant_feesNeverReachWithdrawers`](../contracts/test/token/ExceptionInsurancePool.invariant.t.sol) |
| | A withdrawal pays the lower of its value at request and now | [`invariant_withdrawalPaysMinOfRequestAndNow`](../contracts/test/token/ExceptionInsurancePool.invariant.t.sol) |
| | The pool can pay everyone it owes | [`invariant_poolCanPayEveryone`](../contracts/test/token/ExceptionInsurancePool.invariant.t.sol) |

**Hidden Vault and proofs.** The ShieldedPool suite uses a mock verifier on purpose: it checks the pool's accounting
under random sequences, not proof soundness. Soundness is checked with the real generated UltraHonk verifiers and
real proofs from the circuit fixtures in [`ShieldedPoolProofs.t.sol`](../contracts/test/consumer/ShieldedPoolProofs.t.sol),
[`verifiers/HiddenVerifiers.t.sol`](../contracts/test/consumer/verifiers/HiddenVerifiers.t.sol) and
[`ThresholdVerifier.t.sol`](../contracts/test/consumer/ThresholdVerifier.t.sol), and in the Noir tests of every
circuit (`circuits/*/src`, `nargo test`). CI also rebuilds the verifiers from the circuits and fails on any change.

## Properties checked by targeted tests

| Property | Test |
| --- | --- |
| Exits are never blocked by eligibility (expired or revoked users still withdraw, cancel and claim) | [`test_revokedUserCanExitEverything`, `test_joinRequiresEligibility_expiredRevertsExitWorks`](../contracts/test/consumer/EligibilityGate.t.sol) |
| The Hidden Vault pause stops deposits only; exits work even after the owner renounces | [`test_pauseStopsDepositsOnly`, `test_exitsWorkAfterOwnerRenouncesAndCrowdIsGone`](../contracts/test/consumer/ShieldedPool.t.sol) |
| A nullifier is single-use across transfer and withdraw | [`test_nullifierSingleUseAcrossTransferAndWithdraw`](../contracts/test/consumer/ShieldedPool.t.sol) |
| A withdraw proof binds recipient, fee and amount; a relayer cannot redirect or raise its fee | [`test_realWithdrawBindsRecipientFeeAndAmount`](../contracts/test/consumer/ShieldedPoolProofs.t.sol), [`test_relayerCannotRedirectOrRaiseFee`](../contracts/test/consumer/verifiers/HiddenVerifiers.t.sol) |
| Stealth claims cannot be replayed | [`test_claim_replayReverts`](../contracts/test/consumer/StealthClaims.t.sol) |
| A stale feed blocks router buys and sells | [`test_R2_staleFeedBlocksBuyAndSell`](../contracts/test/core/StockRouter.t.sol) |
| A treasury operation hash binds every input; tickets are single-use | [`test_opHash_bindsEveryInput`](../contracts/test/treasury/TreasuryAccount.t.sol), [`test_buyAboveApprovalNeedsTicket`](../contracts/test/treasury/sleeves/EquitySleeve.t.sol) |
| A policy activates exactly after its timelock | [`testFuzz_policy_activationWaitsExactlyTimelock`](../contracts/test/core/DeployTimers.t.sol) |
| A held market with no open interest does not block LPs | [`test_S11_heldMarketWithoutOpenInterestDoesNotBlock`](../contracts/test/perps/PerpSecurity.t.sol) |
| The mainnet deploy hands every role to OWNER and proposes unlimited caps behind the timelock | [`MainnetBeta.t.sol`](../contracts/test/script/MainnetBeta.t.sol) |

## Live deployment

The same properties are asserted against the chain after a deploy and daily in CI: `cd app && bun run
verify:deployment` (owners, roles, wiring, timers, feeds, pools, caps) and `bun run verify:explorer` (runtime
bytecode equals the recorded source).
