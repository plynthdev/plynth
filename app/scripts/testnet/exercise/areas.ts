// The instant part of the testnet exercise: everything that does not wait on real time runs now, through the
// contracts and the running services (eligibility, API, indexer, keeper, relayer). What waits on real time is
// scheduled (exercise/scheduled.ts) with the chain time it becomes due.
import { generateKeys, KEY_DERIVATION_MESSAGE, metaAddress, registerTx } from "@plynth/sdk/stealth";
import { deriveVaultKeys, initVault, registration, VAULT_KEY_MESSAGE } from "@plynth/sdk/vault";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, encodeAbiParameters, getAddress, maxUint256, parseAbi, stringToHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { selfAttestationTypedData } from "@/eligibility/statement";
import { roundupMessage } from "@/api/routes/roundups";
import { sha256Hex } from "@/keeper/sources/types";
import { compileTemplate, policyAbiParam, type Compiled } from "@/treasury/policy-compiler";
import { packProofs } from "@/treasury/desks/runner";
import { abiOf, expect, j } from "../../fork/exercise/core";
import { PATHS, PORTS, RPC, TESTNET_CHAIN_ID } from "../lib";
import { api, chainNow, DAY, E18, events, U, type TCtx } from "./ctx";
import { deskPass } from "./services";
import { beaconKey } from "@/keeper/jobs/beacon";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);
const registryAbi = parseAbi(["function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)"]);

/** (ceil(spend / roundTo) * roundTo - spend) * multiplier, USDG base units. */
export function roundUp(spend: bigint, roundTo: number, mult: number): bigint {
  const u = BigInt(roundTo) * U;
  return (((spend + u - 1n) / u) * u - spend) * BigInt(mult);
}


/** A random address nobody holds a key for (simulation-only negative cases; never funded). */
const outsider = () => privateKeyToAccount(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex).address;

const mint = (x: TCtx, step: string, token: Address, to: Address, amount: bigint) =>
  x.r.send(step, x.A.deployer, { address: token, abi: erc20Abi, functionName: "mint", args: [to, amount] }, async () => {
    const b = await x.r.read<bigint>(token, erc20Abi, "balanceOf", [to]);
    expect(b >= amount, `balance ${b}`);
    return `balance ${x.r.who(to)} >= ${amount}`;
  });

// ---------------------------------------------------------------- network

export async function network(x: TCtx) {
  const { r } = x;
  await r.check("RPC answers chain id 46630 (Robinhood Chain testnet), never 4663", async () => {
    const id = await r.pub.getChainId();
    expect(id === TESTNET_CHAIN_ID, `chain id ${id}`);
    return `eth_chainId = ${id} at ${RPC}`;
  });
  await r.check("every deployed contract has code on testnet", async () => {
    const keys = ["savingsVault", "crowdBuy", "stealthClaims", "shieldedPool", "shieldedTrade", "thresholdVerifier", "treasuryFactory", "policyGuard", "perpPool", "staking", "feeRouter", "eligibilityRegistry", "stockRouter", "valuer"];
    for (const k of keys) {
      const code = await r.pub.getCode({ address: x.addr(k) });
      expect(!!code && code.length > 2, `${k} has no code`);
    }
    return `${keys.length} contracts have code`;
  });
  await r.check("mock feeds are owned by the keeper and fresh (Valuer not on hold)", async () => {
    const out: string[] = [];
    for (const [sym, s] of Object.entries(x.dep.stocks)) {
      const owner = await r.read<Address>(s.feed, parseAbi(["function owner() view returns (address)"]), "owner");
      expect(getAddress(owner) === x.A.keeper.address, `${sym} feed owner ${owner}`);
      const q = await r.read<{ priceUsdPerToken: bigint; hold: boolean }>(x.addr("valuer"), x.abi("Valuer"), "quote", [s.token]);
      expect(!q.hold, `${sym} on hold`);
      out.push(`${sym} $${(Number(q.priceUsdPerToken / 10n ** 14n) / 1e4).toFixed(2)}`);
    }
    return out.join(", ");
  });
  for (const [name, port, path] of [["indexer", PORTS.indexer, "/health"], ["keeper", PORTS.keeper, "/health"], ["api", PORTS.api, "/v1/meta/health"], ["eligibility", PORTS.eligibility, "/health"], ["relayer", PORTS.relayer, "/health"], ["mcp", PORTS.mcp, "/health"]] as const) {
    await r.check(`${name} service healthy on this Mac`, async () => {
      const res = await api(path, { port });
      expect(res.status === 200, `HTTP ${res.status} ${j(res.body)}`);
      return `HTTP 200 ${typeof res.body === "object" && res.body?.chainId ? `chain ${res.body.chainId}` : ""}`.trim();
    }, name);
  }
}

// ---------------------------------------------------------------- eligibility

