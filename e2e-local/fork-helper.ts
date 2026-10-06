// Backend helper for the local-fork e2e (Node side of the Playwright run). It plays the parts a single browser
// user cannot: two more savers so a Crowd Buy book reaches MIN_CROWD, and chain time (evm_increaseTime) so the
// keeper's commit / reveal / execute and the Hidden Vault's pending delay happen in minutes. The keeper, indexer,
// API and relayer that do the real work are the running fork services (backend/app/scripts/fork/up.sh).
// Keys: anvil's PUBLIC dev mnemonic only (test-key). Talks to 127.0.0.1 only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

export const RPC = process.env.VITE_RPC_URL || "http://127.0.0.1:8545";
export const API = process.env.VITE_API_URL || "http://127.0.0.1:8789";
const CHAIN_ID = 31337;
const MNEMONIC = "test test test test test test test test test test test junk"; // test-key (anvil default mnemonic)
export const U = 1_000_000n;

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Plynth fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
export const pub = createPublicClient({
  chain,
  transport: http(RPC),
  pollingInterval: 200,
}) as PublicClient;
export const devAccount = (i: number): HDAccount =>
  mnemonicToAccount(MNEMONIC, { addressIndex: i }); // test-key

export type Dep = {
  deployBlock: number;
  savingsVault: Address;
  crowdBuy: Address;
  jitterBeacon: Address;
  usdg: Address;
  eligibilityRegistry: Address;
  shieldedPool: Address;
  stealthClaims: Address;
  stocks: Record<string, { token: Address }>;
};
export const dep: Dep = JSON.parse(
  readFileSync(
    resolve(process.env.FORK_DEPLOYMENT_JSON || "../backend/app/deployments/fork.json"),
    "utf8",
  ),
);

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vault = parseAbi([
  "function deposit(uint256 amount)",
  "function setSettings((uint8 roundTo, uint8 multiplier, uint64 weeklyCap, uint64 fixedTopUp, uint8 mode) s)",
  "function setMix((address stockToken, uint16 weightBps)[] mix)",
  "function balancesOf(address user) view returns (uint256 available, uint256 pending)",
]);
const registry = parseAbi([
  "function attest(address user, uint64 issuedAt, uint64 expiry, uint32 flags, bytes sig)",
  "function isEligible(address) view returns (bool)",
]);
export const crowdAbi = parseAbi([
  "function GENESIS() view returns (uint64)",
  "function WINDOW() view returns (uint64)",
  "function openBook(address asset) view returns (uint256 bookId, (uint256 usdgTotal, uint32 accounts, uint64 openedAt, uint256 rawOut, bool executed) b)",
  "function book(address asset, uint256 bookId) view returns ((uint256 usdgTotal, uint32 accounts, uint64 openedAt, uint256 rawOut, bool executed))",
  "function orderOf(address asset, uint256 bookId, address user) view returns (uint256)",
]);
const beaconAbi = parseAbi([
  "function beacon(bytes32 key) view returns ((uint64 windowStart, uint64 windowEnd, uint64 executeAt, bytes32 commitment))",
]);
const poolAbi = parseAbi([
  "function insertPending(uint256 maxCount)",
  "function applyCap(address asset)",
  "function cap(address asset) view returns (uint256)",
]);

export const rpc = <T>(method: string, params: unknown[] = []) =>
  pub.request({ method: method as never, params: params as never }) as Promise<T>;
export const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;

/** Moves chain time forward by `s` seconds and mines a block. */
export async function warp(s: bigint) {
  if (s <= 0n) return;
  await rpc("evm_increaseTime", [Number(s)]);
  await rpc("evm_mine");
}
export const warpTo = async (t: bigint) => warp(t - (await now()));

export async function until<T>(
  what: string,
  f: () => Promise<T | undefined | false | null>,
  timeoutMs = 120_000,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}`,
  );
}

async function send(
  acct: HDAccount,
  to: Address,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[],
) {
  const w = createWalletClient({ account: acct, chain, transport: http(RPC) });
  const { request } = await pub.simulateContract({
    account: acct,
    address: to,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
  });
  const hash = await w.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(j)}`);
  return j;
}

const STATEMENT =
  "I am not a person of the United States, the United Kingdom, Canada or Switzerland (not a resident, " +
  "citizen or entity there) and I do not act for one. I understand Stock Tokens are not offered to them.";

/** A helper saver: attested, 100 USDG deposited, roundTo 10, 100% `symbol`. */
export async function onboardSaver(i: number, symbol: string) {
  const a = devAccount(i);
  const token = dep.stocks[symbol]!.token;
  if (
    !(await pub.readContract({
      address: dep.eligibilityRegistry,
      abi: registry,
      functionName: "isEligible",
      args: [a.address],
    }))
  ) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 300 * 86400);
    const sig = await a.signTypedData({
      domain: { name: "Plynth Eligibility", version: "1", chainId: CHAIN_ID },
      types: {
        SelfAttestation: [
          { name: "wallet", type: "address" },
          { name: "statement", type: "string" },
          { name: "version", type: "uint32" },
          { name: "expiry", type: "uint64" },
        ],
      },
      primaryType: "SelfAttestation",
      message: { wallet: a.address, statement: STATEMENT, version: 1, expiry },
    });
    const res = (await post("/v1/eligibility/check", {
      address: a.address,
      attestationSig: sig,
      expiry: expiry.toString(),
    })) as {
      allowed: boolean;
      attestation: {
        user: Address;
        issuedAt: string;
        expiry: string;
        flags: number;
        signature: Hex;
      };
    };
    if (!res.allowed) throw new Error(`helper ${i} not eligible`);
    const t = res.attestation;
    await send(a, dep.eligibilityRegistry, registry, "attest", [
      t.user,
      BigInt(t.issuedAt),
      BigInt(t.expiry),
      t.flags,
      t.signature,
    ]);
  }
  await send(a, dep.usdg, erc20, "approve", [dep.savingsVault, 100n * U]);
  await send(a, dep.savingsVault, vault, "deposit", [100n * U]);
  await send(a, dep.savingsVault, vault, "setSettings", [
    { roundTo: 10, multiplier: 1, weeklyCap: 500n * U, fixedTopUp: 0n, mode: 0 },
  ]);
  await send(a, dep.savingsVault, vault, "setMix", [[{ stockToken: token, weightBps: 10_000 }]]);
  return a;
}

