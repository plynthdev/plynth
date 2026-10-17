// Hidden Vault on the fork: deposit -> pending -> refund; deposit -> insert -> private transfer -> withdraw through
// the running relayer; the spent note refused; private sell and buy through the real v4 pools; park/unpark in the
// real steakUSDG vault; viewing-key statement; scoped disclosure verified by the API; threshold proofs (holdings,
// savings) verified by the API and on-chain, and refused once a counted note is spent. Real UltraHonk proofs.
import {
  approveTx,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  initVault,
  insertPendingTx,
  myNotes,
  parkValue,
  proveSettle,
  proveSwap,
  proveTransfer,
  proveWithdraw,
  settleTx,
  swapTx,
  syncPool,
  transferTx,
  VAULT_KEY_MESSAGE,
  withdrawRequest,
  withdrawTx,
  type PoolState,
  type VaultKeys,
} from "@plynth/sdk/vault";
import { depositRootAt, discloseNotes, proveHoldingsAtLeast, proveSavingsAtLeast, scanPool, statement, syncDepositTree, verifyHoldings } from "@plynth/sdk/statements";
import { bytesToHex, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FORK_CHAIN_ID, PORTS } from "../lib";
import { abiOf, expect, j } from "./core";
import { api, balanceOf, E18, events, HOUR, U, usdgOf, type Ctx } from "./context";

