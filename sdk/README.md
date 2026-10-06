# @plynth/sdk

Privacy kit for Robinhood Chain: stealth delivery, a crowd-buy engine, shielded deposits (the Hidden Vault),
disclosure tools and a relayer client. Apps use the modules that fit their own flow. Everything runs on the
user's device; keys never leave it.

| Import | What it does |
| --- | --- |
| `@plynth/sdk/stealth` | ERC-5564 / ERC-6538 stealth addresses: meta-addresses, registration, announcement metadata, scanning, relayed StealthClaims claims. |
| `@plynth/sdk/crowd` | Crowd-buy engine (CrowdBuy + SavingsVault): deposit, settings, mix, join, cancel, execute, open claim; the contract's split/allocation/window arithmetic; recompute a book's allocations from logs alone. |
| `@plynth/sdk/vault` | Hidden Vault: keys from one wallet signature, encrypted notes, local tree sync, Noir proofs, ShieldedPool deposits/transfers/withdraws, private sell/buy/park (ShieldedTrade). |
| `@plynth/sdk/statements` | Viewing-key statements, scoped disclosure and threshold proofs for Hidden Vault notes. |
| `@plynth/sdk/relayer` | Client for a Plynth relayer: gasless stealth claims (`/claim`) and vault withdraws (`/withdraw`). |
| `@plynth/sdk` | All of the above as namespaces (`stealth`, `crowd`, ...) plus the network defaults. |

## Using it

- **Tree-shakeable entry points.** Each module is its own ESM entry with types; `sideEffects: false`. Only
  `/vault` and `/statements` load the proving stack (`@aztec/bb.js`, `@noir-lang/noir_js`); `/stealth`,
  `/crowd` and `/relayer` never import it.
- **No network side effects.** Importing any entry makes no request and starts nothing. Reads take a viem
  `PublicClient` you create; writes are returned as unsigned `{ to, data }` for your wallet to send; relayer
  calls take an optional `fetch` so you control the transport.
- **Chain and addresses are arguments.** Every function takes the contract addresses it touches.
  `publicInfra("mainnet" | "testnet")` gives the verified defaults for third-party contracts (USDG, the
  ERC-5564 Announcer, the ERC-6538 Registry, Multicall3, Permit2; chain ids 4663 / 46630).
  Plynth's own contracts have no canonical addresses yet: `parseDeployment(json)` reads a deployment file
  written by the deploy scripts.
- **Runtime.** ESM only. Needs `BigInt`, WebCrypto and a global `Buffer` (Bun and Node have them; add a
  `buffer` polyfill in browsers). Proving needs WebAssembly and about 1 s per proof on a laptop.

```ts
import { computeStealthAddress, encodeMetadata, registerTx } from "@plynth/sdk/stealth";
import { joinTx, recomputeBook } from "@plynth/sdk/crowd";
import { submitClaim } from "@plynth/sdk/relayer";
import { publicInfra } from "@plynth/sdk";
const { erc5564Announcer, erc6538Registry } = publicInfra("mainnet");
```

## Examples

`examples/` has three runnable Bun scripts. With no environment they start their own anvil on a free port in
8550-8599, deploy the local kit (`contracts/script/LocalConsumer.s.sol`: mock USDG, mock Stock Tokens with
price feeds, the core contracts, SavingsVault, CrowdBuy, StealthClaims, ShieldedPool with the real verifiers;
the canonical Permit2, ERC-5564 Announcer and ERC-6538 Registry bytecode is etched at their real addresses),
run, and stop anvil. They need `anvil` and `forge` on PATH and the repo checked out (they run from it).

| Script | Flow |
| --- | --- |
| `bun examples/send-to-stealth.ts` | Recipient registers an ERC-6538 meta-address; a sender derives a one-time stealth address from it, pays mUSDG there and announces it; the recipient scans with the viewing key, derives the stealth key and moves the funds. |
| `bun examples/crowd-join.ts` | Three savers deposit, pick a mix, get round-ups accrued; anyone joins them to the open book; the window's jittered time is revealed at that time; the keeper executes; allocations recomputed from logs match `allocationOf`; each saver claims. |
| `bun examples/shield-and-withdraw.ts` | Keys from one signature; deposit mUSDG into ShieldedPool; the 1 h pending queue is inserted; the note is found by scanning; a withdraw proof is made locally and a different account (a relayer) submits it to a fresh address. |

