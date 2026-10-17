// Scheduled steps of the testnet exercise: the ones that wait on real chain time. `exercise.ts --resume` runs
// each one that is due; a handler returns done, "later" (with the next time to look), or failed.
import { announcementEvent, decodeAnnouncementLog, generateKeys, KEY_DERIVATION_MESSAGE, keyForHit, scan, signClaim } from "@plynth/sdk/stealth";
import { depositTx, deriveVaultKeys, destroyProver, initVault, myNotes, proveTransfer, proveWithdraw, syncPool, transferTx, VAULT_KEY_MESSAGE, withdrawRequest, type PoolState } from "@plynth/sdk/vault";
import { bytesToHex, getAddress, maxUint256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abiOf, expect, j } from "../../fork/exercise/core";
import { PORTS, TESTNET_CHAIN_ID } from "../lib";
import { erc20Abi } from "./areas";
import { api, chainNow, dur, E18, events, HOUR, timers, U, type TCtx } from "./ctx";
import { deskRows } from "./services";
import type { Outcome, Scheduled } from "./state";
import { beaconKey } from "@/keeper/jobs/beacon";

const MAX_U64 = 2n ** 64n - 1n;
type Handler = (x: TCtx, item: Scheduled) => Promise<Outcome>;
const fromBlock = (x: TCtx) => BigInt(x.data.roundupsFrom ?? x.dep.deployBlock);

