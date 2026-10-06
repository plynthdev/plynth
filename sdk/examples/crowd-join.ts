// The crowd-buy engine: many savers' small USDG amounts become one swap per Stock Token, at a jittered time,
// and every allocation can be recomputed from public logs.
//   bun sdk/examples/crowd-join.ts
import { encodeAbiParameters, erc20Abi, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  claimOpenTx,
  crowdBuyAbi,
  executeTx,
  jitterBeaconAbi,
  joinTx,
  nextExecution,
  openBook,
  recomputeBook,
  savingsVaultAbi,
  setMixTx,
  setSettingsTx,
  splitByMix,
  vaultDepositTx,
  windowOf,
  beaconKey,
  beaconOffsetOf,
} from "@plynth/sdk/crowd";
import { check, runExample } from "./_local";

const U = 1_000_000n;
const DAY = 86_400n;
const mint = parseAbi(["function mint(address to, uint256 amount)"]);
// Keeper-only calls (the local kit's keeper is anvil #1). Not SDK surface: apps never make these.
const keeperAbi = parseAbi([
  "function accrue(address user, bytes32 sourceTx, uint32 logIndex, uint256 spendAmount) returns (uint256)",
  "function commit(bytes32 key, uint64 windowStart, uint64 windowEnd, bytes32 commitment)",
]);

await runExample("crowd-join", async ({ dep, pub, accounts, now, warpTo, send, call, read }) => {
  const [deployer, keeper, a, b, c, anyone] = accounts.map((x) => getAddress(x)) as [Address, Address, Address, Address, Address, Address];
  const savers = [a, b, c];
  const vault = dep.savingsVault as Address;
  const crowd = dep.crowdBuy as Address;
  const usdg = dep.usdg as Address;
  const tsla = dep.stocks.mTSLA.token as Address;
  const mix = [{ stockToken: tsla, weightBps: 10_000 }];

  // 1. Savers: deposit USDG, choose round-up settings (Open delivery) and a mix.
  for (const u of savers) {
    await call(deployer, usdg, mint, "mint", [u, 100n * U]);
    await call(u, usdg, erc20Abi, "approve", [vault, 100n * U]);
    await send(u, vaultDepositTx(vault, 100n * U));
    await send(u, setSettingsTx(vault, { roundTo: 10, multiplier: 3, weeklyCap: 100n * U, fixedTopUp: 0n, mode: 0 }));
    await send(u, setMixTx(vault, mix));
  }

  // 2. Keeper: accrues one card spend per saver (12.34 USDG -> round up to 20, x3 = 22.98 USDG pending), and
  //    commits a sealed execution time for tomorrow's window.
  for (const [i, u] of savers.entries()) {
    await call(keeper, vault, keeperAbi, "accrue", [u, keccak256(toHex(`spend-${i}`)), 0, 12_340_000n]);
  }
  const genesis = BigInt(dep.genesis);
  const tomorrow = windowOf(genesis, await now()).start + DAY;
  const key = beaconKey(tsla, tomorrow);
  const secret = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  await call(keeper, dep.jitterBeacon, keeperAbi, "commit", [key, tomorrow, tomorrow + DAY, keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [secret, key]))]);

  // 3. Anyone joins each saver: their pending USDG moves into the open book, split by their mix.
  const { bookId } = await openBook(pub, crowd, tsla);
  for (const u of savers) {
    const [, pending] = await read<readonly [bigint, bigint]>(vault, savingsVaultAbi, "balancesOf", [u]);
    check(pending === 22_980_000n, "round-up accrued");
    check(splitByMix(pending, mix)[0] === pending, "one-token mix places everything");
    await send(anyone, joinTx(crowd, u));
  }
  const { book } = await openBook(pub, crowd, tsla);
  check(book.accounts === 3 && book.usdgTotal === 3n * 22_980_000n, "book holds three accounts");
  console.log(`book ${bookId}: ${book.accounts} accounts, ${book.usdgTotal} USDG base units`);

  // 4. The secret is revealed (anyone holding it may) at the jittered time it fixes, never earlier: an early
  //    reveal would publish the time. Only the secret's holder can compute it.
  const at = tomorrow + beaconOffsetOf(secret as Hex, key, tomorrow, tomorrow + DAY);
  await warpTo(at);
  await call(anyone, dep.jitterBeacon, jitterBeaconAbi, "reveal", [key, secret as Hex]);
  const { executeAfter } = await nextExecution(pub, crowd, tsla);
  check(executeAfter === at && executeAfter < tomorrow + DAY, "execution time inside the window");
  await warpTo((executeAfter > (await now()) ? executeAfter : await now()) + 1n);
  await send(anyone, executeTx(crowd, tsla));

  // 5. Allocation proof: recompute from logs alone, compare with the contract, then claim openly.
  const r = await recomputeBook(pub, crowd, tsla, bookId, BigInt(dep.deployBlock));
  check(r.rawOut > 0n, "the swap returned tokens");
  for (const u of savers) {
    const onChain = await read<bigint>(crowd, crowdBuyAbi, "allocationOf", [tsla, bookId, u]);
    check(r.allocations.get(u) === onChain, "log recomputation equals allocationOf");
    await send(u, claimOpenTx(crowd, tsla, bookId));
    check((await read<bigint>(tsla, erc20Abi, "balanceOf", [u])) === onChain, "claimed exactly the allocation");
  }
  console.log(`executed: ${r.rawOut} raw mTSLA for ${r.usdgTotal} USDG; each saver claimed ${r.allocations.get(a)}`);
});