async function attest(x: TCtx, who: PrivateKeyAccount, port: number, label: string) {
  const { r } = x;
  const reg = x.addr("eligibilityRegistry");
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const sig = await r.wallet(who).signTypedData(selfAttestationTypedData(TESTNET_CHAIN_ID, who.address, expiry) as never);
  let att: any;
  const ok = await r.check(`${r.who(who)}: eligibility check through the ${label} allows`, async () => {
    const res = await api(port === PORTS.api ? "/v1/eligibility/check" : "/eligibility/check", { method: "POST", port, body: JSON.stringify({ address: who.address, attestationSig: sig, expiry: expiry.toString() }) });
    expect(res.status === 200 && res.body.allowed === true, `answer ${res.status} ${j(res.body)}`);
    att = res.body.attestation;
    expect(att.chainId === TESTNET_CHAIN_ID && getAddress(att.registry) === reg, `attestation for chain ${att.chainId} / ${att.registry}`);
    return `allowed, attestation for chain ${att.chainId}, expiry ${att.expiry}`;
  }, r.who(who));
  if (!ok) return;
  await r.send(`${r.who(who)}: attestation submitted on-chain`, who, { address: reg, abi: x.abi("EligibilityRegistry"), functionName: "attest", args: [att.user, BigInt(att.issuedAt), BigInt(att.expiry), att.flags, att.signature] }, async () => {
    expect(await r.read<boolean>(reg, x.abi("EligibilityRegistry"), "isEligible", [who.address]), "isEligible false after attest");
    return "isEligible(user) == true";
  });
}

export async function eligibility(x: TCtx) {
  const { r, A } = x;
  await attest(x, A.open, PORTS.eligibility, "eligibility service");
  await attest(x, A.quiet, PORTS.eligibility, "eligibility service");
  await attest(x, A.hidden, PORTS.api, "API");
  await r.check("a bad self-attestation signature is refused by the service", async () => {
    const res = await api("/eligibility/check", { method: "POST", port: PORTS.eligibility, body: JSON.stringify({ address: outsider(), attestationSig: `0x${"11".repeat(65)}`, expiry: String(Math.floor(Date.now() / 1000) + 86400) }) });
    expect(res.status === 200 && res.body.allowed === false, `answer ${res.status} ${j(res.body)}`);
    return `allowed=false, reason ${res.body.reason}`;
  });
  const o = outsider();
  x.r.names.set(o.toLowerCase(), "outsider");
  await r.reverts("outsider (no attestation) cannot set a buy mix", o, { address: x.addr("savingsVault"), abi: x.abi("SavingsVault"), functionName: "setMix", args: [[{ stockToken: x.token("mTSLA"), weightBps: 10_000 }]] }, "NotEligible");
  await r.reverts("outsider cannot join a crowd buy", o, { address: x.addr("crowdBuy"), abi: x.abi("CrowdBuy"), functionName: "join", args: [o] }, "NotEligible");
  x.notes.push("Sanctions screening (OFAC list) is not exercised on testnet: proving it needs an ERC-1271 code override on a listed address, which only a fork can do (fork run 2026-10-06-2 covers it).");
}

// ---------------------------------------------------------------- savings

const settings = (roundTo: number, multiplier: number, weeklyCap: bigint, fixedTopUp: bigint, mode: number) => ({ roundTo, multiplier, weeklyCap, fixedTopUp, mode });

async function linkWallet(x: TCtx, user: PrivateKeyAccount, wallet: PrivateKeyAccount) {
  const { r } = x;
  const vault = x.addr("savingsVault");
  const V = x.abi("SavingsVault");
  const nonce = await r.read<bigint>(vault, V, "linkNonce", [wallet.address]);
  const deadline = BigInt(await chainNow(x)) + 3600n;
  const sig = await r.wallet(wallet).signTypedData({
    domain: { name: "Plynth SavingsVault", version: "1", chainId: TESTNET_CHAIN_ID, verifyingContract: vault },
    types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "LinkWallet",
    message: { user: user.address, wallet: wallet.address, nonce, deadline },
  } as never);
  await r.send(`${r.who(user)}: link spending wallet ${r.who(wallet)} (EIP-712 on chain 46630, the wallet pays no gas)`, user, { address: vault, abi: V, functionName: "linkSpendingWallet", args: [wallet.address, deadline, sig] }, async () => {
    const linked = await r.read<Address>(vault, V, "linkedUser", [wallet.address]);
    expect(getAddress(linked) === user.address, `linkedUser = ${linked}`);
    return `linkedUser(${r.who(wallet)}) = ${r.who(user)}`;
  });
}

