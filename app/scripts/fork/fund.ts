// Funds the fork's dev accounts with ETH, real USDG and real Stock Tokens.
//
//   ETH         anvil_setBalance (accounts 0-29).
//   USDG        moved out of a large real holder by impersonation (Morpho Blue holds the USDG supplied to its
//               markets; chain facts). No storage writes: the real token's transfer() runs.
//   Stock Tokens bought through Plynth's StockRouter on the real v4 pools (accounts 0-9), like any user would.
//
// `bun scripts/fork/fund.ts` funds again (top-up); setup.ts calls `prefundDeployer` before the deploy and `fund`
// after it. Anvil's dev keys are public test keys; nothing here works on a real network (impersonation is an
// anvil-only RPC).
import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import { allAccounts, clients, devAccount, log, readForkDeployment, ROLE } from "./lib";

export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
/** Morpho Blue core on 4663: holds the unborrowed USDG of every market (chain facts, todo 25). */
export const USDG_HOLDER = getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010");
export const U = 1_000_000n;
export const E18 = 10n ** 18n;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const routerAbi = parseAbi(["function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient) returns (uint256)"]);

/** Moves `amount` real USDG from the large holder to `to` (impersonated transfer on the fork). */
export async function giveUsdg(to: Address, amount: bigint) {
  const { pub, rpc } = clients();
  await rpc("anvil_impersonateAccount", [USDG_HOLDER]);
  await rpc("anvil_setBalance", [USDG_HOLDER, "0x56bc75e2d63100000"]);
  try {
    const hash = await rpc<`0x${string}`>("eth_sendTransaction", [{ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }) }]);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`USDG transfer to ${to} reverted`);
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [USDG_HOLDER]);
  }
}

/**
 * Anvil's dev accounts carry EIP-7702 delegations on Robinhood Chain (sweeper bots; chain facts, todo 19). On a fork
 * that code makes OpenZeppelin's SignatureChecker take the ERC-1271 path and every signature fails: strip it.
 */
export async function clearAccountCode() {
  const { pub, rpc } = clients();
  let cleared = 0;
  for (const a of allAccounts()) {
    const code = await pub.getCode({ address: a.address });
    if (code && code !== "0x") {
      await rpc("anvil_setCode", [a.address, "0x"]);
      cleared++;
    }
  }
  return cleared;
}

export async function giveEth() {
  const { rpc } = clients();
  for (const a of allAccounts()) await rpc("anvil_setBalance", [a.address, "0x21e19e0c9bab2400000"]); // 10,000 ETH
}

/** The deploy needs real USDG for the PLTH pool and the perp pool seed (ForkMainnet.USDG_NEEDED). */
export async function prefundDeployer() {
  const { pub } = clients();
  const d = devAccount(ROLE.deployer).address;
  const have = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [d] });
  const want = 2_000_000n * U;
  if (have < want) await giveUsdg(d, want - have);
}

export async function fund(opts: { usdgEach?: bigint; stockUsd?: bigint } = {}) {
  const usdgEach = opts.usdgEach ?? 100_000n * U;
  const stockUsd = opts.stockUsd ?? 500n * U;
  const dep = readForkDeployment();
  if (!dep) throw new Error("fork not deployed yet (run up.sh)");
  const { pub, wallet } = clients();
  await giveEth();
  const accts = allAccounts();
  // One impersonated holder sends every top-up; anvil orders the nonces, so send all, then wait for all.
  const { rpc } = clients();
  await rpc("anvil_impersonateAccount", [USDG_HOLDER]);
  await rpc("anvil_setBalance", [USDG_HOLDER, "0x56bc75e2d63100000"]);
  try {
    const hashes: `0x${string}`[] = [];
    for (const a of accts) {
      const have = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [a.address] });
      if (have >= usdgEach) continue;
      hashes.push(await rpc<`0x${string}`>("eth_sendTransaction", [{ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [a.address, usdgEach - have] }) }]));
    }
    for (const h of hashes) if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`USDG top-up ${h} reverted`);
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [USDG_HOLDER]);
  }
  log(`ETH + ${usdgEach / U} USDG on accounts 0-${accts.length - 1}`);
  // Stock Tokens through the real pools, for the ten default accounts (the ones MetaMask users import).
  const router = dep.stockRouter as Address;
  const picks = ["TSLA", "AAPL", "NVDA", "SPY"].filter((s) => dep.stocks[s]);
  await Promise.all(
    accts.slice(0, 10).map(async (a) => {
      const w = wallet(a);
      const ok = await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: erc20, functionName: "approve", args: [router, stockUsd * BigInt(picks.length)] }) });
      if (ok.status !== "success") throw new Error("approve failed");
      for (const sym of picks) {
        const token = dep.stocks[sym]!.token;
        try {
          const sim = await pub.simulateContract({ account: a, address: router, abi: routerAbi, functionName: "buy", args: [token, stockUsd, 100, a.address] });
          const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(sim.request) });
          if (r.status !== "success") throw new Error("reverted");
        } catch (e) {
          // A real pool more than 1% away from its frozen Chainlink mark is refused by the router's oracle guard.
          log(`account ${accts.indexOf(a)}: ${sym} buy refused (${(e as Error).message.split("\n")[0]})`);
        }
      }
    }),
  );
  log(`$${stockUsd / U} each of ${picks.join(", ")} bought through StockRouter for accounts 0-9`);
}

if (import.meta.main) {
  await fund();
  process.exit(0);
}