/** Imports a one-spend CSV statement for a helper (same signed route the dashboard uses); the keeper accrues it. */
export async function importSpend(i: number, description: string, amount: string, date: string) {
  const a = devAccount(i);
  const csv = `Date,Description,Amount\n${date},${description},-${amount}\n`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const subject = createHash("sha256").update(csv).digest("hex");
  const message = [
    "Plynth round-up sources",
    "action: import",
    `user: ${getAddress(a.address)}`,
    `chain: ${CHAIN_ID}`,
    `subject: ${subject}`,
    `issued: ${issuedAt}`,
  ].join("\n");
  const signature = await a.signMessage({ message });
  return post("/v1/roundups/import", {
    user: a.address,
    content: csv,
    format: "csv",
    issuedAt,
    signature,
  });
}

export const chainDate = async () =>
  new Date(Number(await now()) * 1000).toISOString().slice(0, 10);

/** Waits until `user` has an order in the open book of `asset` (the keeper or the user joined). */
export async function waitOrder(asset: Address, user: Address, timeoutMs = 120_000) {
  return until(
    `order of ${user} in the ${asset} book`,
    async () => {
      const [bookId] = await pub.readContract({
        address: dep.crowdBuy,
        abi: crowdAbi,
        functionName: "openBook",
        args: [asset],
      });
      const o = await pub.readContract({
        address: dep.crowdBuy,
        abi: crowdAbi,
        functionName: "orderOf",
        args: [asset, bookId, user],
      });
      return o > 0n ? { bookId, order: o } : undefined;
    },
    timeoutMs,
  );
}

const beaconKey = (asset: Address, start: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [asset, start]));

/**
 * One Crowd Buy round for `asset` driven by the running keeper: wait for its commit of the next window, warp into
 * the window, wait for its reveal, warp to the revealed time, wait for its execution. Returns the executed book id.
 */
export async function executeRound(asset: Address, log: (s: string) => void = () => {}) {
  const [bookId, b] = await pub.readContract({
    address: dep.crowdBuy,
    abi: crowdAbi,
    functionName: "openBook",
    args: [asset],
  });
  log(`book ${bookId}: ${b.accounts} accounts, ${Number(b.usdgTotal) / 1e6} USDG`);
  const [genesis, window] = await Promise.all([
    pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "GENESIS" }),
    pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "WINDOW" }),
  ]);
  const t = await now();
  const next = genesis + ((t - genesis) / window + 1n) * window;
  const key = beaconKey(asset, next);
  await until(
    "keeper commits the next window's beacon",
    async () =>
      BigInt(
        (
          await pub.readContract({
            address: dep.jitterBeacon,
            abi: beaconAbi,
            functionName: "beacon",
            args: [key],
          })
        ).commitment,
      ) !== 0n,
  );
  log(`beacon committed for window ${next}`);
  await warpTo(next + 60n);
  const executeAt = await until("keeper reveals the beacon", async () => {
    const x = await pub.readContract({
      address: dep.jitterBeacon,
      abi: beaconAbi,
      functionName: "beacon",
      args: [key],
    });
    return x.executeAt !== 0n ? x.executeAt : undefined;
  });
  log(`revealed: executes at window + ${Number(executeAt - next) / 3600} h`);
  if ((await now()) < executeAt) await warpTo(executeAt + 1n);
  await until(
    "keeper executes the book",
    async () =>
      (
        await pub.readContract({
          address: dep.crowdBuy,
          abi: crowdAbi,
          functionName: "book",
          args: [asset, bookId],
        })
      ).executed,
    180_000,
  );
  const done = await pub.readContract({
    address: dep.crowdBuy,
    abi: crowdAbi,
    functionName: "book",
    args: [asset, bookId],
  });
  log(`executed: ${Number(done.usdgTotal) / 1e6} USDG -> ${done.rawOut} raw`);
  return bookId;
}

/** The fork deploy only PROPOSES the Hidden Vault's USDG cap (48 h timelock); anyone applies it afterwards. */
export async function applyHiddenUsdgCap(log: (s: string) => void = () => {}) {
  if (
    (await pub.readContract({
      address: dep.shieldedPool,
      abi: poolAbi,
      functionName: "cap",
      args: [dep.usdg],
    })) > 0n
  )
    return;
  await send(devAccount(31), dep.shieldedPool, poolAbi, "applyCap", [dep.usdg]);
  log("Hidden Vault USDG cap applied (48 h timelock passed)");
}

/** After a Hidden deposit: warp past the 1 h pending queue and make sure the deposit is inserted. */
export async function insertHidden(log: (s: string) => void = () => {}) {
  await warp(3_700n);
  try {
    await send(devAccount(31), dep.shieldedPool, poolAbi, "insertPending", [100n]);
    log("insertPending sent by the helper");
  } catch {
    log("nothing to insert (the keeper inserted it)");
  }
}

export const balanceOf = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
export const vaultBalances = (who: Address) =>
  pub.readContract({
    address: dep.savingsVault,
    abi: vault,
    functionName: "balancesOf",
    args: [who],
  });