export async function savings(x: TCtx) {
  const { r, A } = x;
  const vault = x.addr("savingsVault");
  const usdg = x.addr("usdg");
  const V = x.abi("SavingsVault");
  const mix = [
    { stockToken: x.token("mTSLA"), weightBps: 5000 },
    { stockToken: x.token("mAAPL"), weightBps: 2500 },
    { stockToken: x.token("mSPY"), weightBps: 2500 },
  ];
  for (const n of ["open", "quiet", "hidden"] as const) await mint(x, `deployer mints 1,000 mUSDG to the ${n} saver`, usdg, A[n].address, 1_000n * U);
  await mint(x, "deployer mints 20 mUSDG to the spending wallet", usdg, A.spender.address, 20n * U);

  const plan = [
    ["open", settings(10, 1, 500n * U, 0n, 0)],
    ["quiet", settings(5, 2, 500n * U, 0n, 1)],
    ["hidden", settings(1, 3, 500n * U, 0n, 2)],
  ] as const;
  for (const [n, s] of plan) {
    const u = A[n];
    if (n === "quiet") {
      // Permit2 deposit: signature over the real Permit2 on chain 46630.
      await r.send("quiet: approve Permit2 for mUSDG", u, { address: usdg, abi: erc20Abi, functionName: "approve", args: [x.addr("permit2"), maxUint256] });
      const nonce = BigInt(Date.now());
      const deadline = BigInt(await chainNow(x)) + 3600n;
      const amount = 300n * U;
      const sig = await r.wallet(u).signTypedData({
        domain: { name: "Permit2", chainId: TESTNET_CHAIN_ID, verifyingContract: x.addr("permit2") },
        types: {
          PermitTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "spender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
          TokenPermissions: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
        primaryType: "PermitTransferFrom",
        message: { permitted: { token: usdg, amount }, spender: vault, nonce, deadline },
      } as never);
      await r.send("quiet: depositWithPermit2 300 mUSDG (Permit2 signature on chain 46630)", u, { address: vault, abi: V, functionName: "depositWithPermit2", args: [amount, { permitted: { token: usdg, amount }, nonce, deadline }, sig] }, async (rc) => {
        const [avail] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [u.address]);
        expect(avail === amount, `available ${avail}`);
        const ev = await events(x, vault, "SavingsVault", "Deposited", rc.blockNumber, { user: u.address });
        expect(ev.some((e) => e.args.viaPermit2 === true), "no Deposited(viaPermit2=true)");
        return "available = 300 mUSDG, Deposited(viaPermit2 = true)";
      });
    } else {
      await r.send(`${n}: approve the vault for 300 mUSDG`, u, { address: usdg, abi: erc20Abi, functionName: "approve", args: [vault, 300n * U] });
      await r.send(`${n}: deposit 300 mUSDG`, u, { address: vault, abi: V, functionName: "deposit", args: [300n * U] }, async () => {
        const [avail] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [u.address]);
        expect(avail === 300n * U, `available ${avail}`);
        return "available = 300 mUSDG";
      });
    }
    await r.send(`${n}: settings roundTo ${s.roundTo} x${s.multiplier} mode ${["Open", "Quiet", "Hidden"][s.mode]}`, u, { address: vault, abi: V, functionName: "setSettings", args: [s] }, async () => {
      const got = await r.read<{ roundTo: number; multiplier: number; mode: number }>(vault, V, "settingsOf", [u.address]);
      expect(got.roundTo === s.roundTo && got.multiplier === s.multiplier && got.mode === s.mode, j(got));
      return `settingsOf = ${got.roundTo}/${got.multiplier}/${got.mode}`;
    });
    await r.send(`${n}: buy mix mTSLA 50%, mAAPL 25%, mSPY 25%`, u, { address: vault, abi: V, functionName: "setMix", args: [mix] }, async () => {
      const got = await r.read<{ stockToken: Address }[]>(vault, V, "mixOf", [u.address]);
      expect(got.length === 3, `mix length ${got.length}`);
      return "mixOf has 3 entries";
    });
  }
  await linkWallet(x, A.open, A.spender);
  await r.reverts("roundTo 3 is not a valid setting", A.open, { address: vault, abi: V, functionName: "setSettings", args: [settings(3, 1, 500n * U, 0n, 0)] }, "InvalidSettings");
  await r.reverts("weekly cap above 500 mUSDG is refused", A.open, { address: vault, abi: V, functionName: "setSettings", args: [settings(10, 1, 501n * U, 0n, 0)] }, "InvalidSettings");
  await r.reverts("mix weights must sum to 100%", A.open, { address: vault, abi: V, functionName: "setMix", args: [[{ stockToken: x.token("mTSLA"), weightBps: 9000 }]] }, "InvalidMix");

  // Quiet: stealth meta-address on the REAL ERC-6538 registry on testnet.
  const keys = generateKeys(await r.wallet(A.quiet).signMessage({ message: KEY_DERIVATION_MESSAGE }));
  const tx = registerTx(metaAddress(keys), x.addr("erc6538Registry"));
  await r.sendRaw("quiet: register a stealth meta-address on the real ERC-6538 registry", A.quiet, { to: tx.to, data: tx.data }, async () => {
    const meta = await r.read<Hex>(x.addr("erc6538Registry"), registryAbi, "stealthMetaAddressOf", [A.quiet.address, 1n]);
    expect(meta.length > 2, "no meta-address stored");
    return `stealthMetaAddressOf(quiet, 1) = ${meta.length / 2 - 1} bytes`;
  });

  // Hidden: note owner key + viewing key in the vault.
  await initVault();
  const hk = deriveVaultKeys(await r.wallet(A.hidden).signMessage({ message: VAULT_KEY_MESSAGE }));
  const reg = registration(hk);
  await r.send("hidden: register Hidden Vault keys in the vault", A.hidden, { address: vault, abi: V, functionName: "setHiddenKeys", args: [reg.ownerPk, reg.viewingPub] }, async () => {
    const k = await r.read<{ ownerPk: Hex }>(vault, V, "hiddenKeysOf", [A.hidden.address]);
    expect(k.ownerPk === reg.ownerPk, "ownerPk mismatch");
    return "hiddenKeysOf(hidden).ownerPk set";
  });

  await r.check("API overview shows the Open saver's vault balance (indexer + API on testnet)", async () => {
    return await r.until("overview with the deposit", async () => {
      const res = await api(`/v1/account/${A.open.address}/overview`);
      if (res.status !== 200) return undefined;
      const s = j(res.body);
      return s.includes("300") ? `HTTP 200: ${s.slice(0, 160)}` : undefined;
    }, 180_000, 5000);
  }, "api");
}