const crowdExecution: Handler = async (x, item) => {
  const { r, A } = x;
  const crowd = x.addr("crowdBuy");
  const C = x.abi("CrowdBuy");
  const books = item.args!.books as Record<string, string>;
  const window = BigInt(item.args!.window as string);
  const now = await chainNow(x);
  if (now < Number(window)) return { status: "later", dueAt: Number(window), detail: "window not open yet" };
  const pendingAssets: Address[] = [];
  let next = 0;
  for (const [a, id] of Object.entries(books)) {
    const b = await r.read<{ executed: boolean }>(crowd, C, "book", [a, BigInt(id)]);
    if (b.executed) continue;
    pendingAssets.push(getAddress(a));
    const at = await r.read<bigint>(x.addr("jitterBeacon"), x.abi("JitterBeacon"), "executeAfter", [beaconKey(getAddress(a), window)]);
    next = Math.max(next, at === MAX_U64 ? now + 600 : Number(at) + 120);
  }
  if (pendingAssets.length) {
    if (next > now) return { status: "later", dueAt: next, detail: `${pendingAssets.length} book(s) wait for their beacon time` };
    // Past the beacon time: give the running keeper a few minutes, then record what blocks it.
    try {
      await r.until("keeper executes every book", async () => {
        for (const a of pendingAssets) if (!(await r.read<{ executed: boolean }>(crowd, C, "book", [a, BigInt(books[a]!)])).executed) return undefined;
        return true;
      }, 600_000, 10_000);
    } catch {
      const why: string[] = [];
      for (const a of pendingAssets) {
        try {
          await r.pub.simulateContract({ account: x.addr("keeper"), address: crowd, abi: C, functionName: "execute", args: [a] });
          why.push(`${r.who(a)}: execute would succeed now (keeper late)`);
        } catch (e) {
          why.push(`${r.who(a)}: ${String((e as Error).message).split("\n")[0]}`);
        }
      }
      return { status: "later", dueAt: now + 900, detail: `not executed yet: ${why.join("; ")}` };
    }
  }
  const from = fromBlock(x);
  let e1: { asset: Address; bookId: string } | undefined;
  for (const [a0, id] of Object.entries(books)) {
    const a = getAddress(a0);
    await r.external(`keeper executes the ${r.who(a)} book on the testnet v4 pool`, "keeper", async () => {
      const e = (await events(x, crowd, "CrowdBuy", "Executed", from, { asset: a, bookId: BigInt(id) }))[0];
      expect(!!e, "no Executed event");
      const q = await r.read<{ priceUsdPerToken: bigint }>(x.addr("valuer"), x.abi("Valuer"), "quote", [a]);
      const usdIn = BigInt(e!.args.usdgTotal) * 10n ** 12n;
      const fair = (BigInt(e!.args.rawOut) * q.priceUsdPerToken) / E18;
      expect(fair * 10_000n >= usdIn * 9_800n, `filled ${fair} USD of tokens for ${usdIn}`);
      return { tx: e!.transactionHash, assertion: `${Number(e!.args.usdgTotal) / 1e6} mUSDG -> ${Number(e!.args.rawOut) / 1e18} ${r.who(a)}, within 2% of the (keeper-refreshed) feed` };
    });
    // E1 replay (exercise/e1.ts): the Open saver's mSPY allocation stays unclaimed here; the replay turns it into
    // a failed Quiet deliver followed by this open claim.
    if (a === x.token("mSPY") && process.env.TESTNET_E1 !== "0") {
      e1 = { asset: a, bookId: id };
    } else {
    const alloc = await r.read<bigint>(crowd, C, "allocationOf", [a, BigInt(id), A.open.address]);
    const b0 = await r.read<bigint>(a, erc20Abi, "balanceOf", [A.open.address]);
    await r.send(`open claims the ${r.who(a)} allocation`, A.open, { address: crowd, abi: C, functionName: "claimOpen", args: [a, BigInt(id)] }, async () => {
      // Retry: a lagging public RPC node can still answer with the balance before the claim (seen 2026-10-07).
      const got = await r.until("the claimed balance", async () => {
        const d = (await r.read<bigint>(a, erc20Abi, "balanceOf", [A.open.address])) - b0;
        return d === alloc ? d : undefined;
      }, 30_000, 2000).catch(() => -1n);
      expect(got === alloc && alloc > 0n, "wrong amount");
      return `${alloc} raw ${r.who(a)} received`;
    });
    await r.reverts(`open cannot claim ${r.who(a)} twice`, A.open, { address: crowd, abi: C, functionName: "claimOpen", args: [a, BigInt(id)] }, "AlreadySettled");
    }
    await r.external(`keeper delivers quiet's ${r.who(a)} allocation to StealthClaims`, "keeper", async () => {
      const e = await r.until("Delivered quiet", async () => (await events(x, crowd, "CrowdBuy", "Delivered", from, { asset: a, bookId: BigInt(id), user: A.quiet.address }))[0], 600_000, 10_000);
      return { tx: e.transactionHash, assertion: `Delivered(${e.args.raw} raw)` };
    });
  }
  // Before the Hidden checks (they expect every account of every book settled): due first.
  if (e1) x.schedule({ id: "e1-replay", handler: "e1-replay", area: "quiet", title: "E1 on testnet: plan -> failed Quiet deliver -> open claim -> the keeper releases no stealth credit", dueAt: now - 1, args: e1 });
  // Hidden deliveries need the Hidden Vault caps (CAP_DELAY after deploy): checked on their own once those apply.
  x.schedule({ id: "hidden-delivery", handler: "hidden-delivery", area: "hidden", title: "keeper delivers the Hidden saver's crowd allocations as shielded notes (after the caps apply)", dueAt: now, args: { books } });
  x.schedule({ id: "quiet-claim", handler: "quiet-claim", area: "quiet", title: "relayer claims the Quiet saver's stealth parts gaslessly to fresh addresses", dueAt: now });
  return { status: "done", detail: "3 books executed, Open claimed, Quiet delivered (Hidden waits for the caps)" };
};

