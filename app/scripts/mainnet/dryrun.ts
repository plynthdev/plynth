// Dry run of the mainnet closed-beta deploy on a FRESH local fork of 4663, and its exact cost. Never sends to
// mainnet: it starts its own anvil (chain id 31337) and reads mainnet only for the fee inputs.
//
//   bun scripts/mainnet/dryrun.ts --addresses <file.json> [--token] [--port 9645] [--bot-fork <rpc> --bot-dir <fork dir>] [--out <file.json>]
//
//   --addresses   public addresses {owner, deployer, keeper, relayer, controller, attester, cashdesk, equitydesk}
//                 (the owner is a placeholder until it is confirmed: gas does not depend on it)
//   --token       DEPLOY_TOKEN=true (default false, the beta default); needs 50.5k USDG at the deployer, which the
//                 fork moves from a large holder by impersonation
//   --bot-fork    a fork that ran the full exercise on the beta stack (scripts/fork, FORK_STACK=beta): its bots'
//                 transactions per crowd window give the 30-day bot budget
//
// Steps: anvil --fork-url <4663> --chain-id 31337; act as the deployer with anvil_impersonateAccount (no key);
// forge script MainnetBeta.s.sol in fork mode with the real public addresses; OWNER accepts every ownership (also
// impersonated); assert the hand-over; then price every deploy transaction at today's mainnet base fee plus its
// Orbit L1 data gas from NodeInterface.gasEstimateComponents on mainnet (eth_call, read only).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, maxUint256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { botBudget, fmtEth, FORK_CHAIN_ID, MAINNET_CHAIN_ID, NODE_INTERFACE, ROOT, RPC, txCostWei, withMargin, type BotDay } from "./lib";

