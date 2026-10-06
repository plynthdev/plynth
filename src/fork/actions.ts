// Dashboard actions against the local fork. The API builds unsigned transactions where it has a builder
// (settings, deposit, withdraw, mix, claimOpen); the rest are encoded here or by the SDK. The wallet signs every
// transaction; each action reports the hash as soon as it exists and resolves after the receipt.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  api,
  deployment,
  relayer,
  type ApiTx,
  type Mode,
  type Settings,
  type Statements,
} from "./api";
import { forkConfig } from "./config";
import {
  ATTESTATION_TTL_S,
  mixFromPercents,
  parseUsdg,
  roundupMessage,
  selfAttestationTypedData,
  sha256Hex,
} from "./logic";
import {
  currentAccount,
  publicClient,
  sendAndWait,
  signText,
  signTyped,
  type SentTx,
} from "./wallet";

export type Progress = (msg: string, hash?: Hex) => void;

const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function attest(address user, uint64 issuedAt, uint64 expiry, uint32 flags, bytes sig)",
  "function isEligible(address user) view returns (bool)",
]);
const crowdAbi = parseAbi([
  "function join(address user)",
  "function allocationOf(address asset, uint256 bookId, address user) view returns (uint256)",
  "function settled(address asset, uint256 bookId, address user) view returns (bool)",
  "event Joined(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg)",
]);
const vaultAbi = parseAbi([
  "function balancesOf(address user) view returns (uint256 available, uint256 pending)",
  "function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)",
  "function hiddenKeysOf(address user) view returns ((bytes32 ownerPk, bytes32 viewingPub))",
]);
const poolAbi = parseAbi(["function cap(address asset) view returns (uint256)"]);
const stealthRegistryAbi = parseAbi([
  "function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)",
]);
const stealthClaimsAbi = parseAbi([
  "function nonces(address stealth) view returns (uint256)",
  "function balanceOf(address token, address stealth) view returns (uint256)",
]);

function me(): Address {
  const a = currentAccount();
  if (!a) throw new Error("Connect a wallet first.");
  return a.address;
}

async function send(
  label: string,
  tx: ApiTx | { to: Address; data: Hex },
  p?: Progress,
): Promise<SentTx> {
  p?.(`${label}: waiting for the wallet…`);
  const r = await sendAndWait(tx, (h) => p?.(`${label}: sent, waiting for the receipt…`, h));
  p?.(`${label}: confirmed in block ${r.receipt.blockNumber}`, r.hash);
  return r;
}

const chainNow = async () => (await publicClient().getBlock({ blockTag: "latest" })).timestamp;

// ---------------------------------------------------------------- eligibility

export async function isEligible(user: Address): Promise<boolean> {
  const d = await deployment();
  return publicClient().readContract({
    address: d.eligibilityRegistry,
    abi: registryAbi,
    functionName: "isEligible",
    args: [user],
  });
}

/** Self-attestation: sign the statement, get the screening service's attestation, submit it on-chain. */
export async function attestEligibility(p?: Progress): Promise<SentTx> {
  const user = me();
  const d = await deployment();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + ATTESTATION_TTL_S);
  p?.("Sign the eligibility statement in your wallet…");
  const sig = await signTyped(
    selfAttestationTypedData(forkConfig().chainId, user, expiry) as never,
  );
  const res = await api.post<{
    allowed: boolean;
    reason?: string;
    attestation?: {
      user: Address;
      issuedAt: string | number;
      expiry: string | number;
      flags: number;
      signature: Hex;
    };
  }>("/v1/eligibility/check", { address: user, attestationSig: sig, expiry: expiry.toString() });
  if (!res.allowed || !res.attestation) throw new Error(`Not eligible: ${res.reason ?? "refused"}`);
  const a = res.attestation;
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "attest",
    args: [getAddress(a.user), BigInt(a.issuedAt), BigInt(a.expiry), a.flags, a.signature],
  });
  return send("Eligibility attestation", { to: d.eligibilityRegistry, data }, p);
}

// ---------------------------------------------------------------- savings

export async function deposit(amount: string, p?: Progress): Promise<SentTx> {
  const user = me();
  const d = await deployment();
  const raw = parseUsdg(amount);
  const allowance = await publicClient().readContract({
    address: d.usdg,
    abi: erc20,
    functionName: "allowance",
    args: [user, d.savingsVault],
  });
  if (allowance < raw)
    await send("Approve USDG", await api.post<ApiTx>("/v1/tx/approveUsdg", { amount }), p);
  return send(`Deposit ${amount} USDG`, await api.post<ApiTx>("/v1/tx/deposit", { amount }), p);
}