const quietClaim: Handler = async (x) => {
  const { r, A } = x;
  const keys = generateKeys(await r.wallet(A.quiet).signMessage({ message: KEY_DERIVATION_MESSAGE }));
  const crowdAddr = x.addr("crowdBuy");
  const sc = x.addr("stealthClaims");
  const S = x.abi("StealthClaims");
  const logs = await r.pub.getLogs({ address: x.addr("erc5564Announcer"), event: announcementEvent, args: { caller: crowdAddr }, fromBlock: fromBlock(x), toBlock: "latest" });
  const hits = scan(logs.map((l) => decodeAnnouncementLog(l as never)), keys.viewingPrivateKey, keys.spendingPublicKey, { callers: [crowdAddr] });
  const claimed = new Set<string>((x.data.claimedStealth as string[] | undefined) ?? []);
  const todo = hits.filter((h) => !claimed.has(`${h.stealthAddress}:${h.token}`));
  if (!todo.length) return hits.length ? { status: "done", detail: `${hits.length} parts already claimed` } : { status: "later", dueAt: (await chainNow(x)) + 1800, detail: "no announced parts yet (released one crowd execution apart)" };
  await r.check("SDK scan finds the Quiet saver's stealth parts on the real ERC-5564 announcer", async () => `${hits.length} announcements match the Quiet saver's viewing key`, "quiet");
  for (const [i, h] of todo.entries()) {
    const to = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    r.names.set(to.toLowerCase(), `fresh address ${i + 1}`);
    const nonce = await r.read<bigint>(sc, S, "nonces", [h.stealthAddress]);
    const signed = await signClaim(keyForHit(h, keys), TESTNET_CHAIN_ID, sc, { token: h.token!, to, raw: h.amount!, nonce, deadline: BigInt(await chainNow(x)) + 3600n });
    const body = { token: signed.message.token, stealth: signed.message.stealth, to, raw: signed.message.raw.toString(), deadline: signed.message.deadline.toString(), sig: signed.sig };
    const ok = await r.external(`relayer claims stealth part ${i + 1} gaslessly to a fresh address`, "relayer", async () => {
      const res = await api("/claim", { method: "POST", port: PORTS.relayer, body: JSON.stringify(body) });
      expect(res.status === 200 && res.body.txHash, `relayer ${res.status} ${j(res.body)}`);
      const rc = await r.pub.waitForTransactionReceipt({ hash: res.body.txHash });
      expect(getAddress(rc.from) === x.A.relayer.address, "not paid by the relayer");
      expect((await r.read<bigint>(h.token!, erc20Abi, "balanceOf", [to])) === h.amount!, "fresh address did not receive the part");
      expect((await r.pub.getBalance({ address: h.stealthAddress })) === 0n, "stealth address holds gas");
      return { tx: res.body.txHash, assertion: `fresh address holds ${h.amount} raw ${r.who(h.token!)}; relayer paid gas; stealth address never funded` };
    });
    if (ok) claimed.add(`${h.stealthAddress}:${h.token}`);
    await r.reverts(`replaying part ${i + 1}'s claim signature reverts`, A.open, { address: sc, abi: S, functionName: "claim", args: [body.token, body.stealth, to, BigInt(body.raw), BigInt(body.deadline), body.sig] }, "BadSignature");
  }
  x.data.claimedStealth = [...claimed];
  // SPLIT_PARTS = 2: the second part of each delivery is released one crowd execution (one WINDOW) later.
  return { status: "later", dueAt: (await chainNow(x)) + (await timers(x)).window + 600, detail: `${claimed.size} part(s) claimed; looking again for parts released later` };
};

const hiddenCaps: Handler = async (x) => {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const P = x.abi("ShieldedPool");
  for (const a of [x.addr("usdg"), x.addr("cashVault"), ...Object.values(x.dep.stocks).map((s) => getAddress(s.token))]) {
    if ((await r.read<bigint>(pool, P, "cap", [a])) > 0n) continue;
    await r.send(`apply the Hidden Vault cap for ${r.who(a)}`, A.deployer, { address: pool, abi: P, functionName: "applyCap", args: [a] }, async () => {
      const c = await r.read<bigint>(pool, P, "cap", [a]);
      expect(c > 0n, "cap still 0");
      return `cap(${r.who(a)}) = ${c}`;
    });
  }
  const T = x.abi("ShieldedTrade");
  const ad = await r.read<Address>(x.addr("shieldedTrade"), T, "adapterOf", [x.addr("cashVault")]);
  if (BigInt(ad) === 0n) {
    await r.send("apply the mock-vault park adapter", A.deployer, { address: x.addr("shieldedTrade"), abi: T, functionName: "applyAdapter", args: [x.addr("cashVault")] }, async () => {
      const got = await r.read<Address>(x.addr("shieldedTrade"), T, "adapterOf", [x.addr("cashVault")]);
      expect(getAddress(got) === x.addr("parkAdapter"), `adapterOf = ${got}`);
      return "adapterOf(mock vault) = ERC4626Park";
    });
  }
  return { status: "done" };
};

