# @plynth/sdk

Client-side privacy tools for Plynth on Robinhood Chain. Everything here runs on the user's device; keys never
leave it.

| Import | What it does |
| --- | --- |
| `@plynth/sdk/stealth` | ERC-5564 / ERC-6538 stealth addresses: meta-addresses, scanning announcements, relayed claims. |
| `@plynth/sdk/vault` | Hidden Vault: keys from one wallet signature, encrypted notes, local tree sync, Noir proofs, ShieldedPool transactions. |
| `@plynth/sdk/statements` | Viewing-key statements and scoped disclosure for Hidden Vault notes. |

## Statements

```ts
import { statement, statementToHtml, statementToCsv, statementToJson, viewingKeyOf } from "@plynth/sdk/statements";

const s = await statement(publicClient, keys, { fromBlock, toBlock }, {
  chainId, pool, deployBlock, valuer, stables: [usdg],
});
statementToHtml(s); // one self-contained page: inline CSS, no scripts, no external requests
```

A statement decrypts the user's notes from `ShieldedPool` events and reports, for an inclusive block range:

- per asset: opening balance, in, out, closing balance (closing = opening + in - out, checked), and deposits still
  pending at period end;
- the closing balance valued at the period's last block: Stock Tokens through the on-chain `Valuer`
  (raw x ERC-8056 multiplier x price feed, multiplier applied once), tokens listed in `stables` at 1 USD, anything
  without a usable price shown with no USD value and `hold: true`;
- every movement in the period: deposits queued, notes entering the tree (deposit, received, change), spends,
  refunds of pending deposits.

The API's `GET /v1/statements/:address` lists monthly periods (block ranges) for an address that registered
Hidden keys. It never sees a key; the client builds the statement.

### What a viewing key sees

`viewingKeyOf(keys)` returns only `{ viewingSecret, ownerPk }`. With it, a statement opens every note sent to the
user, but **it cannot see spends**: a nullifier is `Poseidon2(commitment, spendingSecret, leafIndex)`, so only
the spending secret can tell which notes were spent. Such a statement has `spendsVisible: false`, note status
`unknown`, and balances that count every received note. The owner's own statement (full keys) is exact.
Handing someone the viewing key reveals every past and future note to that person; use scoped disclosure when
that is too much.

## Scoped disclosure

```ts
const bundle = discloseNotes(chosenNotes, period, { chainId, pool, history });
const verdict = await verifyDisclosure(publicClient, bundle, { pool, deployBlock });
// or POST /v1/statements/verify with the bundle (stateless)
```

A bundle opens chosen notes (asset, raw, ownerPk, blinding, leafIndex) with a Merkle path to the pool's root at
the end of the period, plus each note's nullifier. The verifier recomputes every commitment, checks the path
reaches that root, checks the root really was the pool's root at period end (the last `RootUpdated` at or
before the period's last block), and looks each nullifier up in `NullifierSpent` events
(`unspent`, `spent`, `spent-after-period`). Changing any field (amount, blinding, leaf, root) fails the check.
No key is shared.

### Linking limits: what a disclosure gives away

- **The note's history.** A disclosed commitment is public on-chain. If it came from a deposit, `DepositQueued`
  shows the funding address (the origin) and the amount in clear, so the verifier links the note to that
  address. Its leaf index and insertion transaction are linked too.
- **Where it went.** A disclosed nullifier links the note to the transaction that spent it. That transaction's
  other public data (the other nullifier, output commitments, and for a withdraw the asset, amount, recipient
  and relayer fee) becomes linkable to the user, though output amounts and owners of a transfer stay hidden.
- **Same owner.** Every note in one bundle shows the same `ownerPk`, and `ownerPk` is the same for all of a
  user's notes. Two bundles given to two verifiers can be joined by anyone who sees both. A user who registered
  Hidden delivery has their `ownerPk` on-chain next to their address (`SavingsVault.setHiddenKeys`), so a bundle
  names that address too. Notes not disclosed stay hidden.
- **Nullifiers are attested, not proven.** The verifier cannot recompute a nullifier without the spending
  secret, so it cannot check the disclosed nullifier belongs to the note. A dishonest discloser could hand over
  an unrelated nullifier to make a spent note look unspent. Treat `unspent` as the owner's claim; `spent` for a
  real nullifier is only as strong as that same claim. A small proof binding nullifier to note is the fix.
- **Knowledge, not ownership.** A valid bundle shows the discloser knows the note's opening. Anyone the owner
  ever gave the opening to (a past verifier, the sender of a transfer) can produce the same bundle.
- **Point in time.** Membership is shown against the root at period end. A note inserted earlier than the
  period is still included; the verdict does not say when inside the period the note arrived.