export async function withdraw(
  amount: string,
  to: string | undefined,
  p?: Progress,
): Promise<SentTx> {
  parseUsdg(amount);
  return send(
    `Withdraw ${amount} USDG`,
    await api.post<ApiTx>("/v1/tx/withdraw", { amount, to: to || me() }),
    p,
  );
}

/** Everything in the vault (available + pending) back to the wallet. */
export async function withdrawAll(p?: Progress): Promise<SentTx | null> {
  const user = me();
  const d = await deployment();
  const [a, b] = await publicClient().readContract({
    address: d.savingsVault,
    abi: vaultAbi,
    functionName: "balancesOf",
    args: [user],
  });
  const total = a + b;
  if (total === 0n) return null;
  const amount = `${total / 1_000_000n}.${(total % 1_000_000n).toString().padStart(6, "0")}`;
  return send(
    `Withdraw all (${amount} USDG)`,
    await api.post<ApiTx>("/v1/tx/withdraw", { amount, to: user }),
    p,
  );
}

export type SettingsForm = {
  roundTo: number;
  multiplier: number;
  weeklyCap: string;
  fixedTopUp: string;
  mode: Mode;
};

export async function saveSettings(s: SettingsForm, p?: Progress): Promise<SentTx> {
  return send("Save settings", await api.post<ApiTx>("/v1/tx/setSettings", s), p);
}

export async function saveMix(
  rows: { token: Address; percent: string }[],
  p?: Progress,
): Promise<SentTx> {
  return send(
    "Save buy mix",
    await api.post<ApiTx>("/v1/tx/setMix", { mix: mixFromPercents(rows) }),
    p,
  );
}

export async function vaultBalances(
  user: Address,
): Promise<{ available: bigint; pending: bigint }> {
  const d = await deployment();
  const [available, pending] = await publicClient().readContract({
    address: d.savingsVault,
    abi: vaultAbi,
    functionName: "balancesOf",
    args: [user],
  });
  return { available, pending };
}

/** Round-ups from a bank statement (CSV): signed by the wallet, accrued by the keeper. */
export async function importStatement(
  csv: string,
  p?: Progress,
): Promise<{ imported: number; rows: number }> {
  const user = getAddress(me());
  const issuedAt = Math.floor(Date.now() / 1000);
  p?.("Sign the statement import in your wallet…");
  const signature = await signText(
    roundupMessage({
      action: "import",
      user,
      chainId: forkConfig().chainId,
      subject: await sha256Hex(csv),
      issuedAt,
    }),
  );
  const res = await api.post<{ imported: number; rows: number }>("/v1/roundups/import", {
    user,
    content: csv,
    format: "csv",
    issuedAt,
    signature,
  });
  p?.(`Statement imported: ${res.imported} spend(s) of ${res.rows} rows; the keeper accrues them`);
  return res;
}

// ---------------------------------------------------------------- crowd

/** CrowdBuy.join(me): moves my pending round-ups into the open books (the keeper also does this on its own). */
export async function joinCrowd(p?: Progress): Promise<SentTx> {
  const user = me();
  const d = await deployment();
  const { pending } = await vaultBalances(user);
  if (pending === 0n)
    throw new Error(
      "Nothing pending to join: round-ups accrue first (or the keeper already joined them).",
    );
  try {
    return await send(
      "Join the crowd",
      {
        to: d.crowdBuy,
        data: encodeFunctionData({ abi: crowdAbi, functionName: "join", args: [user] }),
      },
      p,
    );
  } catch (e) {
    // The keeper sweeps every few seconds: if it got there first, say so instead of showing a raw revert.
    // Its sweep may still be in the mempool (the wallet estimates against the pending block): give it a few blocks.
    for (let i = 0; i < 10; i++) {
      if ((await vaultBalances(user)).pending === 0n)
        throw new Error("Nothing pending to join: the keeper already joined your round-ups.");
      await new Promise((r) => setTimeout(r, 500));
    }
    throw e;
  }
}

export type Claimable = { asset: Address; bookId: bigint; raw: bigint };