type VaultKeys = ReturnType<typeof deriveVaultKeys>;

/** Deposit 100 mUSDG (queued as pending) and refund it to the origin. True when both went through. */
async function hiddenDepositRefund(x: TCtx, ks: VaultKeys, retry = false): Promise<boolean> {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const usdg = x.addr("usdg");
  const P = abiOf("ShieldedPool");
  const d1 = depositTx(pool, usdg, 100n * U, ks);
  let pendingId: bigint | undefined;
  await r.sendRaw(`hidden deposits 100 mUSDG into the Hidden Vault (queued as pending)${retry ? " (retry)" : ""}`, A.hidden, { to: d1.to, data: d1.data }, async (rc) => {
    const e = (await events(x, pool, "ShieldedPool", "DepositQueued", rc.blockNumber, { origin: A.hidden.address }))[0];
    expect(!!e, "no DepositQueued");
    pendingId = BigInt(e!.args.pendingId);
    return `pending #${pendingId}`;
  });
  if (pendingId === undefined) return false;
  const b0 = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.hidden.address]);
  const ok = await r.send(`hidden refunds the pending deposit${retry ? " (retry)" : ""}`, A.hidden, { address: pool, abi: P, functionName: "refundPending", args: [pendingId] }, async () => {
    const got = await r.until("refund visible", async () => {
      const d = (await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.hidden.address])) - b0;
      return d === 100n * U ? d : undefined;
    }, 30_000, 2000);
    expect(got === 100n * U, "refund not received");
    return "100 mUSDG back to the origin";
  });
  return ok !== undefined;
}

const hiddenRefund: Handler = async (x) => {
  const { r, A } = x;
  const usdg = x.addr("usdg");
  if ((await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.hidden.address])) < 100n * U) {
    await r.send("deployer mints the Hidden saver 100 mUSDG for the refund retry", A.deployer, { address: usdg, abi: erc20Abi, functionName: "mint", args: [A.hidden.address, 100n * U] });
  }
  await initVault();
  try {
    const ks = deriveVaultKeys(await r.wallet(A.hidden).signMessage({ message: VAULT_KEY_MESSAGE }));
    if (await hiddenDepositRefund(x, ks, true)) return { status: "done" };
  } finally {
    await destroyProver().catch(() => undefined);
  }
  return { status: "later", dueAt: (await chainNow(x)) + 300, detail: "deposit -> refund did not go through; retrying" };
};

const hiddenVault: Handler = async (x) => {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const P = abiOf("ShieldedPool");
  const usdg = x.addr("usdg");
  if ((await r.read<bigint>(pool, P, "cap", [usdg])) === 0n) return { status: "later", dueAt: (await chainNow(x)) + 600, detail: "caps not applied yet" };
  await initVault();
  try {
    const ks = deriveVaultKeys(await r.wallet(A.hidden).signMessage({ message: VAULT_KEY_MESSAGE }));
    const bal = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [A.hidden.address]);
    if (bal < 600n * U) {
      await r.send("deployer mints the Hidden saver 600 mUSDG for the vault deposits", A.deployer, { address: usdg, abi: erc20Abi, functionName: "mint", args: [A.hidden.address, 600n * U - bal] });
    }
    await r.send("hidden approves the pool for mUSDG", A.hidden, { address: usdg, abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] });
    if (!(await hiddenDepositRefund(x, ks))) x.schedule({ id: "hidden-refund", handler: "hidden-refund", area: "hidden", title: "Hidden Vault: deposit 100 mUSDG -> refund the pending deposit (retry)", dueAt: (await chainNow(x)) + 60 });
    const d2 = depositTx(pool, usdg, 500n * U, ks);
    const rc = await r.sendRaw("hidden deposits 500 mUSDG (1h pending queue, then the keeper inserts it)", A.hidden, { to: d2.to, data: d2.data });
    if (!rc) return { status: "failed", detail: "the 500 mUSDG deposit did not go through (retried on the next --resume)" };
    x.schedule({ id: "hidden-withdraw", handler: "hidden-withdraw", area: "hidden", title: "after the 1h queue: the 500 mUSDG note is in the tree; withdraw 100 through the relayer to a fresh address", dueAt: Number((await r.pub.getBlock({ blockNumber: rc.blockNumber })).timestamp) + HOUR + 300 });
  } finally {
    await destroyProver().catch(() => undefined);
  }
  return { status: "done" };
};