// ---------------------------------------------------------------- round-ups

export async function roundups(x: TCtx) {
  const { r, A } = x;
  const vault = x.addr("savingsVault");
  const usdg = x.addr("usdg");
  const V = x.abi("SavingsVault");
  const from = await r.pub.getBlockNumber();
  x.data.roundupsFrom = String(from);
  const spend = 7_350_000n;
  // The merchant must not be a Plynth address (the keeper skips transfers into its own contracts and roles).
  const merchant = outsider();
  r.names.set(merchant.toLowerCase(), "merchant");
  const rc = await r.send("spending wallet pays 7.35 mUSDG at a merchant", A.spender, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [merchant, spend] });
  if (rc) {
    const want = roundUp(spend, 10, 1);
    await r.external("keeper accrues the Open saver's round-up of the 7.35 spend (indexer saw the linked wallet)", "keeper", async () => {
      const e = await r.until(`Accrued for ${rc.transactionHash}`, async () => (await events(x, vault, "SavingsVault", "Accrued", from, { user: A.open.address })).find((e) => e.args.sourceTx === rc.transactionHash), 300_000, 5000);
      expect(e.args.added === want, `added ${e.args.added}, want ${want}`);
      x.data.firstAccrual = { tx: rc.transactionHash, logIndex: Number(e.args.logIndex), spend: String(spend) };
      return { tx: e.transactionHash, assertion: `Accrued(added = ${Number(want) / 1e6} mUSDG) = (10 - 7.35) x1` };
    });
  }
  await r.reverts("only the keeper may accrue", A.open, { address: vault, abi: V, functionName: "accrue", args: [A.open.address, `0x${"ab".repeat(32)}`, 0, 1_000_000n] }, "NotKeeper");

  // Statement import (CSV) through the API for the Quiet and Hidden savers; the keeper accrues each.
  for (const [n, want] of [["quiet", roundUp(12_300_000n, 5, 2)], ["hidden", roundUp(12_300_000n, 1, 3)]] as const) {
    const u = A[n];
    const today = new Date((await chainNow(x)) * 1000).toISOString().slice(0, 10);
    const csv = `Date,Description,Amount\n${today},Coffee roasters,-12.30\n${today},Salary,2500.00\n`;
    const issuedAt = Math.floor(Date.now() / 1000);
    const sig = await r.wallet(u).signMessage({ message: roundupMessage({ action: "import", user: u.address, chainId: TESTNET_CHAIN_ID, subject: sha256Hex(csv), issuedAt }) });
    const ok = await r.check(`${n}: statement import (CSV) through the API`, async () => {
      const res = await api("/v1/roundups/import", { method: "POST", body: JSON.stringify({ user: u.address, content: csv, format: "csv", issuedAt, signature: sig }) });
      expect(res.status === 200 && res.body.imported === 1, `answer ${res.status} ${j(res.body)}`);
      return `${res.body.rows} rows, ${res.body.imported} spend imported, the credit skipped`;
    }, n);
    if (!ok) continue;
    await r.external(`keeper accrues the ${n} saver's imported 12.30 spend (${Number(want) / 1e6} mUSDG)`, "keeper", async () => {
      const e = await r.until(`Accrued for ${n}`, async () => (await events(x, vault, "SavingsVault", "Accrued", from, { user: u.address })).find((e) => e.args.spend === 12_300_000n), 300_000, 5000);
      expect(e.args.added === want, `added ${e.args.added}, want ${want}`);
      return { tx: e.transactionHash, assertion: `Accrued(spend 12.30, added ${Number(want) / 1e6})` };
    });
  }
  const fa = x.data.firstAccrual as { tx: Hex; logIndex: number; spend: string } | undefined;
  if (fa) await r.reverts("replaying an accrued spend reverts (keeper)", A.keeper, { address: vault, abi: V, functionName: "accrue", args: [A.open.address, fa.tx, fa.logIndex, BigInt(fa.spend)] }, "AlreadyAccrued");
}

// ---------------------------------------------------------------- crowd (instant part)