/** Executed books I joined and have not settled: what claimOpen can take now. */
export async function claimables(user: Address): Promise<Claimable[]> {
  const d = await deployment();
  const pub = publicClient();
  const logs = await pub.getLogs({
    address: d.crowdBuy,
    event: crowdAbi[3],
    args: { user },
    fromBlock: BigInt(d.deployBlock),
    toBlock: "latest",
  });
  const seen = new Map<string, { asset: Address; bookId: bigint }>();
  for (const l of logs)
    seen.set(`${l.args.asset}:${l.args.bookId}`, { asset: l.args.asset!, bookId: l.args.bookId! });
  const out: Claimable[] = [];
  for (const k of seen.values()) {
    const [done, raw] = await Promise.all([
      pub.readContract({
        address: d.crowdBuy,
        abi: crowdAbi,
        functionName: "settled",
        args: [k.asset, k.bookId, user],
      }),
      pub.readContract({
        address: d.crowdBuy,
        abi: crowdAbi,
        functionName: "allocationOf",
        args: [k.asset, k.bookId, user],
      }),
    ]);
    if (!done && raw > 0n) out.push({ ...k, raw });
  }
  return out;
}

export async function claimOpenAll(p?: Progress): Promise<SentTx[]> {
  const list = await claimables(me());
  if (!list.length)
    throw new Error("Nothing to claim: no executed Crowd Buy allocation is waiting.");
  const sent: SentTx[] = [];
  for (const c of list)
    sent.push(
      await send(
        `Claim book ${c.bookId}`,
        await api.post<ApiTx>("/v1/tx/claimOpen", { asset: c.asset, bookId: c.bookId.toString() }),
        p,
      ),
    );
  return sent;
}

// ---------------------------------------------------------------- privacy modes

const stealthMod = () => import("@plynth/sdk/stealth");
// The vault module (bb.js WASM, Noir) needs Buffer; load the polyfill first, and only when Hidden is used.
const vaultMod = async () => {
  await import("./polyfills");
  return import("@plynth/sdk/vault");
};

type StealthKeys = Awaited<ReturnType<typeof stealthMod>>["generateKeys"] extends (
  ...a: never[]
) => infer R
  ? R
  : never;
type VaultKeys = Awaited<ReturnType<typeof vaultMod>>["deriveVaultKeys"] extends (
  ...a: never[]
) => infer R
  ? R
  : never;
// Keys are derived from a wallet signature on demand and kept in memory only (never stored, never sent).
const stealthKeysOf = new Map<string, StealthKeys>();
const vaultKeysOf = new Map<string, VaultKeys>();

async function stealthKeys(p?: Progress): Promise<StealthKeys> {
  const user = me();
  const hit = stealthKeysOf.get(user);
  if (hit) return hit;
  const s = await stealthMod();
  p?.("Sign the Quiet key message in your wallet (derives your stealth keys)…");
  const keys = s.generateKeys(await signText(s.KEY_DERIVATION_MESSAGE));
  stealthKeysOf.set(user, keys);
  return keys;
}

async function vaultKeys(p?: Progress): Promise<VaultKeys> {
  const user = me();
  const hit = vaultKeysOf.get(user);
  if (hit) return hit;
  const v = await vaultMod();
  await v.initVault();
  p?.("Sign the Hidden Vault key message in your wallet (derives your note keys)…");
  const keys = v.deriveVaultKeys(await signText(v.VAULT_KEY_MESSAGE));
  vaultKeysOf.set(user, keys);
  return keys;
}

export async function hasMetaAddress(user: Address): Promise<boolean> {
  const d = await deployment();
  const meta = await publicClient().readContract({
    address: d.erc6538Registry,
    abi: stealthRegistryAbi,
    functionName: "stealthMetaAddressOf",
    args: [user, 1n],
  });
  return meta.length > 2;
}

export async function hasHiddenKeys(user: Address): Promise<boolean> {
  const d = await deployment();
  const k = await publicClient().readContract({
    address: d.savingsVault,
    abi: vaultAbi,
    functionName: "hiddenKeysOf",
    args: [user],
  });
  return BigInt(k.ownerPk) !== 0n;
}

const DEFAULT_SETTINGS = { roundTo: 1, multiplier: 1, weeklyCap: "50", fixedTopUp: "0" };