const hiddenWithdraw: Handler = async (x) => {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const usdg = x.addr("usdg");
  await initVault();
  try {
    const ks = deriveVaultKeys(await r.wallet(A.hidden).signMessage({ message: VAULT_KEY_MESSAGE }));
    let state: PoolState | undefined;
    const mine = async () => {
      state = await syncPool(r.pub, pool, state, { fromBlock: BigInt(x.dep.deployBlock), trade: x.addr("shieldedTrade") });
      return myNotes(state!, ks).filter((n) => !n.spent && n.leafIndex !== null);
    };
    let note = (await mine()).find((n) => n.asset === usdg && n.raw === 500n * U);
    if (!note) {
      try {
        await r.pub.simulateContract({ account: A.hidden.address, address: pool, abi: abiOf("ShieldedPool"), functionName: "insertPending", args: [100n] });
        await r.send("hidden batches its matured pending deposit into the tree (the keeper does this too)", A.hidden, { address: pool, abi: abiOf("ShieldedPool"), functionName: "insertPending", args: [100n] });
      } catch {}
      note = (await mine()).find((n) => n.asset === usdg && n.raw === 500n * U);
    }
    if (!note) return { status: "later", dueAt: (await chainNow(x)) + 900, detail: "the 500 mUSDG note is not in the tree yet" };
    await r.check("hidden finds its 500 mUSDG note by trial decryption", async () => `leaf ${note!.leafIndex}`, "hidden");
    const fresh = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    r.names.set(fresh.toLowerCase(), "fresh address");
    const w = await proveWithdraw({ keys: ks, tree: state!.tree, note, amount: 100n * U, recipient: fresh, relayerFee: 1n * U, relayer: x.A.relayer.address });
    await r.external("relayer submits the Hidden withdraw of 100 mUSDG to a fresh address (UltraHonk proof)", "relayer", async () => {
      const res = await api("/withdraw", { method: "POST", port: PORTS.relayer, body: JSON.stringify(withdrawRequest(w)) });
      expect(res.status === 200 && res.body.txHash, `relayer ${res.status} ${j(res.body)}`);
      await r.pub.waitForTransactionReceipt({ hash: res.body.txHash });
      expect((await r.read<bigint>(usdg, erc20Abi, "balanceOf", [fresh])) === 99n * U, "fresh address did not get 99 mUSDG");
      return { tx: res.body.txHash, assertion: "fresh address holds 99 mUSDG; relayer kept the 1 mUSDG fee" };
    });
    await r.check("relayer refuses the same proof again (nullifier spent)", async () => {
      const res = await api("/withdraw", { method: "POST", port: PORTS.relayer, body: JSON.stringify(withdrawRequest(w)) });
      expect(res.status >= 400, `relayer answered ${res.status} ${j(res.body)}`);
      return `HTTP ${res.status}: ${res.body.error}`;
    });
    // Private transfer: 150 of the 400 change to another vault key holder (the Quiet saver's vault keys), a
    // 2-in/2-out proof submitted by a third party (the deployer); only the two owners can read the notes.
    const change = await r.until("the 400 mUSDG change note", async () => (await mine()).find((n) => n.asset === usdg && n.raw === 400n * U), 60_000, 3000).catch(() => undefined);
    if (!change) {
      await r.check("hidden finds its 400 mUSDG change note", () => {
        throw new Error("no 400 mUSDG change note after the withdraw");
      }, "hidden");
    } else {
      const qk = deriveVaultKeys(await r.wallet(A.quiet).signMessage({ message: VAULT_KEY_MESSAGE }));
      const t = await proveTransfer({ keys: ks, tree: state!.tree, inputs: [change], to: qk, raw: 150n * U });
      const tx = transferTx(pool, t);
      await r.sendRaw("private transfer of 150 mUSDG from the Hidden saver to another vault key (submitted by a third party)", A.deployer, { to: tx.to, data: tx.data }, async () => {
        const got = await r.until("the received note", async () => {
          state = await syncPool(r.pub, pool, state, { fromBlock: BigInt(x.dep.deployBlock), trade: x.addr("shieldedTrade") });
          return myNotes(state!, qk).find((n) => !n.spent && n.asset === usdg && n.raw === 150n * U);
        }, 60_000, 3000);
        const back = myNotes(state!, ks).find((n) => !n.spent && n.asset === usdg && n.raw === 250n * U);
        expect(!!back, "no 250 mUSDG change note for the sender");
        return `the receiver decrypts a 150 mUSDG note (leaf ${got.leafIndex}), the sender a 250 change note; nothing on-chain names either party`;
      });
    }
  } finally {
    await destroyProver().catch(() => undefined);
  }
  return { status: "done" };
};