export async function crowd(x: TCtx) {
  const { r, A } = x;
  const crowd = x.addr("crowdBuy");
  const beacon = x.addr("jitterBeacon");
  const C = x.abi("CrowdBuy");
  const assets = ["mTSLA", "mAAPL", "mSPY"].map((s) => x.token(s));
  const from = BigInt(x.data.roundupsFrom ?? x.dep.deployBlock);
  await r.external("keeper sweeps the three savers' pending round-ups into the mTSLA / mAAPL / mSPY books", "keeper", async () => {
    await r.until("3 accounts in each book", async () => {
      for (const a of assets) if ((await r.read<[bigint, { accounts: number }]>(crowd, C, "openBook", [a]))[1].accounts !== 3) return undefined;
      return true;
    }, 300_000, 5000);
    const e = (await events(x, crowd, "CrowdBuy", "Joined", from, { asset: assets[0] }))[0];
    return { tx: e?.transactionHash, assertion: "openBook(mTSLA / mAAPL / mSPY).accounts = 3 (MIN_CROWD 3)" };
  });
  const books: Record<string, string> = {};
  for (const a of assets) books[a] = String((await r.read<[bigint]>(crowd, C, "openBook", [a]))[0]);
  x.data.books = books;
  await r.check("orders split by the mix weights (50/25/25, last entry takes the remainder)", async () => {
    const o = await Promise.all(assets.map((a) => r.read<bigint>(crowd, C, "orderOf", [a, BigInt(books[a]!), A.quiet.address])));
    const total = o[0]! + o[1]! + o[2]!;
    expect(o[0] === total / 2n && o[1] === (total * 2500n) / 10_000n, `orders ${o.join("/")}`);
    return `quiet's orders ${o.map((v) => Number(v) / 1e6).join(" / ")} mUSDG`;
  });
  const genesis = await r.read<bigint>(crowd, C, "GENESIS");
  const now = BigInt(await chainNow(x));
  const next = genesis + ((now - genesis) / BigInt(DAY) + 1n) * BigInt(DAY);
  x.data.crowdWindow = String(next);
  for (const a of assets) {
    await r.external(`keeper commits the ${r.who(a)} beacon for the next window (${new Date(Number(next) * 1000).toISOString().slice(0, 16)}Z)`, "keeper", async () => {
      const key = beaconKey(a, next);
      // From the deploy block: the keeper commits as soon as a book opens, possibly before this area started.
      const e = await r.until(`Committed ${r.who(a)}`, async () => (await events(x, beacon, "JitterBeacon", "Committed", BigInt(x.dep.deployBlock), { key }))[0], 300_000, 5000);
      return { tx: e.transactionHash, assertion: `Committed(key(${r.who(a)}, ${next}))` };
    });
  }
  await r.reverts("execute before the window's beacon time reverts", A.open, { address: crowd, abi: C, functionName: "execute", args: [assets[0]] }, "TooEarly");
  await r.check("API lists the open books", async () => {
    const res = await api("/v1/crowd/books");
    expect(res.status === 200, `HTTP ${res.status}`);
    return `HTTP 200: ${j(res.body).slice(0, 140)}`;
  }, "api");
  x.schedule({ id: "crowd-execution", handler: "crowd-execution", area: "crowd", title: "keeper reveals the beacons and executes the three books on the testnet v4 pools; Open claims, Quiet + Hidden delivered", dueAt: Number(next), args: { books, window: String(next) } });
}

// ---------------------------------------------------------------- timelocks (instant part)

export async function timelocks(x: TCtx) {
  const { r, A } = x;
  const pool = x.addr("shieldedPool");
  const P = x.abi("ShieldedPool");
  const T = x.abi("ShieldedTrade");
  const capAssets = [x.addr("usdg"), x.addr("cashVault"), ...Object.values(x.dep.stocks).map((s) => getAddress(s.token))];
  let eta = 0;
  for (const a of capAssets) {
    const [cap, e] = await r.read<[bigint, bigint]>(pool, P, "capProposal", [a]);
    expect(cap > 0n, `no cap proposal for ${a}`);
    eta = Math.max(eta, Number(e));
  }
  const [, adapterEta] = await r.read<[Address, bigint]>(x.addr("shieldedTrade"), T, "adapterProposal", [x.addr("cashVault")]);
  eta = Math.max(eta, Number(adapterEta));
  await r.reverts("Hidden Vault cap cannot apply before its 48h timelock", A.deployer, { address: pool, abi: P, functionName: "applyCap", args: [x.addr("usdg")] }, "TooEarly");
  await r.reverts("park adapter cannot apply before its 48h timelock", A.deployer, { address: x.addr("shieldedTrade"), abi: T, functionName: "applyAdapter", args: [x.addr("cashVault")] }, "TooEarly");
  await r.reverts("a Hidden Vault deposit is refused while the cap is 0", A.hidden, { address: pool, abi: P, functionName: "deposit", args: [x.addr("usdg"), 1n * U, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "0x"] }, "CapExceeded");
  x.schedule({ id: "hidden-caps", handler: "hidden-caps", area: "timelocks", title: "apply the Hidden Vault caps (mUSDG, mock vault shares, 3 mock stocks) and the park adapter after their 48h timelock", dueAt: eta + 30 });
  x.schedule({ id: "hidden-vault", handler: "hidden-vault", area: "hidden", title: "Hidden Vault: deposit -> refund; deposit -> insert (1h queue) -> withdraw through the relayer; crowd allocation delivered as a note", dueAt: eta + 120 });
}

