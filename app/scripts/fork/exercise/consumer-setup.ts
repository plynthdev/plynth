// Eligibility (self-attestation through the running eligibility service and API, attestation on-chain, the OFAC
// list refusing a sanctioned address, buys refused without an attestation) and the savers' setup (deposits incl.
// Permit2, settings, mixes, linked wallets, Quiet and Hidden keys).
import { deriveVaultKeys, initVault, registration, VAULT_KEY_MESSAGE } from "@plynth/sdk/vault";
import { generateKeys, KEY_DERIVATION_MESSAGE, metaAddress, registerTx } from "@plynth/sdk/stealth";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, maxUint256, parseAbi, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { selfAttestationTypedData } from "@/eligibility/statement";
import { FORK_CHAIN_ID, PORTS, ROOT } from "../lib";
import { expect, j } from "./core";
import { api, approve, events, U, usdgOf, type Ctx } from "./context";

/** Runtime that answers every isValidSignature(bytes32,bytes) with the ERC-1271 magic value. */
const ALWAYS_VALID_1271 = "0x631626ba7e60e01b60005260206000f3" as Hex;

const registryAbi = parseAbi(["function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)"]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

/** Gets an attestation from the service (`port`) and submits it on-chain from the user's wallet. */
async function attest(x: Ctx, who: HDAccount, port: number, label: string) {
  const { r } = x;
  const reg = x.addr("eligibilityRegistry");
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const sig = await r.wallet(who).signTypedData(selfAttestationTypedData(FORK_CHAIN_ID, who.address, expiry));
  let att: any;
  const okCheck = await r.check(`${r.who(who)}: eligibility check through ${label} allows`, async () => {
    const res = await api(port === PORTS.api ? "/v1/eligibility/check" : "/eligibility/check", { method: "POST", port, body: JSON.stringify({ address: who.address, attestationSig: sig, expiry: expiry.toString() }) });
    expect(res.status === 200 && res.body.allowed === true, `answer ${res.status} ${j(res.body)}`);
    att = res.body.attestation;
    expect(att.chainId === FORK_CHAIN_ID && getAddress(att.registry) === reg, `attestation for chain ${att.chainId} / ${att.registry}`);
    return `allowed, flags ${att.flags}, expiry ${att.expiry}`;
  }, r.who(who));
  if (!okCheck) return;
  await r.send(`${r.who(who)}: attestation submitted on-chain`, who, { address: reg, abi: x.abi("EligibilityRegistry"), functionName: "attest", args: [att.user, BigInt(att.issuedAt), BigInt(att.expiry), att.flags, att.signature] }, async () => {
    const ok = await r.read<boolean>(reg, x.abi("EligibilityRegistry"), "isEligible", [who.address]);
    expect(ok, "isEligible false after attest");
    return "isEligible(user) == true";
  });
}

export async function eligibility(x: Ctx) {
  const { r, A } = x;
  const reg = x.addr("eligibilityRegistry");
  // Savers through the standalone service, the rest through the API mount of the same service.
  for (const n of ["open", "quiet", "hidden", "fourth"] as const) await attest(x, A[n], PORTS.eligibility, "eligibility service");
  for (const n of ["slipA", "slipB", "slipC", "saver", "staker"] as const) await attest(x, A[n], PORTS.api, "API");

  // Sanctioned address: an address on the cached OFAC list. It gets ERC-1271 code on the fork so its "signature"
  // passes the self-attestation screen; the sanctions screen must still refuse it.
  const list = JSON.parse(readFileSync(join(ROOT, "app", "data", "ofac-sdn-addresses.json"), "utf8")) as { addresses: string[] };
  const sanctioned = getAddress(list.addresses[0]!);
  r.names.set(sanctioned.toLowerCase(), "OFAC-listed address");
  const before = await r.pub.getCode({ address: sanctioned });
  await r.c.rpc("anvil_setCode", [sanctioned, ALWAYS_VALID_1271]);
  await r.check("sanctioned address refused by the eligibility service", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const res = await api("/eligibility/check", { method: "POST", port: PORTS.eligibility, body: JSON.stringify({ address: sanctioned, attestationSig: `0x${"11".repeat(65)}`, expiry: String(expiry) }) });
    expect(res.status === 200 && res.body.allowed === false, `answer ${res.status} ${j(res.body)}`);
    expect(/sanction/i.test(String(res.body.reason)), `refused for ${res.body.reason}, not sanctions`);
    return `allowed=false, reason ${res.body.reason}`;
  }, "OFAC-listed address");
  await r.c.rpc("anvil_setCode", [sanctioned, before ?? "0x"]);
  await r.check("sanctioned address has no on-chain attestation", async () => {
    expect(!(await r.read<boolean>(reg, x.abi("EligibilityRegistry"), "isEligible", [sanctioned])), "eligible");
    return "isEligible == false";
  });

  // No attestation, no buys: choosing a mix and joining a crowd both revert.
  const vault = x.addr("savingsVault");
  await r.reverts("outsider (no attestation) cannot set a buy mix", A.outsider, { address: vault, abi: x.abi("SavingsVault"), functionName: "setMix", args: [[{ stockToken: x.token("TSLA"), weightBps: 10_000 }]] }, "NotEligible");
  await r.reverts("outsider cannot join a crowd buy", A.outsider, { address: x.addr("crowdBuy"), abi: x.abi("CrowdBuy"), functionName: "join", args: [A.outsider.address] }, "NotEligible");
}