const nodeAbi = parseAbi(["function gasEstimateComponents(address to, bool contractCreation, bytes data) returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);
const ownedAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()", "function cap(address) view returns (uint256)", "function capProposal(address) view returns (uint256, uint64)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const crowdEvents = parseAbi(["event Executed(address indexed asset, uint256 indexed bookId, uint256 usdgTotal, uint256 rawOut, uint32 accounts, uint80 roundId)"]);
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const USDG_HOLDER = getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010"); // Morpho Blue core (chain facts)
/** An address with no code: the L1 data part of a transaction depends on its bytes, not on what it calls. */
const SINK = getAddress("0x000000000000000000000000000000000000dEaD");

type Addresses = { owner: Address; deployer: Address; keeper: Address; relayer: Address; controller: Address; attester: Address; cashdesk: Address; equitydesk: Address };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (m: string) => console.log(`[dryrun ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function retry<T>(f: () => Promise<T>, what: string, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      await Bun.sleep(1000 * 2 ** Math.min(i, 4));
    }
  }
  throw new Error(`${what}: ${(last as Error)?.message?.split("\n")[0]}`);
}

/** The L1 data gas (in L2 gas at the reported base fee) of a transaction carrying `data`, read on mainnet. */
async function l1GasOf(main: PublicClient, from: Address, data: Hex): Promise<{ l1: bigint; baseFee: bigint; l1BaseFee: bigint }> {
  const r = await retry(() => main.simulateContract({ address: NODE_INTERFACE, abi: nodeAbi, functionName: "gasEstimateComponents", args: [SINK, false, data], account: from }), "gasEstimateComponents");
  const [, l1, baseFee, l1BaseFee] = r.result as readonly [bigint, bigint, bigint, bigint];
  return { l1, baseFee, l1BaseFee };
}

async function startAnvil(port: number): Promise<{ proc: ReturnType<typeof Bun.spawn>; rpc: string; block: bigint }> {
  const main = createPublicClient({ transport: http(RPC, { retryCount: 6 }) });
  if ((await main.getChainId()) !== MAINNET_CHAIN_ID) throw new Error(`${RPC} is not chain 4663`);
  const block = await main.getBlockNumber();
  const rpc = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["anvil", "--fork-url", RPC, "--fork-block-number", String(block), "--chain-id", String(FORK_CHAIN_ID), "--port", String(port), "--hardfork", "cancun", "--gas-limit", "100000000", "--fork-retry-backoff", "1000", "--retries", "10", "--silent"], { stdout: "ignore", stderr: "ignore" }); // an unread pipe can fill and stall anvil
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  for (let i = 0; i < 240; i++) {
    try {
      if ((await pub.getChainId()) === FORK_CHAIN_ID) return { proc, rpc, block };
    } catch {}
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error("anvil did not start");
}

async function main() {
  const file = arg("--addresses");
  if (!file) throw new Error("--addresses <file.json> is required");
  const a = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const A = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, getAddress(v)])) as unknown as Addresses;
  const token = process.argv.includes("--token");
  const port = Number(arg("--port") ?? 9645);
  const out = arg("--out");
  const mainnet = createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 6, retryDelay: 1000 }) }) as PublicClient;
  const mainnetNonce = await mainnet.getTransactionCount({ address: A.deployer });

  const { proc, rpc, block } = await startAnvil(port);
  try {
    const fork = createPublicClient({ transport: http(rpc, { timeout: 120_000 }), pollingInterval: 100 }) as PublicClient;
    const call = <T>(method: string, params: unknown[]) => fork.request({ method: method as never, params: params as never }) as Promise<T>;
    log(`fresh fork of 4663 at block ${block} on ${rpc} (chain id 31337); deployer nonce on mainnet ${mainnetNonce}`);
    for (const who of [A.deployer, A.owner]) {
      const code = await fork.getCode({ address: who });
      if (code && code !== "0x") await call("anvil_setCode", [who, "0x"]);
      await call("anvil_setBalance", [who, "0x56bc75e2d63100000"]); // 100 ETH (fork only)
      await call("anvil_impersonateAccount", [who]);
    }
    if (token) {
      // Fork-only USDG for the PLTH pool seed: anvil's deal (no transfer through a holder whose state the public
      // RPC may serve slowly); fall back to an impersonated transfer from Morpho Blue.
      const want = 60_000n * 1_000_000n;
      try {
        await call("anvil_dealERC20", [USDG, A.deployer, `0x${want.toString(16)}`]);
      } catch {
        await call("anvil_impersonateAccount", [USDG_HOLDER]);
        await call("anvil_setBalance", [USDG_HOLDER, "0x56bc75e2d63100000"]);
        const h = await call<Hex>("eth_sendTransaction", [{ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [A.deployer, want] }) }]);
        const rcU = await fork.waitForTransactionReceipt({ hash: h, timeout: 600_000 });
        if (rcU.status !== "success") throw new Error("USDG prefund reverted");
      }
      const have = (await fork.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [A.deployer] })) as bigint;
      if (have < want) throw new Error(`deployer USDG ${have} after the deal`);
    }
    const outName = `dryrun-${MAINNET_CHAIN_ID}-beta.json`;
    const env = {
      ...process.env,
      BETA_FORK: "true",
      // The mainnet value (MainnetBeta.DEFAULT_MAX_STALENESS), so every transaction is byte-for-byte the mainnet one.
      FORK_MAX_STALENESS: String(26 * 3600),
      BETA_OUT: outName,
      DEPLOY_TOKEN: token ? "true" : "false",
      OWNER: A.owner,
      KEEPER: A.keeper,
      ATTESTER: A.attester,
      RELAYER: A.relayer,
      CONTROLLER: A.controller,
      CASH_DESK: A.cashdesk,
      EQUITY_DESK: A.equitydesk,
    };
    log(`forge script MainnetBeta.s.sol (fork mode, DEPLOY_TOKEN=${token}) as ${A.deployer} (impersonated)`);
    const t0 = Date.now();
    const r = Bun.spawnSync(
      ["forge", "script", "script/MainnetBeta.s.sol:MainnetBeta", "--rpc-url", rpc, "--broadcast", "--unlocked", "--sender", A.deployer, "--non-interactive", "--gas-estimate-multiplier", "200"],
      { cwd: join(ROOT, "contracts"), env, stdout: "pipe", stderr: "pipe" },
    );
    const forgeOut = r.stdout.toString() + r.stderr.toString();
    if (r.exitCode !== 0) throw new Error(`forge script failed (exit ${r.exitCode})\n${forgeOut.slice(-3000)}`);
    const runFile = join(ROOT, "contracts", "broadcast", "MainnetBeta.s.sol", String(FORK_CHAIN_ID), "run-latest.json");
    const run = JSON.parse(readFileSync(runFile, "utf8")) as { transactions: { transaction: { input?: Hex; data?: Hex; to?: string | null; nonce?: Hex; value?: Hex }; contractName?: string; transactionType: string; function?: string | null; contractAddress?: string | null }[]; receipts: { gasUsed: Hex; status: Hex; contractAddress?: string | null }[] };
    for (const d of ["broadcast", "cache"]) rmSync(join(ROOT, "contracts", d, "MainnetBeta.s.sol", String(FORK_CHAIN_ID)), { recursive: true, force: true });
    const depFile = join(ROOT, "app", "deployments", outName);
    const dep = JSON.parse(readFileSync(depFile, "utf8")) as Record<string, unknown>;
    rmSync(depFile, { force: true });
    if (run.receipts.some((x) => BigInt(x.status) !== 1n)) throw new Error("a deploy transaction reverted on the fork");
    // The ordered transaction list (for a bundler): exact only for this deployer, starting at its mainnet nonce.
    const txsOut = arg("--txs-out");
    if (txsOut) {
      const list = run.transactions.map((t, i) => ({
        i,
        from: A.deployer,
        nonce: t.transaction.nonce ? Number(BigInt(t.transaction.nonce)) : mainnetNonce + i,
        to: t.transaction.to ? getAddress(t.transaction.to) : null,
        value: "0",
        kind: t.transactionType,
        contract: t.contractName ?? null,
        function: t.function ?? null,
        expectedAddress: run.receipts[i]?.contractAddress ? getAddress(run.receipts[i]!.contractAddress!) : null,
        gasUsedOnFork: String(BigInt(run.receipts[i]!.gasUsed)),
        data: (t.transaction.input ?? t.transaction.data ?? "0x") as Hex,
      }));
      writeFileSync(txsOut, JSON.stringify({ note: `exact only when sent from ${A.deployer} starting at nonce ${mainnetNonce}, in this order, on chain 4663`, deployToken: token, txs: list }, null, 1));
      log(`ordered transaction list (${list.length}) in ${txsOut}`);
    }
    log(`deployed: ${run.transactions.length} transactions in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

    // ---- OWNER accepts (impersonated), then the hand-over holds
    const accepts = (dep.acceptOwnership as string[]).map((x) => getAddress(x));
    let acceptGas = 0n;
    const acceptData = encodeFunctionData({ abi: ownedAbi, functionName: "acceptOwnership" });
    for (const c of accepts) {
      const h = await call<Hex>("eth_sendTransaction", [{ from: A.owner, to: c, data: acceptData }]);
      const rc = await fork.waitForTransactionReceipt({ hash: h });
      if (rc.status !== "success") throw new Error(`acceptOwnership on ${c} reverted`);
      acceptGas += rc.gasUsed;
    }
    const checks: string[] = [];
    const owned = ["stockTokenRegistry", "stockRouter", "eligibilityRegistry", "jitterBeacon", "savingsVault", "crowdBuy", "shieldedPool", "shieldedTrade", "perpPool", "treasuryFactory", ...(token ? ["feeRouter"] : [])];
    const pm = (typeof dep.perpMarkets === "string" ? JSON.parse(dep.perpMarkets) : dep.perpMarkets) as Record<string, string>;
    const perp = Object.values(pm).map((x) => getAddress(x));
    for (const c of [...owned.map((k) => getAddress(dep[k] as string)), ...perp]) {
      const o = getAddress((await fork.readContract({ address: c, abi: ownedAbi, functionName: "owner" })) as Address);
      if (o !== A.owner) throw new Error(`${c} owner ${o}`);
    }
    checks.push(`${owned.length + perp.length} contracts owned by OWNER after ${accepts.length} acceptOwnership calls`);
    const pool = getAddress(dep.shieldedPool as string);
    const [capProp] = (await fork.readContract({ address: pool, abi: ownedAbi, functionName: "capProposal", args: [USDG] })) as readonly [bigint, bigint];
    if (capProp !== maxUint256) throw new Error(`USDG cap proposal ${capProp}`);
    checks.push("Hidden Vault caps proposed at uint256 max (apply after 48h)");
    const registrar = getAddress((await fork.readContract({ address: getAddress(dep.perpPool as string), abi: parseAbi(["function makerRegistrar() view returns (address)"]), functionName: "makerRegistrar" })) as Address);
    if (registrar !== A.owner) throw new Error(`perpPool maker registrar ${registrar}`);
    checks.push("perpPool maker registrar = OWNER. OWNER then, for each treasury's InHousePerpVenue: perpPool.setMaker(venue, true) (instant; a hedge open then loses 52 bps of size instead of 60, inside the guard's in-house venue bound of spread + 2 x fee + 10 bps)");
    // Predicted addresses: the fork used the real deployer at its real nonce.
    const forkNonce0 = mainnetNonce;
    checks.push(`deployer nonce ${forkNonce0} on mainnet: the fork's addresses are the real ones if nothing else is sent from it first`);

    // ---- price it on mainnet
    const latest = await mainnet.getBlock();
    const baseFee = latest.baseFeePerGas ?? (await mainnet.getGasPrice());
    log(`mainnet base fee ${baseFee} wei (block ${latest.number}); pricing ${run.transactions.length} transactions' L1 data on mainnet`);
    const rows: { i: number; what: string; bytes: number; gasUsed: bigint; l1Gas: bigint }[] = [];
    let l1BaseFee = 0n;
    for (let i = 0; i < run.transactions.length; i++) {
      const t = run.transactions[i]!;
      const data = (t.transaction.input ?? t.transaction.data ?? "0x") as Hex;
      const g = await l1GasOf(mainnet, A.deployer, data);
      l1BaseFee = g.l1BaseFee;
      // NodeInterface converts L1 cost to L2 gas at ITS base fee; re-express it at the fee we price with.
      const l1Gas = g.baseFee === baseFee || baseFee === 0n ? g.l1 : (g.l1 * g.baseFee + baseFee - 1n) / baseFee;
      rows.push({ i, what: t.transactionType === "CREATE" ? `create ${t.contractName}` : `${t.contractName}.${(t.function ?? "").split("(")[0]}`, bytes: (data.length - 2) / 2, gasUsed: BigInt(run.receipts[i]!.gasUsed), l1Gas });
    }
    const deployWei = rows.reduce((s, x) => s + txCostWei(x, baseFee), 0n);
    const l2Total = rows.reduce((s, x) => s + x.gasUsed, 0n);
    const l1Total = rows.reduce((s, x) => s + x.l1Gas, 0n);
    const acceptL1 = (await l1GasOf(mainnet, A.owner, acceptData)).l1 * BigInt(accepts.length);
    const acceptWei = (acceptGas + acceptL1) * baseFee;

    // ---- 30-day bot budget from a beta fork that ran the full exercise
    let bots: ReturnType<typeof botBudget> = [];
    let windows = 0;
    const botFork = arg("--bot-fork");
    const botDir = arg("--bot-dir");
    if (botFork && botDir) {
      const res = await botsFromFork(botFork, botDir, mainnet, baseFee);
      bots = res.budget;
      windows = res.windows;
    }
    const botWei = bots.reduce((s, b) => s + b.totalWei, 0n);
    const subtotal = deployWei + acceptWei + botWei;
    const total = withMargin(subtotal, 5_000n);
    const summary = {
      at: new Date().toISOString(),
      forkBlock: String(block),
      mainnetBlock: String(latest.number),
      baseFeeWei: String(baseFee),
      l1BaseFeeEstimateWei: String(l1BaseFee),
      deployToken: token,
      deployer: A.deployer,
      deployerMainnetNonce: mainnetNonce,
      txs: rows.length,
      l2Gas: String(l2Total),
      l1Gas: String(l1Total),
      deployWei: String(deployWei),
      ownerAccepts: accepts.length,
      ownerAcceptWei: String(acceptWei),
      botWindowsOnFork: windows,
      bots: bots.map((b) => ({ role: b.role, txsPerDay: b.txsPerDay, perDayWei: String(b.perDayWei), thirtyDayWei: String(b.totalWei) })),
      botThirtyDayWei: String(botWei),
      subtotalWei: String(subtotal),
      totalWithMarginWei: String(total),
      totalWithMarginEth: fmtEth(total, 8),
      checks,
      addresses: Object.fromEntries(Object.entries(dep).filter(([, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v as string))),
      rows: rows.map((x) => ({ ...x, gasUsed: String(x.gasUsed), l1Gas: String(x.l1Gas) })),
    };
    if (out) {
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, JSON.stringify(summary, null, 2));
    }
    log(`deploy: ${rows.length} txs, L2 ${l2Total} + L1 ${l1Total} gas = ${fmtEth(deployWei, 8)} ETH at ${baseFee} wei`);
    log(`OWNER accepts: ${accepts.length} txs = ${fmtEth(acceptWei, 8)} ETH`);
    for (const b of bots) log(`bot ${b.role.padEnd(11)} ${b.txsPerDay.toFixed(1)} txs/day, 30 days = ${fmtEth(b.totalWei, 8)} ETH`);
    log(`TOTAL with 50% margin: ${fmtEth(total, 8)} ETH`);
    for (const c of checks) log(`check: ${c}`);
  } finally {
    proc.kill();
  }
}

/**
 * Bot transactions on a beta fork that ran the exercise: every transaction from the keeper, relayer, controller
 * and desks since the deploy, grouped by role; days = the crowd windows the run executed (one per day on mainnet).
 */
async function botsFromFork(rpc: string, dir: string, mainnet: PublicClient, baseFee: bigint) {
  const fork = createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
  const dep = JSON.parse(readFileSync(join(dir, "deployments", `${FORK_CHAIN_ID}.json`), "utf8")) as Record<string, unknown>;
  const roles: Record<string, string> = {};
  for (const k of ["keeper", "relayer", "controller", "cashDesk", "equityDesk"]) if (typeof dep[k] === "string") roles[(dep[k] as string).toLowerCase()] = k;
  const from = BigInt(dep.deployBlock as number);
  const head = await fork.getBlockNumber();
  const acc: Record<string, BotDay & { samples: Hex[] }> = {};
  const crowd = getAddress(dep.crowdBuy as string);
  const genesis = BigInt(dep.genesis as number);
  const windowSet = new Set<string>();
  for (let b = from; b <= head; b++) {
    const blk = await fork.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of blk.transactions) {
      const role = roles[tx.from.toLowerCase()];
      if (!role) continue;
      const rc = await fork.getTransactionReceipt({ hash: tx.hash });
      const row = (acc[role] ??= { role, txs: 0, l2Gas: 0n, l1Gas: 0n, samples: [] });
      row.txs++;
      row.l2Gas += rc.gasUsed;
      row.samples.push(tx.input);
      for (const lg of rc.logs) {
        if (getAddress(lg.address) !== crowd) continue;
        try {
          decodeEventLog({ abi: crowdEvents, data: lg.data, topics: lg.topics });
          windowSet.add(String((blk.timestamp - genesis) / 86_400n)); // the 24h window it executed in
        } catch {}
      }
    }
  }
  // L1 data per transaction: priced on mainnet for each distinct calldata size class (rounded to 32 bytes).
  const cache = new Map<number, bigint>();
  for (const row of Object.values(acc)) {
    for (const data of row.samples) {
      const k = Math.ceil((data.length - 2) / 64);
      if (!cache.has(k)) cache.set(k, (await l1GasOf(mainnet, SINK, data)).l1);
      row.l1Gas += cache.get(k)!;
    }
  }
  const windows = Math.max(1, windowSet.size);
  log(`bot transactions on the exercised fork: ${Object.values(acc).map((r) => `${r.role} ${r.txs}`).join(", ")}; crowd windows executed ${windowSet.size}`);
  return { budget: botBudget(Object.values(acc), windows, 30, baseFee), windows };
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error(`[mainnet dryrun] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}