// ---------------------------------------------------------------- perps

export async function perps(x: TCtx) {
  const { r, A } = x;
  const pool = x.addr("perpPool");
  const PP = abiOf("PerpPool");
  const PM = abiOf("PerpMarket");
  const m = getAddress(x.dep.perpMarkets.mTSLA!);
  const usdg = x.addr("usdg");
  const t = A.open;
  await mint(x, "deployer mints 1,000 mUSDG to the perp trader (open saver)", usdg, t.address, 1_000n * U);
  await r.send("trader approves the perp pool for collateral", t, { address: usdg, abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] });
  const pos = () => r.read<{ size: bigint; collateral: bigint; tokens: bigint; isLong: boolean }>(m, PM, "position", [t.address]);
  await r.send("trader opens a 1,000 mUSDG long mTSLA at 5x (feed price, keeper-refreshed)", t, { address: m, abi: PM, functionName: "open", args: [true, 1_000n * U, 200n * U, 100n] }, async () => {
    const p = await pos();
    expect(p.isLong && p.size === 1_000n * U, j(p));
    return `size 1,000, ${Number(p.tokens) / 1e18} mTSLA notional`;
  });
  await r.reverts("a second open on the same market reverts (one position per account)", t, { address: m, abi: PM, functionName: "open", args: [false, 100n * U, 50n * U, 100n] }, "HasPosition");
  await r.reverts("leverage above 50x is refused", A.quiet, { address: m, abi: PM, functionName: "open", args: [true, 10_000n * U, 100n * U, 100n] }, "Leverage");
  await r.check("funding rate: the long side pays (only longs open)", async () => {
    const [rate, longsPay] = await r.read<[bigint, boolean]>(m, PM, "fundingRate");
    expect(longsPay, `longsPay ${longsPay}`);
    return `rate ${rate} /s (1e18), longs pay`;
  });
  const b0 = await r.read<bigint>(usdg, erc20Abi, "balanceOf", [t.address]);
  await r.send("trader closes the position", t, { address: m, abi: PM, functionName: "close" }, async () => {
    expect((await pos()).size === 0n, "still open");
    const got = (await r.read<bigint>(usdg, erc20Abi, "balanceOf", [t.address])) - b0;
    return `closed; ${Number(got) / 1e6} mUSDG back (collateral +/- PnL, fees)`;
  });
  // LP: a fresh deposit starts the 24h redeem cooldown.
  await r.send("LP (deployer) approves the perp pool", A.deployer, { address: usdg, abi: erc20Abi, functionName: "approve", args: [pool, 1_000n * U] });
  const rc = await r.send("LP deposits 1,000 mUSDG into the PerpPool (ERC-4626)", A.deployer, { address: pool, abi: PP, functionName: "deposit", args: [1_000n * U, A.deployer.address] });
  await r.reverts("an LP cannot deposit for someone else (would reset their cooldown)", A.deployer, { address: pool, abi: PP, functionName: "deposit", args: [1n * U, A.quiet.address] }, "ReceiverNotSender");
  await r.reverts("an LP cannot redeem inside the 24h cooldown", A.deployer, { address: pool, abi: PP, functionName: "redeem", args: [1n, A.deployer.address, A.deployer.address] }, "ERC4626ExceededMaxRedeem");
  if (rc) {
    const at = Number((await r.pub.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    x.schedule({ id: "lp-redeem", handler: "lp-redeem", area: "perps", title: "LP redeems 1,000 mUSDG of shares after the 24h cooldown", dueAt: at + DAY + 60 });
  }
}

// ---------------------------------------------------------------- token

export async function token(x: TCtx) {
  const { r, A } = x;
  const plth = x.addr("plth");
  const st = x.addr("staking");
  const S = abiOf("PlinthStaking");
  const amount = 10_000n * E18;
  await r.send("board approves staking for 10,000 PLTH", A.deployer, { address: plth, abi: erc20Abi, functionName: "approve", args: [st, amount] });
  await r.send("board stakes 10,000 PLTH", A.deployer, { address: st, abi: S, functionName: "stake", args: [amount] }, async () => {
    const tier = await r.read<{ maxDesks: number; weeklyClose: boolean }>(st, S, "tierOf", [A.deployer.address]);
    expect(tier.maxDesks === 4 && tier.weeklyClose, `tier ${j(tier)}`);
    return "tierOf(board): maxDesks 4, weeklyClose";
  });
  const rc = await r.send("board unstakes 2,000 PLTH (7-day unbonding starts)", A.deployer, { address: st, abi: S, functionName: "unstake", args: [2_000n * E18] });
  await r.reverts("unbonding PLTH cannot be withdrawn before 7 days", A.deployer, { address: st, abi: S, functionName: "withdraw" }, "StillUnbonding");
  if (rc) {
    const e = (await events(x, st, "PlinthStaking", "Unstaked", rc.blockNumber, { staker: A.deployer.address }))[0];
    const releaseAt = Number(e?.args.releaseAt ?? 0n) || Number((await r.pub.getBlock({ blockNumber: rc.blockNumber })).timestamp) + 7 * DAY;
    x.schedule({ id: "unbonding-withdraw", handler: "unbonding-withdraw", area: "token", title: "board withdraws the 2,000 unbonded PLTH after 7 days", dueAt: releaseAt + 30 });
  }
}

// ---------------------------------------------------------------- treasury

/** Testnet treasury template: literal addresses (mock assets), small caps so guard lines are reachable. */
export function testnetTemplate(x: TCtx, controller: Address, perOrderUsd = 500) {
  return {
    name: "balanced-testnet",
    description: "Balanced on the testnet mocks: mUSDG + the mock vault as cash, mTSLA and mAAPL as equity (mSPY deliberately not allowed).",
    network: "testnet",
    bands: { cash: [40, 70], equity: [30, 60], basis: [0, 0] },
    hedge: { netDeltaBps: [0, 0], maxLeverageX10: 0 },
    limits: { perOrderUsd, perDayUsd: 2_000, approvalAboveUsd: 300, perNameFloatBps: 200, perVenueBps: 0 },
    risk: { noNewRiskOffHours: true, pauseNewRiskAtDrawdownBps: -400, deriskAtDrawdownBps: -800 },
    periodDays: 1,
    controller,
    instruments: [
      { asset: x.addr("usdg"), kind: "cash" },
      { asset: x.addr("cashVault"), kind: "cash_vault" },
      { asset: x.token("mTSLA"), kind: "stock_token" },
      { asset: x.token("mAAPL"), kind: "stock_token" },
    ],
    desks: { equity: { weights: { [x.token("mTSLA")]: 1, [x.token("mAAPL")]: 1 } } },
    venues: [],
  };
}

const PULLS = { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] } as const;
const wrap = (token: Address, amount: bigint, run: Hex) => encodeAbiParameters([PULLS, { type: "bytes" }], [[{ token, amount }], run]);
const cashRun = (op: number, vault: Address, amount: bigint, minOut: bigint) => encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [op, vault, amount, minOut]);
const equityRun = (op: number, token: Address, amount: bigint, slip: number) => encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint16" }], [op, token, amount, slip]);
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export async function treasury(x: TCtx) {
  const { r, A } = x;
  const board = A.deployer;
  const factory = x.addr("treasuryFactory");
  const F = abiOf("TreasuryFactory");
  const tpl = testnetTemplate(x, A.controller.address);
  const compiled: Compiled = compileTemplate(tpl as never, { controller: A.controller.address, network: "testnet" });
  const t: Record<string, Address> = {};
  await r.send("board deploys a treasury (TreasuryFactory, balanced-testnet policy, 1-day periods)", board, { address: factory, abi: F, functionName: "deploy", args: [encodeAbiParameters([policyAbiParam], [compiled.policy]), board.address] }, async (rc) => {
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: F, data: l.data, topics: l.topics as never }) as unknown as { eventName: string; args: Record<string, Address> };
        if (ev.eventName === "TreasuryCreated") Object.assign(t, { account: ev.args.account, policy: ev.args.policy, close: ev.args.close, approvals: ev.args.approvals });
      } catch {}
    }
    expect(!!t.account, "no TreasuryCreated");
    const [, hash] = await r.read<[unknown, Hex, number]>(t.policy!, abiOf("TreasuryPolicy"), "current");
    expect(hash === compiled.hash, "policy hash differs from the compiled one");
    return `account ${t.account}, policy v1 ${hash.slice(0, 10)}…`;
  });
  if (!t.account) throw new Error("no treasury: the rest of the treasury area depends on it");
  for (const [k, v] of Object.entries(t)) r.names.set(v.toLowerCase(), `treasury ${k}`);
  const ACC = abiOf("TreasuryAccount");
  const beacon = await r.deploy("equity desk JitterBeacon (keeper = equity desk key)", board, "JitterBeacon", [A.equityDesk.address, board.address]);
  if (beacon) t.beacon = beacon;
  await r.send("board registers the cash desk (CashSleeve over mUSDG + the mock vault)", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("cash", { size: 32 }), A.cashDesk.address, [x.addr("cashSleeve")]] });
  await r.send("board registers the equity desk (EquitySleeve over the mock stocks)", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("equity", { size: 32 }), A.equityDesk.address, [x.addr("equitySleeve")]] });
  // Small on purpose: the kit pools hold 50k mUSDG a side, so the desk's buys (~$225 a name) stay inside its slippage.
  await mint(x, "board funds the treasury with 1,000 mUSDG", x.addr("usdg"), t.account, 1_000n * U);
  await r.check("treasury NAV = $1,000 (on-chain recompute)", async () => {
    const [nav] = await r.read<[bigint, boolean]>(t.account!, ACC, "navUsd");
    expect(nav === 1_000n * E18, `NAV ${nav}`);
    return "navUsd = $1,000";
  });
  x.data.treasury = t;
  x.data.t1 = { hash: compiled.hash };

  const cashSleeve = x.addr("cashSleeve");
  const equitySleeve = x.addr("equitySleeve");
  const cashVault = x.addr("cashVault");
  const usdg = x.addr("usdg");
  const proofOf = (asset: Address) => compiled.instruments.find((i) => getAddress(i.asset) === getAddress(asset))?.proof ?? [];
  const exec = (deskId: string, adapter: Address, data: Hex, proofs: Hex[][]) => ({ address: t.account!, abi: ACC, functionName: "execute", args: [stringToHex(deskId, { size: 32 }), adapter, data, packProofs(proofs), ZERO32] }) as const;
  await r.reverts("guard: an unregistered key cannot run a desk (rule 1)", outsider(), exec("cash", cashSleeve, wrap(usdg, 1n * U, cashRun(0, cashVault, 1n * U, 0n)), [proofOf(cashVault)]), "GuardRejected(1)");
  await r.reverts("guard: buying a Stock Token the policy does not allow (mSPY) (rule 2)", A.equityDesk, exec("equity", equitySleeve, wrap(usdg, 100n * U, equityRun(0, x.token("mSPY"), 100n * U, 200)), [[]]), "GuardRejected(2)");
  await r.reverts("guard: an order above the $500 per-order cap (rule 4)", A.cashDesk, exec("cash", cashSleeve, wrap(usdg, 600n * U, cashRun(0, cashVault, 600n * U, 0n)), [proofOf(cashVault)]), "GuardRejected(4)");
  // An all-cash treasury sits above its 70% cash band, so a cash -> vault move is a band breach (rule 6) and the
  // desk runner logs it as R4_BAND; an equity buy moves toward the band, so the approval line is what stops it.
  await r.reverts("guard: a cash -> vault move while cash is above its band (rule 6)", A.cashDesk, exec("cash", cashSleeve, wrap(usdg, 100n * U, cashRun(0, cashVault, 100n * U, 0n)), [proofOf(cashVault)]), "GuardRejected(6)");
  await r.reverts("guard: a $400 mTSLA buy above the $300 approval line needs a board ticket (rule 11)", A.equityDesk, exec("equity", equitySleeve, wrap(usdg, 400n * U, equityRun(0, x.token("mTSLA"), 400n * U, 200)), [proofOf(x.token("mTSLA"))]), "GuardRejected(11)");

  // Desk runner config, then one --once pass of the real desk service with the desk keystores.
  mkdirSync(PATHS.treasury, { recursive: true });
  writeFileSync(join(PATHS.treasury, "policy.yaml"), JSON.stringify(tpl, null, 2));
  const desksConfig = join(PATHS.treasury, "desks.json");
  writeFileSync(desksConfig, JSON.stringify({ rpcUrl: RPC, account: t.account, cashSleeve, equitySleeve, vault: cashVault, beacon: t.beacon, cashDeskId: "cash", equityDeskId: "equity", policyTemplate: "policy.yaml", network: "testnet", equity: { slippageBps: 150 } }, null, 2));
  writeFileSync(join(PATHS.treasury, "services.json"), JSON.stringify({ desksConfig, account: t.account, periodClose: t.close }, null, 2));
  x.data.desksConfig = desksConfig;
  await deskPass(x, t.account, desksConfig, "first pass");

  // Policy v2 through the public 48h timelock.
  const v2 = compileTemplate(testnetTemplate(x, A.controller.address, 600) as never, { controller: A.controller.address, network: "testnet" });
  const P = abiOf("TreasuryPolicy");
  await r.reverts("only the board may propose a policy", A.cashDesk, { address: t.policy!, abi: P, functionName: "propose", args: [v2.policy] }, "NotBoard");
  await r.send("board proposes policy v2 (per-order cap $600): 48h public timelock", board, { address: t.policy!, abi: P, functionName: "propose", args: [v2.policy] }, async () => {
    const [, hash, eta] = await r.read<[unknown, Hex, bigint]>(t.policy!, P, "pending");
    expect(hash === v2.hash, "pending hash differs");
    x.schedule({ id: "policy-activate", handler: "policy-activate", area: "treasury", title: "anyone activates treasury policy v2 after its 48h timelock", dueAt: Number(eta) + 30, args: { policy: t.policy, hash: v2.hash } });
    return `pending ${hash.slice(0, 10)}…, eta ${new Date(Number(eta) * 1000).toISOString()}`;
  });
  await r.reverts("policy v2 cannot activate before its timelock", A.quiet, { address: t.policy!, abi: P, functionName: "activate" }, "TimelockActive");
  await r.check("API: treasury NAV through /v1/treasury/:account/nav", async () => {
    const res = await r.until("nav answer", async () => {
      const a = await api(`/v1/treasury/${t.account}/nav`);
      return a.status === 200 ? a : undefined;
    }, 120_000, 5000);
    return `HTTP 200: ${j(res.body).slice(0, 140)}`;
  }, "api");
  // The running treasury-desks service rebalances equity at tomorrow's beacon time.
  const tomorrow = Math.floor((await chainNow(x)) / DAY) * DAY + DAY;
  x.schedule({ id: "equity-rebalance", handler: "equity-rebalance", area: "treasury", title: "the running treasury-desks service rebalances equity (mTSLA/mAAPL) at its jittered beacon time", dueAt: tomorrow + 23 * 3600, args: { account: t.account } });
}
