// Review v2 (refuted lead, kept as a regression test; now through sendSigned with the gas cap): the relayer would pay gas for a swap that its own simulation passed but that reverts on-chain, because
// simulation (and viem's estimateGas) run against `latest` while an earlier relayer tx is not yet in a block.
// Real relayerApp + real tradeDeps (simulateContract / writeContract / waitForTransactionReceipt) + NonceManager.
// The ShieldedTrade stand-in succeeds once and reverts afterwards, which is what two swaps whose proofs fix an exact
// minOut against the same StockRouter v4 pool do (ShieldedTrade.sol:193-197: Slippage revert AFTER _begin verified
// the proof, i.e. after ~3.9-5M gas of Honk verify + spend).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { relayerApp } from "@/relayer/app";
import { chainDeps, NonceManager, tradeDeps } from "@/relayer/chain";
import { startAnvil } from "@/testing/keeper-helpers";

const RELAYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex; // test-key (anvil #9)
const TRADE = "0x00000000000000000000000000000000000c0de1" as const;
const POOL = "0x00000000000000000000000000000000000c0de2" as const;
// runtime: if sload(0) == 0 { sstore(0, 1); return 64 zero bytes } else revert  (first swap wins, later ones revert)
const ONCE = "0x60005415600b57600080fd5b600160005560406000f3" as Hex;

let anvil: Awaited<ReturnType<typeof startAnvil>>;
beforeAll(async () => {
  anvil = await startAnvil(["--block-time", "2"]);
});
afterAll(async () => anvil?.stop());

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const swapBody = (n: number) => ({
  proof: "0x1234",
  pub: { root: word(1), nullifier: word(100 + n), changeCommitment: word(3), assetIn: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amountIn: "10000000", relayerFee: "250000", assetOut: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", minOut: "1", outPartial: word(4), deadline: String(4_000_000_000) },
  maxSlippageBps: 100,
  encryptedChange: "0xab",
  encryptedOut: "0xcd",
});

test("two concurrent conflicting swaps: second is stopped by estimateGas (pending) before broadcast", async () => {
  const account = privateKeyToAccount(RELAYER_KEY);
  const probe = createPublicClient({ transport: http(anvil.rpc) });
  const chain = defineChain({ id: await probe.getChainId(), name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(anvil.rpc) }) as PublicClient;
  const wallet = createWalletClient({ chain, account, transport: http(anvil.rpc) });
  await pub.request({ method: "anvil_setCode" as any, params: [TRADE, ONCE] as any });
  const nonces = new NonceManager(() => pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
  const fee = (_: string) => 250_000n;
  const CAP = 50_000_000_000n; // 50 gwei: above anvil's base fee, so the cap path runs without blocking the send
  const t = tradeDeps({ pub, wallet, account, chain, trade: TRADE, pool: POOL, minFee: fee, nonces, maxFeePerGas: CAP });
  const logs: string[] = [];
  const app = relayerApp({
    ...chainDeps({ pub, wallet, account, chain, stealthClaims: "0x00000000000000000000000000000000000c0de3", plynth: [], nonces }),
    // pool reads stubbed (unspent, known root); simulate / send are the real viem paths
    trade: { ...t, nullifierSpent: async () => false, isKnownRoot: async () => true },
    ipOf: () => "203.0.113.7",
    log: (m) => logs.push(m),
  });
  const before = await pub.getBalance({ address: account.address });
  const post = (n: number) => app.request("/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(swapBody(n)) });
  const [a, b] = await Promise.all([post(1), post(2)]);
  const statuses = [a.status, b.status].sort();
  const after = await pub.getBalance({ address: account.address });
  const nonce = await pub.getTransactionCount({ address: account.address });
  console.log("statuses", statuses, "relayer txs mined", nonce, "relayer spent wei", (before - after).toString());
  console.log(logs.join("\n"));
  expect(statuses).toEqual([200, 502]); // one swap paid, one reverted on-chain
  // REFUTED on anvil: viem's estimateGas (no block tag = pending) sees the first, unmined swap and the second is never
  // broadcast. On Nitro "pending" is the RPC node's latest state, so only the sequencer-feed latency window remains.
  expect(nonce).toBe(1);
  expect(logs.some((l) => /reverted on-chain/.test(l))).toBe(false);
  // V2-L17: the one transaction sent bid no more than the relayer's cap
  const block = await pub.getBlock({ blockTag: "latest", includeTransactions: true });
  const txs = (await Promise.all(Array.from({ length: Number(block.number!) + 1 }, (_, i) => pub.getBlock({ blockNumber: BigInt(i), includeTransactions: true })))).flatMap((b) => b.transactions as any[]);
  expect(txs).toHaveLength(1);
  expect(BigInt(txs[0].maxFeePerGas)).toBeLessThanOrEqual(CAP);
}, 60_000);
