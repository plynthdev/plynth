// Hidden Vault: shield USDG into ShieldedPool, then withdraw it to a fresh address with a proof made on this
// device and submitted by someone else (a relayer), so the withdraw does not name the depositor.
//   bun sdk/examples/shield-and-withdraw.ts
import { erc20Abi, getAddress, parseAbi, type Address } from "viem";
import {
  VAULT_KEY_MESSAGE,
  approveTx,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  initVault,
  insertPendingTx,
  myNotes,
  proveWithdraw,
  shieldedPoolAbi,
  syncPool,
  withdrawTx,
} from "@plynth/sdk/vault";
import { check, runExample } from "./_local";

const U = 1_000_000n;
const HOUR = 3_600n;
const adminAbi = parseAbi(["function mint(address to, uint256 amount)", "function applyCap(address asset)"]);

await runExample("shield-and-withdraw", async ({ dep, pub, wallet, accounts, now, warpTo, send, call, read }) => {
  const [deployer, , alice, , , , , , fresh, relayer] = accounts.map((x) => getAddress(x)) as Address[];
  const pool = dep.shieldedPool as Address;
  const usdg = dep.usdg as Address;
  await initVault(); // loads the Poseidon2 WASM once (no network)

  try {
    // Kit setup: the local deploy proposed a cap for mUSDG; caps only take effect 48 h later (on mainnet: 0).
    await warpTo((await now()) + 48n * HOUR + 1n);
    await call(deployer, pool, adminAbi, "applyCap", [usdg]);
    await call(deployer, usdg, adminAbi, "mint", [alice, 1_000n * U]);

    // 1. Keys from one signature. The deposit is public: it shows alice and the amount.
    const keys = deriveVaultKeys(await wallet.signMessage({ account: alice, message: VAULT_KEY_MESSAGE }));
    const amount = 400n * U;
    await send(alice, approveTx(usdg, pool, amount));
    await send(alice, depositTx(pool, usdg, amount, keys));

    // 2. After the pending delay anyone batches pending deposits into the tree (1 h for a batch of 4+, 2 h below).
    await warpTo((await now()) + 2n * HOUR + 1n); // MIN_PENDING_DELAY + SOLO_INSERT_DELAY (a batch under 4 deposits)
    await send(relayer, insertPendingTx(pool, 100n));

    // 3. Sync the tree locally and find our note by trial-decrypting encrypted notes.
    const state = await syncPool(pub, pool, undefined, { fromBlock: BigInt(dep.deployBlock) });
    const note = myNotes(state, keys).find((n) => n.asset === usdg && !n.spent && n.leafIndex !== null);
    check(note && note.raw === amount, "our note is in the tree");

    // 4. Withdraw 150 to a fresh address; 1 USDG goes to the relayer the proof names (only it can submit,
    // so nobody copying the transaction takes the fee). Over HTTP, read it from relayerHealth(url).relayer.
    // The proof is made here, in ~1 s.
    const fee = 1n * U;
    const w = await proveWithdraw({ keys, tree: state.tree, note, amount: 150n * U, recipient: fresh, relayerFee: fee, relayer });
    // Over HTTP this would be `submitWithdraw(relayerUrl, w)` from @plynth/sdk/relayer; here the relayer account sends it.
    const r = await send(relayer, withdrawTx(pool, w));
    check(getAddress(r.from) === relayer, "the relayer, not alice, sent the withdraw");
    check((await read<bigint>(usdg, erc20Abi, "balanceOf", [fresh])) === 149n * U, "fresh address got amount - fee");
    check((await read<bigint>(usdg, erc20Abi, "balanceOf", [relayer])) === fee, "relayer kept the fee");
    check((await read<boolean>(pool, shieldedPoolAbi, "nullifierSpent", [w.pub.nullifier])) === true, "note spent");

    // 5. The change (250) is a new note only alice can see.
    const after = await syncPool(pub, pool, state);
    const change = myNotes(after, keys).filter((n) => n.asset === usdg && !n.spent);
    check(change.length === 1 && change[0]!.raw === 250n * U, "change note of 250 is ours and unspent");
    console.log(`withdrew 150 USDG to a fresh address via a relayer; 250 stays shielded`);
  } finally {
    await destroyProver();
  }
});