To run against an anvil you already deployed the kit on, set `RPC_URL` and `PLYNTH_DEPLOYMENT` (path to the
JSON the deploy script printed after `PLYNTH_DEPLOYMENT `). The examples use anvil's unlocked dev accounts and
time travel (`evm_setNextBlockTimestamp`); they never sign with a real key.

## Trust assumptions and limits

Read these before shipping any of it.

- **Unaudited.** None of the contracts or circuits have been audited. The Hidden Vault's per-asset deposit
  caps start at 0 and only rise through a 48 h timelock; the mainnet deploy script refuses a non-zero cap.
  **Mainnet cap is 0** until an audit: on 4663 the vault accepts nothing.
- **Stealth (Quiet) delivery hides the recipient, not the funding.** Deposits into SavingsVault, round-ups and
  CrowdBuy joins are public and name the saver, and `deliver` names the user when their allocation moves into
  StealthClaims. Only the later stealth payouts are unlinkable, and only as far as amounts and timing allow (the
  keeper splits each allocation into random parts across later executions). A user who claims a stealth
  balance straight to their main address, or funds the stealth address's gas from it, links them; use the
  relayer. Stealth addresses cannot be checked on-chain: Quiet users trust the keeper to derive them from their
  meta-address (a wrong one shows up in their own scan as a missing balance).
- **Crowd privacy depends on crowd size.** A book executes only with at least `MIN_CROWD` distinct accounts and
  at a jittered time inside the window, but every join is public. With a small crowd, amounts and allocations
  are easy to attribute; the per-user order and allocation are recomputable by anyone from logs (that is the
  allocation proof). `claimOpen` is always available and always public.
- **Hidden Vault.** Deposits are public (`DepositQueued` shows the funding address and amount); what is hidden
  is which later note, transfer or withdraw belongs to it. The anonymity set is the pool's notes of that asset,
  which is small early on. Withdraw amount, recipient and relayer fee are public. A viewing key reveals every
  past and future incoming note (but not spends). See the sections below for statement, disclosure and
  threshold-proof limits.
- **Relayers.** A relayer sees the request's IP and contents and can refuse or delay it; it cannot change it
  (the claim is signed and the withdraw is proven to a fixed recipient and fee). It does rate limit.
- **Keeper and owner powers** are listed in each contract's NatSpec: the keeper can only settle users who chose
  that delivery mode and cannot redirect Open users; exits (`withdraw`, `claimOpen`, pool withdraws) are never
  gated by eligibility, pause, keeper or owner.

## Building

`bun run build` writes `dist/` (ESM per entry point, shared chunks, `.d.ts`); `npm pack --dry-run` shows the
package holds only `dist/` and this README. Inside this repository the app depends on it as `file:../sdk` and
resolves `@plynth/sdk` to `src/` (`app/tsconfig.json` paths), so nothing needs building to run the app or its
tests; `cd app && bun install` also installs the SDK's dependencies. Not published.

## Private sell, buy and park

```ts
state = await syncPool(pub, pool, state, { trade });              // also reads PartialNoteFilled
const note = myNotes(state, keys).find((n) => n.asset === tsla && !n.spent)!;
const s = await proveSwap({ keys, tree: state.tree, note, amountIn, assetOut: usdg, minOut, deadline, relayerFee });
await send(swapTx(trade, s, 100));                                 // any account (a relayer) can submit
```

- One `swap` proof covers sell (Stock Token -> USDG), buy (USDG -> Stock Token), park (USDG -> park shares) and
  unpark (park shares -> USDG); the pair decides which. `amountIn`, both assets, `minOut`, the relayer fee and the
  deadline are public; the owner and the remaining balance are not.