/** Open / Quiet / Hidden. Quiet registers the ERC-6538 meta-address first, Hidden registers the vault keys first. */
export async function switchMode(mode: Mode, p?: Progress): Promise<SentTx[]> {
  const user = me();
  const d = await deployment();
  const sent: SentTx[] = [];
  if (mode === "quiet" && !(await hasMetaAddress(user))) {
    const s = await stealthMod();
    const keys = await stealthKeys(p);
    const tx = s.registerTx(s.metaAddress(keys), d.erc6538Registry);
    sent.push(
      await send("Register stealth meta-address (ERC-6538)", { to: tx.to, data: tx.data }, p),
    );
  }
  if (mode === "hidden" && !(await hasHiddenKeys(user))) {
    const v = await vaultMod();
    const reg = v.registration(await vaultKeys(p));
    sent.push(
      await send(
        "Register Hidden Vault keys",
        {
          to: d.savingsVault,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: "setHiddenKeys",
            args: [reg.ownerPk, reg.viewingPub],
          }),
        },
        p,
      ),
    );
  }
  const cur = await api.get<Settings>(`/v1/account/${user}/settings`);
  const base = cur.configured
    ? {
        roundTo: cur.roundTo,
        multiplier: cur.multiplier,
        weeklyCap: cur.weeklyCap,
        fixedTopUp: cur.fixedTopUp,
      }
    : DEFAULT_SETTINGS;
  sent.push(await saveSettings({ ...base, mode }, p));
  return sent;
}

export type StealthPart = { stealth: Address; token: Address; raw: bigint };

/** Announcements from CrowdBuy that my viewing key recognises and that still hold tokens. */
export async function quietParts(p?: Progress): Promise<StealthPart[]> {
  const d = await deployment();
  const s = await stealthMod();
  const keys = await stealthKeys(p);
  const pub = publicClient();
  const logs = await pub.getLogs({
    address: d.erc5564Announcer,
    event: s.announcementEvent,
    args: { caller: d.crowdBuy },
    fromBlock: BigInt(d.deployBlock),
    toBlock: "latest",
  });
  const hits = s.scan(
    logs.map((l) => s.decodeAnnouncementLog(l as never)),
    keys.viewingPrivateKey,
    keys.spendingPublicKey,
    { callers: [d.crowdBuy] },
  );
  const out: StealthPart[] = [];
  for (const h of hits) {
    if (!h.token) continue;
    const bal = await pub.readContract({
      address: d.stealthClaims,
      abi: stealthClaimsAbi,
      functionName: "balanceOf",
      args: [h.token, h.stealthAddress],
    });
    if (bal > 0n) out.push({ stealth: h.stealthAddress, token: h.token, raw: bal });
  }
  return out;
}

/** Claims every waiting stealth part to `to` through the relayer (the relayer pays gas; no funding link). */
export async function quietClaim(to: string, p?: Progress): Promise<Hex[]> {
  const dest = getAddress(to);
  const d = await deployment();
  const s = await stealthMod();
  const keys = await stealthKeys(p);
  const pub = publicClient();
  const logs = await pub.getLogs({
    address: d.erc5564Announcer,
    event: s.announcementEvent,
    args: { caller: d.crowdBuy },
    fromBlock: BigInt(d.deployBlock),
    toBlock: "latest",
  });
  const hits = s.scan(
    logs.map((l) => s.decodeAnnouncementLog(l as never)),
    keys.viewingPrivateKey,
    keys.spendingPublicKey,
    { callers: [d.crowdBuy] },
  );
  const hashes: Hex[] = [];
  for (const h of hits) {
    if (!h.token) continue;
    const raw = await pub.readContract({
      address: d.stealthClaims,
      abi: stealthClaimsAbi,
      functionName: "balanceOf",
      args: [h.token, h.stealthAddress],
    });
    if (raw === 0n) continue;
    const nonce = await pub.readContract({
      address: d.stealthClaims,
      abi: stealthClaimsAbi,
      functionName: "nonces",
      args: [h.stealthAddress],
    });
    const signed = await s.signClaim(s.keyForHit(h, keys), forkConfig().chainId, d.stealthClaims, {
      token: h.token,
      to: dest,
      raw,
      nonce,
      deadline: (await chainNow()) + 3600n,
    });
    p?.(`Relayer claim of a stealth part: submitting…`);
    const res = await relayer.post<{ txHash: Hex }>("/claim", {
      token: signed.message.token,
      stealth: signed.message.stealth,
      to: dest,
      raw: signed.message.raw.toString(),
      deadline: signed.message.deadline.toString(),
      sig: signed.sig,
    });
    p?.("Relayer claim: sent, waiting for the receipt…", res.txHash);
    const rc = await pub.waitForTransactionReceipt({ hash: res.txHash });
    if (rc.status !== "success") throw new Error(`relayer claim ${res.txHash} reverted`);
    p?.(
      `Relayer claim: confirmed in block ${rc.blockNumber} (gas paid by the relayer)`,
      res.txHash,
    );
    hashes.push(res.txHash);
  }
  if (!hashes.length)
    throw new Error(
      "No stealth part is waiting for you yet (the keeper releases parts after crowd executions).",
    );
  return hashes;
}