const settings = (roundTo: number, multiplier: number, weeklyCap: bigint, fixedTopUp: bigint, mode: number) => ({ roundTo, multiplier, weeklyCap, fixedTopUp, mode });

export async function savingsSetup(x: Ctx) {
  const { r, A } = x;
  const vault = x.addr("savingsVault");
  const usdg = x.addr("usdg");
  const V = x.abi("SavingsVault");
  const mix3 = [
    { stockToken: x.token("TSLA"), weightBps: 5000 },
    { stockToken: x.token("AAPL"), weightBps: 2500 },
    { stockToken: x.token("NVDA"), weightBps: 2500 },
  ];
  // Each saver tries a different (roundTo, multiplier) pair; modes Open / Quiet / Hidden / Open.
  const plan = [
    ["open", "wOpen", settings(10, 1, 500n * U, 0n, 0)],
    ["quiet", "wQuiet", settings(5, 2, 500n * U, 0n, 1)],
    ["hidden", "wHidden", settings(1, 3, 500n * U, 0n, 2)],
    ["fourth", "wFourth", settings(10, 1, 500n * U, 0n, 0)],
    ["slipA", "wSlipA", settings(10, 3, 500n * U, 0n, 0)],
    ["slipB", "wSlipB", settings(10, 3, 500n * U, 0n, 0)],
    ["slipC", "wSlipC", settings(10, 3, 500n * U, 0n, 0)],
  ] as const;
  const fromBlock = await r.pub.getBlockNumber();
  for (const [n, w, s] of plan) {
    const u = A[n];
    await approve(x, `${n}: approve vault for 300 USDG`, u, usdg, vault, 300n * U);
    const bal0 = await usdgOf(x, vault);
    await r.send(`${n}: deposit 300 USDG`, u, { address: vault, abi: V, functionName: "deposit", args: [300n * U] }, async () => {
      const [avail] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [u.address]);
      expect(avail === 300n * U, `available ${avail}`);
      expect((await usdgOf(x, vault)) - bal0 === 300n * U, "vault USDG did not grow by 300");
      return "available = 300 USDG, vault holds it";
    });
    await r.send(`${n}: settings roundTo ${s.roundTo} x${s.multiplier} mode ${["Open", "Quiet", "Hidden"][s.mode]}`, u, { address: vault, abi: V, functionName: "setSettings", args: [s] }, async () => {
      const got = await r.read<{ roundTo: number; multiplier: number; mode: number }>(vault, V, "settingsOf", [u.address]);
      expect(got.roundTo === s.roundTo && got.multiplier === s.multiplier && got.mode === s.mode, j(got));
      return `settingsOf = ${got.roundTo}/${got.multiplier}/${got.mode}`;
    });
    const mix = n.startsWith("slip") ? [{ stockToken: x.token("MSFT"), weightBps: 10_000 }] : mix3;
    await r.send(`${n}: buy mix ${mix.map((m) => `${r.who(m.stockToken)} ${m.weightBps / 100}%`).join(", ")}`, u, { address: vault, abi: V, functionName: "setMix", args: [mix] }, async () => {
      const got = await r.read<{ stockToken: Address }[]>(vault, V, "mixOf", [u.address]);
      expect(got.length === mix.length, `mix length ${got.length}`);
      return `mixOf has ${got.length} entries`;
    });
    await linkWallet(x, u, A[w]);
  }
  await r.reverts("roundTo 3 is not a valid setting", A.open, { address: vault, abi: V, functionName: "setSettings", args: [settings(3, 1, 500n * U, 0n, 0)] }, "InvalidSettings");
  await r.reverts("weekly cap above 500 USDG is refused", A.open, { address: vault, abi: V, functionName: "setSettings", args: [settings(10, 1, 501n * U, 0n, 0)] }, "InvalidSettings");
  await r.reverts("mix weights must sum to 100%", A.open, { address: vault, abi: V, functionName: "setMix", args: [[{ stockToken: x.token("TSLA"), weightBps: 9000 }]] }, "InvalidMix");

  // Quiet: the saver's stealth meta-address on the real ERC-6538 registry (it recomputes its EIP-712 domain for
  // chain 31337; a plain registerKeys does not need it).
  const q = A.quiet;
  const keys = generateKeys(await r.wallet(q).signMessage({ message: KEY_DERIVATION_MESSAGE }));
  x.state.stealthKeys = keys;
  const tx = registerTx(metaAddress(keys), x.addr("erc6538Registry"));
  await r.sendRaw("quiet: register stealth meta-address on the real ERC-6538 registry", q, { to: tx.to, data: tx.data }, async () => {
    const meta = await r.read<Hex>(x.addr("erc6538Registry"), registryAbi, "stealthMetaAddressOf", [q.address, 1n]);
    expect(meta.length > 2, "no meta-address stored");
    return `stealthMetaAddressOf(quiet, 1) = ${meta.length / 2 - 1} bytes`;
  });

  // Hidden: note owner key + viewing key registered in the vault (Poseidon2 needs the WASM loaded once).
  await initVault();
  const hk = deriveVaultKeys(await r.wallet(A.hidden).signMessage({ message: VAULT_KEY_MESSAGE }));
  x.state.hiddenKeys = hk;
  const reg = registration(hk);
  await r.send("hidden: register Hidden Vault keys in the vault", A.hidden, { address: vault, abi: V, functionName: "setHiddenKeys", args: [reg.ownerPk, reg.viewingPub] }, async () => {
    const k = await r.read<{ ownerPk: Hex }>(vault, V, "hiddenKeysOf", [A.hidden.address]);
    expect(k.ownerPk === reg.ownerPk, "ownerPk mismatch");
    return "hiddenKeysOf(hidden).ownerPk set";
  });

  // The no-mix saver: Permit2 deposit (real Permit2, signature for chain 31337), a 25 USDG weekly top-up through
  // a Permit2 allowance, a 20 USDG weekly cap, roundTo 10 x3.
  const s = A.saver;
  await approve(x, "saver: approve Permit2 for USDG", s, usdg, x.addr("permit2"), maxUint256);
  const nonce = BigInt(Date.now());
  const deadline = (await r.now()) + 3600n;
  const amount = 100n * U;
  const sig = await r.wallet(s).signTypedData({
    domain: { name: "Permit2", chainId: FORK_CHAIN_ID, verifyingContract: x.addr("permit2") },
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
  });
  await r.send("saver: depositWithPermit2 100 USDG (Permit2 signature on chain 31337)", s, { address: vault, abi: V, functionName: "depositWithPermit2", args: [amount, { permitted: { token: usdg, amount }, nonce, deadline }, sig] }, async (rc) => {
    const [avail] = await r.read<[bigint, bigint]>(vault, V, "balancesOf", [s.address]);
    expect(avail === amount, `available ${avail}`);
    const ev = await events(x, vault, "SavingsVault", "Deposited", rc.blockNumber, { user: s.address });
    expect(ev.some((e) => e.args.viaPermit2 === true), "no Deposited(viaPermit2=true)");
    return "available = 100 USDG, Deposited(viaPermit2 = true)";
  });
  await r.send("saver: settings roundTo 10 x3, weekly cap 20 USDG, fixed top-up 25 USDG", s, { address: vault, abi: V, functionName: "setSettings", args: [settings(10, 3, 20n * U, 25n * U, 0)] });
  const exp = Number((await r.now()) + 30n * 86400n);
  await r.send("saver: Permit2 allowance for the vault (25 USDG top-ups)", s, { address: x.addr("permit2"), abi: permit2Abi, functionName: "approve", args: [usdg, vault, 1_000n * U, exp] }, async () => {
    const [amt] = await r.read<[bigint, number, number]>(x.addr("permit2"), permit2Abi, "allowance", [s.address, usdg, vault]);
    expect(amt === 1_000n * U, `allowance ${amt}`);
    return "Permit2 allowance(saver, USDG, vault) = 1000 USDG";
  });
  await linkWallet(x, s, A.wSaver);
  x.state.setupBlock = fromBlock;
}

async function linkWallet(x: Ctx, user: HDAccount, wallet: HDAccount) {
  const { r } = x;
  const vault = x.addr("savingsVault");
  const V = x.abi("SavingsVault");
  const nonce = await r.read<bigint>(vault, V, "linkNonce", [wallet.address]);
  const deadline = (await r.now()) + 3600n;
  const sig = await r.wallet(wallet).signTypedData({
    domain: { name: "Plynth SavingsVault", version: "1", chainId: FORK_CHAIN_ID, verifyingContract: vault },
    types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "LinkWallet",
    message: { user: user.address, wallet: wallet.address, nonce, deadline },
  });
  await r.send(`${r.who(user)}: link spending wallet ${r.who(wallet)} (EIP-712 on chain 31337)`, user, { address: vault, abi: V, functionName: "linkSpendingWallet", args: [wallet.address, deadline, sig] }, async () => {
    const linked = await r.read<Address>(vault, V, "linkedUser", [wallet.address]);
    expect(getAddress(linked) === user.address, `linkedUser = ${linked}`);
    return `linkedUser(${r.who(wallet)}) = ${r.who(user)}`;
  });
}