const hiddenDelivery: Handler = async (x, item) => {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const now = await chainNow(x);
  if ((await r.read<bigint>(pool, abiOf("ShieldedPool"), "cap", [x.addr("usdg")])) === 0n) return { status: "later", dueAt: now + HOUR, detail: "Hidden Vault caps not applied yet" };
  const books = item.args!.books as Record<string, string>;
  const crowd = x.addr("crowdBuy");
  const missing: string[] = [];
  const found: { a: Address; tx: Hex; raw: bigint }[] = [];
  for (const [a0, id] of Object.entries(books)) {
    const a = getAddress(a0);
    const e = (await events(x, crowd, "CrowdBuy", "Delivered", fromBlock(x), { asset: a, bookId: BigInt(id), user: A.hidden.address }))[0];
    if (e) found.push({ a, tx: e.transactionHash, raw: BigInt(e.args.raw) });
    else missing.push(r.who(a));
  }
  if (missing.length) {
    if (now < item.dueAt + 3 * (await timers(x)).window) return { status: "later", dueAt: now + 900, detail: `not delivered yet: ${missing.join(", ")}` };
    return { status: "failed", detail: `the keeper never delivered ${missing.join(", ")} to the Hidden saver` };
  }
  for (const f of found) {
    await r.external(`keeper delivers hidden's ${r.who(f.a)} allocation as a pending shielded note`, "keeper", async () => ({ tx: f.tx, assertion: `Delivered(${f.raw} raw) into the ShieldedPool` }));
  }
  const crowdC = x.abi("CrowdBuy");
  for (const [a0, id] of Object.entries(books)) {
    const a = getAddress(a0);
    await r.check(`${r.who(a)} book: every account settled, allocations + dust == rawOut`, async () => {
      const b = await r.read<{ rawOut: bigint; accounts: number }>(crowd, crowdC, "book", [a, BigInt(id)]);
      const st = await r.read<{ settledAccounts: number; settledRaw: bigint }>(crowd, crowdC, "settlement", [a, BigInt(id)]);
      const d = (await events(x, crowd, "CrowdBuy", "DustSettled", fromBlock(x), { asset: a, bookId: BigInt(id) }))[0];
      expect(st.settledAccounts === b.accounts && d !== undefined, `settled ${st.settledAccounts}/${b.accounts}`);
      expect(st.settledRaw + BigInt(d!.args.raw) === b.rawOut, `${st.settledRaw} + ${d!.args.raw} != ${b.rawOut}`);
      return `${st.settledRaw} allocated + ${d!.args.raw} dust = ${b.rawOut} rawOut`;
    });
  }
  return { status: "done" };
};