export async function hidden(x: Ctx) {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const trade = x.addr("shieldedTrade");
  const usdg = x.addr("usdg");
  const tsla = x.token("TSLA");
  const aapl = x.token("AAPL");
  const steak = x.addr("steakUsdg");
  const tv = x.addr("thresholdVerifier");
  const P = abiOf("ShieldedPool");
  const TV = abiOf("ThresholdVerifier");
  const deployBlock = BigInt(x.dep.deployBlock);
  const submitter = A.trader2; // anyone can submit proofs; this account plays the relayer for direct submissions
  await initVault();
  try {
    const ks: VaultKeys = deriveVaultKeys(await r.wallet(A.shielder).signMessage({ message: VAULT_KEY_MESSAGE }));
    let state: PoolState | undefined;
    const sync = async () => (state = await syncPool(r.pub, pool, state, { fromBlock: deployBlock, trade }));
    const mine = async (k: VaultKeys) => {
      await sync();
      return myNotes(state!, k).filter((n) => !n.spent && n.leafIndex !== null);
    };
    const deadline = async () => (await r.now()) + 3600n;
    const sendTx = (step: string, from: typeof submitter, u: { to: Address; data: Hex }, assert?: Parameters<typeof r.sendRaw>[3]) => r.sendRaw(step, from, { to: u.to, data: u.data }, assert);

    // Threshold savings proofs need a "from" root before the shielder's deposits: sync the verifier's deposit tree now.
    try {
      await r.pub.simulateContract({ account: submitter.address, address: tv, abi: TV, functionName: "syncDeposits", args: [100n] });
      await r.send("sync ThresholdVerifier's deposit tree (before the shielder's deposits)", submitter, { address: tv, abi: TV, functionName: "syncDeposits", args: [100n] });
    } catch {}
    const syncBlock = await r.pub.getBlockNumber();

    // 1. deposit -> pending -> refund
    await sendTx("shielder approves the pool for USDG", A.shielder, approveTx(usdg, pool, 10_000n * U));
    const dep1 = depositTx(pool, usdg, 100n * U, ks);
    let pendingId: bigint | undefined;
    await sendTx("shielder deposits 100 USDG (queued as pending)", A.shielder, dep1, async (rc) => {
      const e = (await events(x, pool, "ShieldedPool", "DepositQueued", rc.blockNumber, { origin: A.shielder.address }))[0];
      expect(!!e, "no DepositQueued");
      pendingId = BigInt(e!.args.pendingId);
      return `pending #${pendingId}, commitment ${String(e!.args.commitment).slice(0, 10)}…`;
    });
    if (pendingId !== undefined) {
      await r.reverts("only the depositor can refund a pending deposit", A.outsider, { address: pool, abi: P, functionName: "refundPending", args: [pendingId] }, "NotOrigin");
      const b0 = await usdgOf(x, A.shielder.address);
      await r.send("shielder refunds the pending deposit", A.shielder, { address: pool, abi: P, functionName: "refundPending", args: [pendingId] }, async () => {
        expect((await usdgOf(x, A.shielder.address)) - b0 === 100n * U, "refund not received");
        return "100 USDG back to the origin";
      });
      await r.reverts("a refunded deposit cannot be refunded again", A.shielder, { address: pool, abi: P, functionName: "refundPending", args: [pendingId] }, "NotPending");
    }

    // 2. deposit -> 1h queue -> insert
    await sendTx("shielder deposits 1,000 USDG", A.shielder, depositTx(pool, usdg, 1_000n * U, ks));
    await r.check("warp 2h (pending queue delay for a small batch)", async () => {
      await r.warp(2n * HOUR + 30n); // a lone deposit waits MIN_PENDING_DELAY + SOLO_INSERT_DELAY (audit M-5)
      return `chain time ${await r.now()}`;
    });
    try {
      await r.pub.simulateContract({ account: submitter.address, address: pool, abi: P, functionName: "insertPending", args: [100n] });
      await sendTx("anyone batches the pending deposits into the tree", submitter, insertPendingTx(pool, 100n));
    } catch {
      // The running keeper inserts pending deposits too (deliver-hidden); then there is nothing left to insert.
    }
    const note1000 = await r.until("the 1,000 USDG note in the tree", async () => (await mine(ks)).find((n) => n.asset === usdg && n.raw === 1_000n * U), 120_000);
    await r.check("shielder finds the 1,000 USDG note by trial decryption", async () => `leaf ${note1000.leafIndex}, root known on-chain: ${await r.read<boolean>(pool, P, "isKnownRoot", [`0x${state!.tree.root().toString(16).padStart(64, "0")}`])}`, "shielder");

    // 3. private transfer of 200 USDG to the Hidden saver (2-in/2-out proof)
    const hk = x.state.hiddenKeys as VaultKeys;
    const t = await proveTransfer({ keys: ks, tree: state!.tree, inputs: [note1000], to: hk, raw: 200n * U });
    await sendTx("private transfer of 200 USDG to the Hidden saver (submitted by a third party)", submitter, transferTx(pool, t), async () => {
      const got = await r.until("received note", async () => (await mine(hk)).find((n) => n.asset === usdg && n.raw === 200n * U));
      return `Hidden saver decrypts a 200 USDG note (leaf ${got.leafIndex}); nothing on-chain names either party`;
    });

    // 4. withdraw via the running relayer to a fresh address
    const change = await r.until("800 change note", async () => (await mine(ks)).find((n) => n.asset === usdg && n.raw === 800n * U));
    const fresh = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    r.names.set(fresh.toLowerCase(), "fresh address");
    const w = await proveWithdraw({ keys: ks, tree: state!.tree, note: change, amount: 150n * U, recipient: fresh, relayerFee: 1n * U, relayer: A.relayer.address });
    await r.external("relayer submits the shielder's withdraw of 150 USDG to a fresh address", "relayer", async () => {
      const res = await api("/withdraw", { method: "POST", port: PORTS.relayer, body: JSON.stringify(withdrawRequest(w)) });
      expect(res.status === 200 && res.body.txHash, `relayer ${res.status} ${j(res.body)}`);
      await r.pub.waitForTransactionReceipt({ hash: res.body.txHash });
      expect((await usdgOf(x, fresh)) === 149n * U, "fresh address did not get 149 USDG");
      return { tx: res.body.txHash, assertion: "fresh address holds 149 USDG; relayer kept the 1 USDG fee" };
    });
    // 5. the spent note is refused (relayer and chain)
    await r.check("relayer refuses a proof over the spent note", async () => {
      const res = await api("/withdraw", { method: "POST", port: PORTS.relayer, body: JSON.stringify(withdrawRequest(w)) });
      expect(res.status === 409, `relayer answered ${res.status} ${j(res.body)}`);
      return `HTTP 409: ${res.body.error}`;
    });
    await r.reverts("the same withdraw proof reverts on-chain (nullifier spent)", submitter, { address: pool, abi: P, functionName: "withdraw", args: [w.proof, w.pub] }, "NullifierAlreadySpent");

    // 6. private buy: 300 USDG of the 650 change -> AAPL on the real pool; settle; withdraw the AAPL
    const c650 = await r.until("650 change", async () => (await mine(ks)).find((n) => n.asset === usdg && n.raw === 650n * U));
    const qA = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [aapl]);
    const minAapl = (300n * U * 10n ** 12n * E18 * 97n) / (qA.priceUsdPerToken * 100n);
    const buy = await proveSwap({ keys: ks, tree: state!.tree, note: c650, amountIn: 300n * U, assetOut: aapl, minOut: minAapl, deadline: await deadline() });
    await sendTx("private buy: 300 USDG note -> AAPL through the real v4 pool", submitter, swapTx(trade, buy, 300), async () => {
      const out = await r.until("v2 AAPL note", async () => (await mine(ks)).find((n) => n.asset === aapl && n.version === 2));
      expect(out.raw >= minAapl, `out ${out.raw} < minOut ${minAapl}`);
      return `v2 note of ${Number(out.raw) / 1e18} AAPL (>= proven minOut)`;
    });
    const v2 = (await mine(ks)).find((n) => n.asset === aapl && n.version === 2);
    if (v2) {
      const st = await proveSettle({ keys: ks, tree: state!.tree, note: v2 });
      await sendTx("settle the AAPL v2 note into a v1 note", submitter, settleTx(trade, st), async () => {
        const v1 = await r.until("settled AAPL", async () => (await mine(ks)).find((n) => n.asset === aapl && n.version !== 2 && n.raw === v2.raw));
        return `v1 AAPL note of ${v1.raw} raw`;
      });
      const v1 = (await mine(ks)).find((n) => n.asset === aapl && n.version !== 2 && n.raw === v2.raw);
      if (v1) {
        const wa = await proveWithdraw({ keys: ks, tree: state!.tree, note: v1, amount: v1.raw, recipient: fresh });
        await sendTx("withdraw the privately bought AAPL to the fresh address", submitter, withdrawTx(pool, wa), async () => {
          expect((await balanceOf(x, aapl, fresh)) === v1.raw, "AAPL not received");
          return `fresh address holds ${v1.raw} raw AAPL`;
        });
      }
    }

    // 7. private sell: the Hidden saver's crowd-delivered TSLA note -> USDG on the real pool
    const crowdNote = await r.until("Hidden saver's TSLA note from the crowd buy", async () => (await mine(hk)).find((n) => n.asset === tsla), 180_000).catch(() => undefined);
    if (!crowdNote) {
      await r.check("Hidden saver's crowd TSLA note is in the tree (keeper deliver-hidden + insert)", () => {
        throw new Error("no TSLA note for the Hidden saver: crowd delivery or the keeper's insertPending did not happen");
      });
    } else {
      const qT = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [tsla]);
      const minUsdg = (crowdNote.raw * qT.priceUsdPerToken * 97n) / (100n * 10n ** 12n * E18);
      const sell = await proveSwap({ keys: hk, tree: state!.tree, note: crowdNote, amountIn: crowdNote.raw, assetOut: usdg, minOut: minUsdg, deadline: await deadline() });
      await sendTx(`private sell: the Hidden saver's ${crowdNote.raw} raw TSLA note -> USDG through the real pool`, submitter, swapTx(trade, sell, 300), async () => {
        const out = await r.until("v2 USDG note", async () => (await mine(hk)).find((n) => n.asset === usdg && n.version === 2));
        expect(out.raw >= minUsdg, `out ${out.raw}`);
        return `v2 note of ${Number(out.raw) / 1e6} USDG`;
      });
    }

    // 8. park / unpark in the real steakUSDG vault
    const c350 = await r.until("350 change", async () => (await mine(ks)).find((n) => n.asset === usdg && n.raw === 350n * U && n.version !== 2));
    const park = await proveSwap({ keys: ks, tree: state!.tree, note: c350, amountIn: 200n * U, assetOut: steak, minOut: 1n, deadline: await deadline() });
    await sendTx("park 200 USDG of a note in the real steakUSDG vault", submitter, swapTx(trade, park), async () => {
      const sh = await r.until("steakUSDG share note", async () => (await mine(ks)).find((n) => n.asset === steak));
      const v = await parkValue(r.pub, trade, steak, sh.raw);
      expect(v >= 199n * U && v <= 200n * U, `park value ${v}`);
      return `share note ${sh.raw} worth ${Number(v) / 1e6} USDG (vault's own share price)`;
    });
    await r.check("warp 6h: the parked shares accrue Morpho interest", async () => {
      await r.warp(6n * HOUR);
      return `chain time ${await r.now()}`;
    });
    const shares = (await mine(ks)).find((n) => n.asset === steak);
    if (shares) {
      const value = await parkValue(r.pub, trade, steak, shares.raw);
      const un = await proveSwap({ keys: ks, tree: state!.tree, note: shares, amountIn: shares.raw, assetOut: usdg, minOut: (value * 999n) / 1000n, deadline: await deadline() });
      await sendTx("unpark: the steakUSDG share note back to USDG", submitter, swapTx(trade, un), async () => {
        const back = await r.until("unparked USDG", async () => (await mine(ks)).find((n) => n.asset === usdg && n.version === 2));
        expect(back.raw >= 200n * U - 1n, `unparked ${back.raw}`);
        expect((await r.read<bigint>(pool, P, "shielded", [steak])) === 0n, "shares left in the pool");
        return `${Number(back.raw) / 1e6} USDG back (>= parked: interest accrued)`;
      });
    }

    // Swap outputs are v2 notes (amount filled on-chain); statements and threshold proofs read v1 notes: settle.
    const v2usdg = (await mine(ks)).find((n) => n.asset === usdg && n.version === 2);
    if (v2usdg) {
      const st = await proveSettle({ keys: ks, tree: state!.tree, note: v2usdg });
      await sendTx("settle the unparked USDG v2 note into a v1 note", submitter, settleTx(trade, st), async () => {
        const v1 = await r.until("settled USDG", async () => (await mine(ks)).find((n) => n.asset === usdg && n.version !== 2 && n.raw === v2usdg.raw));
        return `v1 USDG note of ${Number(v1.raw) / 1e6}`;
      });
    }

    // 9. viewing-key statement over the shielder's whole history
    const head = await r.pub.getBlockNumber();
    const hist = await scanPool(r.pub, pool, deployBlock, head);
    const period = { fromBlock: deployBlock, toBlock: head };
    const opts = { chainId: FORK_CHAIN_ID, pool, deployBlock, valuer: x.addr("valuer"), stables: [usdg], history: hist };
    const s = await statement(r.pub, ks, period, opts);
    await r.check("viewing-key statement: USDG opening + in - out = closing, matches the unspent notes", async () => {
      const b = s.balances.find((b) => getAddress(b.asset) === usdg)!;
      const unspent = (await mine(ks)).filter((n) => n.asset === usdg).reduce((a, n) => a + n.raw, 0n);
      expect(b.opening + b.in - b.out === b.closing, j(b));
      expect(b.closing === unspent, `closing ${b.closing} vs unspent notes ${unspent}`);
      return `USDG in ${Number(b.in) / 1e6}, out ${Number(b.out) / 1e6}, closing ${Number(b.closing) / 1e6}; ${s.movements.length} movements, refund shown: ${s.movements.some((m) => m.type === "refunded")}`;
    }, "shielder");
    await r.check("API lists the statement (GET /v1/statements/:address)", async () => {
      const res = await api(`/v1/statements/${A.shielder.address}`);
      expect(res.status === 200, `HTTP ${res.status} ${j(res.body)}`);
      return `HTTP 200 ${j(res.body).slice(0, 120)}`;
    });

    // 10. scoped disclosure of one unspent note, verified by the stateless API; a tampered copy fails
    const disclosable = s.notes.find((n) => n.status === "unspent" && getAddress(n.asset) === usdg);
    if (disclosable) {
      const bundle = discloseNotes([disclosable], period, { chainId: FORK_CHAIN_ID, pool, history: hist });
      await r.check("scoped disclosure verifies (POST /v1/statements/verify)", async () => {
        const res = await api("/v1/statements/verify", { method: "POST", body: JSON.stringify(bundle) });
        expect(res.status === 200 && res.body.ok === true, `HTTP ${res.status} ${j(res.body)}`);
        return `ok, ${res.body.notes.length} note, nullifier ${res.body.notes[0].nullifierStatus}`;
      });
      const bad = JSON.parse(JSON.stringify(bundle));
      bad.notes[0].raw = (BigInt(bad.notes[0].raw) + 1n).toString();
      await r.check("a tampered disclosure (amount + 1) fails", async () => {
        const res = await api("/v1/statements/verify", { method: "POST", body: JSON.stringify(bad) });
        expect(res.body.ok === false, j(res.body));
        return `ok = false: ${res.body.notes?.[0]?.error ?? res.body.reason}`;
      });
    }

    // 11. threshold proofs: holdings and savings, for one verifier and one request
    const requestId = keccak256(toBytes("plynth fork run"));
    const verifier = A.board2.address;
    const req = { chainId: FORK_CHAIN_ID, thresholdVerifier: tv, verifier, requestId };
    const notesNow = await mine(ks);
    const holdings = await proveHoldingsAtLeast({ ...req, keys: ks, tree: state!.tree, notes: notesNow, asset: usdg, threshold: 300n * U });
    await r.check("holdings proof (>= 300 USDG) verifies through the API", async () => {
      const res = await api("/v1/proofs/verify", { method: "POST", body: JSON.stringify({ proof: holdings, verifier, requestId }) });
      expect(res.body.ok === true, `HTTP ${res.status} ${j(res.body)}`);
      return `ok, ${res.body.holdings?.notes} notes`;
    }, "board2 (verifier)");
    await r.check("holdings proof verifies on-chain (ThresholdVerifier.checkHoldings)", async () => {
      const v = await verifyHoldings(r.pub, holdings, { verifier, requestId }, { chainId: FORK_CHAIN_ID, thresholdVerifier: tv });
      expect((v as { ok: boolean }).ok === true, j(v));
      return "ok";
    });
    await r.check("the holdings proof fails for another verifier", async () => {
      const res = await api("/v1/proofs/verify", { method: "POST", body: JSON.stringify({ proof: holdings, verifier: A.outsider.address, requestId }) });
      expect(res.body.ok === false, j(res.body));
      return `ok = false (${res.body.reason})`;
    });
    try {
      await r.pub.simulateContract({ account: submitter.address, address: tv, abi: TV, functionName: "syncDeposits", args: [100n] });
      await r.send("sync ThresholdVerifier's deposit tree (after the deposits)", submitter, { address: tv, abi: TV, functionName: "syncDeposits", args: [100n] });
    } catch {}
    const dt = await syncDepositTree(r.pub, tv, undefined, { fromBlock: deployBlock });
    const from = depositRootAt(dt, syncBlock) ?? dt.roots[0];
    const to = dt.roots.at(-1);
    if (from && to) {
      const all = myNotes((await sync())!, ks);
      try {
        const savings = await proveSavingsAtLeast({ ...req, keys: ks, deposits: dt, notes: all, asset: usdg, threshold: 1_000n * U, from, to });
        await r.check("savings proof (deposited >= 1,000 USDG in the window) verifies through the API", async () => {
          const res = await api("/v1/proofs/verify", { method: "POST", body: JSON.stringify({ proof: savings, verifier, requestId }) });
          expect(res.body.ok === true, `HTTP ${res.status} ${j(res.body)}`);
          return `ok, ${res.body.savings?.depositsInWindow} deposits in window`;
        }, "board2 (verifier)");
      } catch (e) {
        await r.check("savings proof (deposited >= 1,000 USDG in the window) verifies through the API", () => {
          throw e;
        });
      }
    }
    // Spending a counted note makes the holdings proof fail.
    const counted = new Set(holdings.claim.nullifiers.map((n) => BigInt(n)));
    const cn = (await mine(ks)).find((n) => n.nullifier !== null && counted.has(n.nullifier!));
    if (cn) {
      const wc = await proveWithdraw({ keys: ks, tree: state!.tree, note: cn, amount: cn.raw, recipient: A.shielder.address });
      await sendTx("shielder withdraws a note the holdings proof counted", submitter, withdrawTx(pool, wc));
      await r.check("the holdings proof over a now-spent note is refused", async () => {
        const res = await api("/v1/proofs/verify", { method: "POST", body: JSON.stringify({ proof: holdings, verifier, requestId }) });
        expect(res.body.ok === false && res.body.reason === "NullifierSpent", j(res.body));
        return "ok = false (NullifierSpent)";
      });
    }
    x.state.shielderKeys = ks;
  } finally {
    await destroyProver();
  }
}