// ---------------------------------------------------------------- Hidden Vault

export async function hiddenDeposit(amount: string, p?: Progress): Promise<SentTx> {
  const user = me();
  const d = await deployment();
  const raw = parseUsdg(amount);
  const v = await vaultMod();
  const keys = await vaultKeys(p);
  const cap = await publicClient().readContract({
    address: d.shieldedPool,
    abi: poolAbi,
    functionName: "cap",
    args: [d.usdg],
  });
  if (cap === 0n)
    throw new Error(
      "Hidden Vault deposits are closed: the USDG cap is 0 until its 48 h timelock passes and someone calls applyCap (runbooks/browser-testing.md).",
    );
  const allowance = await publicClient().readContract({
    address: d.usdg,
    abi: erc20,
    functionName: "allowance",
    args: [user, d.shieldedPool],
  });
  if (allowance < raw)
    await send("Approve USDG for the Hidden Vault", v.approveTx(d.usdg, d.shieldedPool, raw), p);
  const tx = v.depositTx(d.shieldedPool, d.usdg, raw, keys);
  return send(`Hidden deposit ${amount} USDG`, { to: tx.to, data: tx.data }, p);
}

export type HiddenNote = {
  asset: Address;
  raw: bigint;
  leafIndex: number | null;
  spent: boolean;
  version?: number;
};

let poolState: unknown;
async function syncedNotes(p?: Progress) {
  const d = await deployment();
  const v = await vaultMod();
  const keys = await vaultKeys(p);
  poolState = await v.syncPool(publicClient(), d.shieldedPool, poolState as never, {
    fromBlock: BigInt(d.deployBlock),
    ...(d.shieldedTrade ? { trade: d.shieldedTrade } : {}),
  });
  return {
    v,
    keys,
    state: poolState as Awaited<ReturnType<typeof v.syncPool>>,
    notes: v.myNotes(poolState as never, keys),
  };
}

export async function hiddenNotes(p?: Progress): Promise<HiddenNote[]> {
  const { notes } = await syncedNotes(p);
  return notes.map((n) => ({
    asset: n.asset,
    raw: n.raw,
    leafIndex: n.leafIndex,
    spent: n.spent,
    version: (n as { version?: number }).version,
  }));
}

/** Proves (in the browser, UltraHonk) and sends a withdraw of my largest unspent USDG note to `to`. */
export async function hiddenWithdraw(to: string, p?: Progress): Promise<SentTx> {
  const dest = getAddress(to);
  const d = await deployment();
  const { v, keys, state, notes } = await syncedNotes(p);
  const usable = notes
    .filter(
      (n) =>
        !n.spent &&
        n.leafIndex !== null &&
        getAddress(n.asset) === getAddress(d.usdg) &&
        (n as { version?: number }).version !== 2,
    )
    .sort((a, b) => (a.raw > b.raw ? -1 : 1));
  const note = usable[0];
  if (!note)
    throw new Error(
      "No spendable USDG note yet (a deposit waits about an hour before the keeper inserts it).",
    );
  p?.("Proving the withdraw in your browser (UltraHonk)…");
  const w = await v.proveWithdraw({
    keys,
    tree: state.tree,
    note,
    amount: note.raw,
    recipient: dest,
  });
  const tx = v.withdrawTx(d.shieldedPool, w);
  return send(`Hidden withdraw ${Number(note.raw) / 1e6} USDG`, { to: tx.to, data: tx.data }, p);
}

export async function statementsOf(user: Address): Promise<Statements> {
  return api.get<Statements>(`/v1/statements/${user}`);
}