- The output is a v2 note: its amount is only known on-chain, so the proof fixes `H(asset, ownerPk, blinding)` and
  ShieldedTrade appends the amount (`PartialNoteFilled`). Encrypted notes for it use version byte 2. `myNotes`
  returns it with `version: 2` once synced with `trade`.
- A v2 note can be swapped again directly. Transfer, withdraw, statements (`decryptNote` is v1 only) and threshold
  proofs need it settled first: `proveSettle` + `settleTx` (one extra transaction, nothing public but a
  nullifier and a commitment).
- `parkValue(pub, trade, shareToken, shares)` shows a park position in USDG (ERC-4626 `convertToAssets`, Morpho
  share price including interest accrued since the market's last update).

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

## Threshold proofs

A threshold proof says "at least X" without opening any note. Two statements, one asset per proof, at most 8
notes or deposits each (circuits `threshold_holdings` and `threshold_savings`, Noir + UltraHonk):

| Statement | SDK | Public inputs |
| --- | --- | --- |
| Holdings: unspent notes of asset A worth >= X raw units at a pool root | `proveHoldingsAtLeast` / `verifyHoldings` | pool root, asset, X, verifier nonce, 8 nullifiers (0 = padding) |
| Savings: deposits to my `ownerPk` of asset A between two deposit-tree roots add up to >= X | `proveSavingsAtLeast` / `verifySavings` | two deposit-tree roots, asset, X, verifier nonce |

```ts
import { proveHoldingsAtLeast, verifyHoldings } from "@plynth/sdk/statements";
// the verifier picks requestId and tells the prover its address (or GET /v1/proofs/nonce)
const proof = await proveHoldingsAtLeast({ chainId, thresholdVerifier, verifier, requestId, keys, tree, notes, asset, threshold });
// verifier side, stateless (eth_call to ThresholdVerifier.checkHoldings), or POST /v1/proofs/verify
const verdict = await verifyHoldings(publicClient, proof, { verifier, requestId }, { chainId, thresholdVerifier });
```

`ThresholdVerifier` (on-chain, no owner) checks the rest: the pool root was published by ShieldedPool, none of
the nullifiers is spent now, the deposit-tree roots are its own and in order, and the proof was made for this
verifier's request. The SDK picks the fewest notes that reach X, largest first.

**Deposit tree.** ShieldedPool cannot tell a deposit leaf from a transfer output, so `ThresholdVerifier` keeps
its own append-only tree of inserted deposit commitments (anyone calls `syncDeposits`; refunded deposits are
skipped). Moving notes around never adds deposit leaves, so it cannot inflate savings. A deposit only counts
once synced, and a window can only start or end at a published deposit-tree root.

### Limits: what a verifier learns

- **The asset, the threshold and that it is met.** Not the sum, the notes or their amounts. A verifier who asks
  repeatedly with rising thresholds can binary-search the balance; refuse to answer more than you want known.
- **Padding count (holdings).** The number of zero nullifiers is public, so the verifier learns how many notes
  were counted (1 to 8). Savings proofs reveal no count.
- **Time.** Holdings: which pool root (so roughly when) the statement holds at; spent status is checked against
  now. Savings: the window's two deposit-tree roots, whose block numbers and timestamps are on-chain, and the
  number of deposits (everyone's) synced in between.
- **Nullifiers link future spends (holdings).** Each counted note's nullifier is in the proof. When the note is
  later spent, the verifier sees that nullifier on-chain and links the spend to this proof. The proof stays
  valid only until then. A fix needs a nullifier non-membership accumulator (not built).
- **Same proof, same person.** Two verifiers who compare the nullifiers of holdings proofs can tell both came
  from the same notes. Savings proofs carry no per-note values, but the window and threshold may still identify.
- **Nonce binding, not identity binding.** A proof is bound to (chain, ThresholdVerifier, verifier address,
  requestId), so verifier B cannot reuse verifier A's proof and A cannot replay it to another request. It is not
  bound to the user's address: anyone holding the spending secret can make it.
- **Savings means deposits made, not kept.** Notes spent after depositing still count. Deposits made by
  CrowdBuy's Hidden delivery to the user's `ownerPk` count as the user's deposits.
