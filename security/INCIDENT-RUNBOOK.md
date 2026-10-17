# Incident runbook

What to do when something is wrong on mainnet: who acts, which lever to pull, how users get out, and how to tell
them. Roles and addresses are in [SECURITY.md](../SECURITY.md). Every lever below is a single transaction from OWNER
unless noted; none of them can block a user's exit.

## 1. Triage (first 15 minutes)

1. Confirm the report against the chain, not the UI: `cd app && bun run verify:deployment` (owners, roles, wiring,
   feeds, caps) and the explorer / RPC for the transactions in question.
2. Classify:
   - **SEV-1** funds at risk or being taken now, or a proof / accounting break;
   - **SEV-2** exits or deliveries stuck, an oracle or pool misbehaving, a bot key suspected;
   - **SEV-3** service outage with funds safe (API, indexer, relayer down).
3. Open a private GitHub security advisory on the repository as the incident record (timeline, transactions,
   decisions). Keep the details private until users are safe.

## 2. Contain

Pick the narrowest lever that stops the damage. Run from a machine holding the OWNER key (`cast send` with the
keystore; never paste a key into a shell).

| Situation | Lever | Command (OWNER) |
| --- | --- | --- |
| Hidden Vault deposits or trades at risk | Pause deposits, buy, sell and park | `cast send <shieldedPool> "setDepositsPaused(bool)" true` |
| Hidden Vault exposure too large | Lower an asset cap (applies at once) | `cast send <shieldedPool> "proposeCap(address,uint256)" <asset> <cap>` |
| A park adapter misbehaves | Stop new parks (unpark keeps working) | `cast send <shieldedTrade> "disablePark(address)" <adapter>` |
| A Stock Token, feed or pool is wrong or halted | Delist: stops buys, sells, crowd execution, new perp opens | `cast send <stockTokenRegistry> "delist(address)" <token>` |
| The market is closed unexpectedly (holiday, halt) | Hold prices for those days (v2) | `cast send <valuer> "closeDays(uint256[])" ...` |
| A perp market is exploited | No new opens: `oiCapBps = 0` (keep the other params) | `cast send <perpMarket> "setParams(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)" ...` |
| A perp market must be wound down (v2) | Retire it: opens stop now, anyone settles each position at a fresh price after 48 h, then remove it | `cast send <perpMarket> "retire()"`, then `settleRetired(account)` per position and `PerpPool.removeMarket` |
| The keeper key is compromised or the keeper misbehaves | Stop the keeper paths at once, queue the new keeper | `setKeeper(0)` on CrowdBuy and SavingsVault (instant; books run through the public fallback); `setKeeper(<new>)` on all three (v2: queued, applies 48 h later with the same call) |
| The attester key is compromised | Rotate (stored records stay; revoke bad ones) | `cast send <eligibilityRegistry> "setAttester(address)" <new>` (v2: queued, applies 48 h later with the same call; until then the old attester can still revoke and attest); `revoke(user)` from the new attester |
| The relayer key is compromised | Stop the relayer service; it has no on-chain role | Rotate `RELAYER` in the service env; drain its gas balance |
| A desk key or controller is compromised (treasury) | The board revokes the desk / cancels the policy / withdraws | Board: `revokeDesk`, `cancel`, `withdrawToBoard` |
| OWNER key suspected compromised | Move ownership first, then everything else | `transferOwnership(<new owner>)` on every ownable contract (two-step ones need `acceptOwnership` from the new owner). In v2 an ownership change voids every queued ChangeDelay change; perps proposals survive it, so the new owner `cancel`s any it did not make (watch `ChangeProposed` on the pool and markets) |

Then stop the affected service so it does not keep sending: `bash app/scripts/mainnet/down.sh` (or the single
systemd unit on the server).

## 3. Get users out

Exits never depend on the levers above:

- Savers: `SavingsVault.withdraw`, `CrowdBuy.cancel` and `claimOpen`, Quiet claims through `StealthClaims` (gasless through
  the relayer, or `claimDirect`).
- Hidden Vault: `withdraw`, `transfer`, `refundPending` and unpark keep working while deposits are paused.
- Perp traders close positions; LPs redeem after the cooldown. A held market with open interest holds LP exits for up
  to 5 days (v2; then it stops blocking them and anyone may `settleHeld`), and on v1 for as long as the hold lasts
  (the audit's M-2).
- Treasury boards: `withdrawToBoard` is never gated.

If the web app or API is down, publish the direct contract calls (addresses from `app/deployments/4663.json`) and
the SDK snippets for withdraw and claim. The relayer is optional for every exit.

## 4. Communicate

- Within 1 hour of a SEV-1 or SEV-2: a short status on the project's official channels: what is affected, that exits
  work and how, what users should not do. No speculation, no blame.
- Updates at least every 4 hours until resolved; a post-mortem within 7 days (timeline, root cause, fix, the test
  that now covers it), published with the advisory once users are safe.
- Reporters are credited if they want to be.

## 5. Recover

1. Fix with a failing-then-passing test (a Foundry test reproducing the exploit), reviewed like any contract change.
2. For a contract bug: redeploy (no contract is upgradeable), run the fork dry run of the deploy script, deploy,
   accept ownership, then `bun run release:gate` (forge `verifyDeploymentStrict` + `verify:deployment --strict`:
   fails while any hand-over is pending) and `bun run verify:explorer` against the new `app/deployments/4663.json`,
   and regenerate the README section (`python3 .github/scripts/readme-deployments.py`).
3. Unwind the levers (unpause, raise caps through their timelock) only after the post-deploy checks pass.
4. Record the incident and the fix in [AUDITS.md](AUDITS.md).

## Contacts and keys

- OWNER signs every lever above. Keep its key offline. The live v1 OWNER is an EOA; the v2 deploy script expects a
  contract (a Safe) unless an EOA is explicitly allowed (SECURITY.md).
- Bot keys (keeper, attester, relayer, controller, desks) each live only with their own service and can be rotated
  without a redeploy.
- Security reports arrive through GitHub private vulnerability reporting on the repository.