const policyActivate: Handler = async (x, item) => {
  const { r, A } = x;
  const policy = getAddress(item.args!.policy as string);
  const P = abiOf("TreasuryPolicy");
  await r.send(`anyone activates treasury policy v2 after the ${dur((await timers(x)).policyTimelock)} timelock`, A.quiet, { address: policy, abi: P, functionName: "activate" }, async () => {
    const [, hash, v] = await r.read<[unknown, Hex, number]>(policy, P, "current");
    expect(hash === item.args!.hash && v === 2, `version ${v} hash ${hash}`);
    return "current() version 2, hash as proposed";
  });
  return { status: "done" };
};

const lpRedeem: Handler = async (x) => {
  const { r, A } = x;
  const pool = x.addr("perpPool");
  const PP = abiOf("PerpPool");
  const shares = await r.read<bigint>(pool, PP, "convertToShares", [1_000n * U]);
  const b0 = await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.deployer.address]);
  await r.send(`LP redeems 1,000 mUSDG of shares after the ${dur((await timers(x)).lpCooldown)} cooldown`, A.deployer, { address: pool, abi: PP, functionName: "redeem", args: [shares, A.deployer.address, A.deployer.address] }, async () => {
    const got = (await r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [A.deployer.address])) - b0;
    expect(got > 990n * U, `got ${got}`);
    return `${Number(got) / 1e6} mUSDG out`;
  });
  return { status: "done" };
};

const unbondingWithdraw: Handler = async (x) => {
  const { r, A } = x;
  const st = x.addr("staking");
  const plth = x.addr("plth");
  const b0 = await r.read<bigint>(plth, erc20Abi, "balanceOf", [A.deployer.address]);
  await r.send("board withdraws the 2,000 unbonded PLTH", A.deployer, { address: st, abi: abiOf("PlinthStaking"), functionName: "withdraw" }, async () => {
    const got = (await r.read<bigint>(plth, erc20Abi, "balanceOf", [A.deployer.address])) - b0;
    expect(got === 2_000n * E18, `got ${got}`);
    return "2,000 PLTH back";
  });
  await r.reverts("nothing left to withdraw", A.deployer, { address: st, abi: abiOf("PlinthStaking"), functionName: "withdraw" }, "NothingToWithdraw");
  return { status: "done" };
};

const equityRebalance: Handler = async (x, item) => {
  const { r } = x;
  const account = item.args!.account as string;
  const rows = (await deskRows(account)).filter((w) => w.desk === "equity" && w.status === "sent" && (w.action === "buy" || w.action === "sell"));
  if (!rows.length) {
    const now = await chainNow(x);
    const w = (await timers(x)).window;
    if (now < item.dueAt + 3 * w) return { status: "later", dueAt: now + Math.min(3 * HOUR, Math.floor(w / 4)), detail: "no equity trade by the running desk service yet" };
    return { status: "failed", detail: `the running treasury-desks service sent no equity trade within ${dur(3 * w)} of its due time` };
  }
  for (const w of rows.slice(0, 4)) {
    await r.external(`treasury-desks (running service): equity ${w.action}${w.asset ? ` ${r.who(w.asset as Address)}` : ""}`, "equity desk", async () => ({ tx: (w.tx_hash ?? undefined) as Hex | undefined, assertion: `desk_actions row ${w.id}: ${w.status}` }));
  }
  return { status: "done" };
};

export const HANDLERS: Record<string, Handler> = {
  "crowd-execution": crowdExecution,
  "quiet-claim": quietClaim,
  "hidden-caps": hiddenCaps,
  "hidden-vault": hiddenVault,
  "hidden-withdraw": hiddenWithdraw,
  "hidden-refund": hiddenRefund,
  "hidden-delivery": hiddenDelivery,
  "policy-activate": policyActivate,
  "lp-redeem": lpRedeem,
  "unbonding-withdraw": unbondingWithdraw,
  "equity-rebalance": equityRebalance,
};
