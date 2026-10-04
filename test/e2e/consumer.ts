// scripts/e2e.sh consumer: the whole consumer product on an anvil fork of Robinhood Chain testnet.
//
// fork testnet -> TestnetKit (mock USDG + mock Stock Tokens on real v4 pools) -> TestnetConsumer (vault, crowd,
// stealth claims, Hidden Vault; MIN_CROWD 3) -> API + relayer started as HTTP services, indexer + keeper run as
// passes between time warps -> three users (Open, Quiet, Hidden) save, crowd-buy one book together and each
// gets their Stock Tokens their own way (claim / relayed stealth claim / shielded note + relayed withdraw)
// -> every user's API overview is compared with numbers read straight from the chain -> everything stopped.
import { decodeAnnouncementLog, announcementEvent, generateKeys, KEY_DERIVATION_MESSAGE, keyForHit, metaAddress, registerTx, scan, signClaim, type StealthKeys } from "@plynth/sdk/stealth";
import { deriveVaultKeys, destroyProver, initVault, myNotes, proveWithdraw, registration, syncPool, VAULT_KEY_MESSAGE, withdrawRequest, type VaultKeys } from "@plynth/sdk/vault";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beaconAbi, crowdAbi, vaultAbi as keeperVaultAbi } from "../../apps/keeper/src/abi";
import { beaconKey } from "../../apps/keeper/src/jobs/beacon";
import { Checks, clearDevAccountCode, DEV_KEYS, e2eDb, fixed6, freePort, onCleanup, ROOT, run, runCleanup, startFork, startService } from "./lib";

const U = 1_000_000n;
const DAY = 86_400n;
const MODES = ["open", "quiet", "hidden"] as const;

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "struct Settings { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; uint64 fixedTopUp; uint8 mode; }",
  "struct MixEntry { address stockToken; uint16 weightBps; }",
  "function deposit(uint256 amount)",
  "function setSettings(Settings s)",
  "function setMix(MixEntry[] mix)",
  "function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)",
  "function linkSpendingWallet(address wallet, uint256 deadline, bytes walletSig)",
  "function linkNonce(address wallet) view returns (uint256)",
  "function balancesOf(address user) view returns (uint256 available, uint256 pending)",
]);
const feedAbi = parseAbi(["function latestAnswer() view returns (int256)", "function set(int256 answer_)"]);
const poolAbi = parseAbi(["function applyCap(address asset)", "function cap(address asset) view returns (uint256)", "function shielded(address asset) view returns (uint256)"]);
const valuerAbi = parseAbi(["function value(address token, uint256 rawUnits) view returns (uint256 usd, bool hold)"]);
const scAbi = parseAbi(["function nonces(address stealth) view returns (uint256)", "function pooled(address token) view returns (uint256)"]);

async function main(c: Checks) {
  const forkUrl = process.env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  c.step(`forking testnet (${forkUrl})`);
  const anvil = await startFork(forkUrl);
  c.must("fork is Robinhood Chain testnet (46630)", anvil.chainId === 46630, `chainId ${anvil.chainId}`);
  await clearDevAccountCode(anvil.rpc);
  const chain = defineChain({ id: 46630, name: "rhc-testnet-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  const wc = createWalletClient({ chain, transport: http(anvil.rpc) });
  const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never });
  const accounts = (await rpc("eth_accounts")) as Address[];
  const [deployer, keeperAddr] = [accounts[0]!, accounts[1]!];
  const users = accounts.slice(2, 5);
  const wallets = accounts.slice(5, 8);
  const merchant = accounts[8]!;

  // ---- deploy: testnet kit, then the consumer stack, exactly as the runbook does on testnet ----
  const repoDep = join(ROOT, "deployments", "46630.json");
  const backup = existsSync(repoDep) ? readFileSync(repoDep) : undefined;
  const forgeOut = (s: string) => [join(ROOT, "contracts", "broadcast", s, "46630"), join(ROOT, "contracts", "cache", s, "46630")];
  onCleanup(() => {
    // fork output is not a real deployment: put the repo back the way it was
    if (backup) writeFileSync(repoDep, backup);
    else rmSync(repoDep, { force: true });
    for (const s of ["TestnetKit.s.sol", "TestnetConsumer.s.sol"]) for (const d of forgeOut(s)) rmSync(d, { recursive: true, force: true });
  });
  const startBlock = await pub.getBlockNumber();
  c.step("deploying TestnetKit + TestnetConsumer (forge script --broadcast to the fork)");
  const forge = (script: string, env: Record<string, string> = {}) =>
    run(["forge", "script", `script/${script}.s.sol:${script}`, "--rpc-url", anvil.rpc, "--broadcast", "--private-key", DEV_KEYS.deployer, "--slow"], { cwd: join(ROOT, "contracts"), env });
  forge("TestnetKit");
  forge("TestnetConsumer", { KEEPER_ADDRESS: keeperAddr, MIN_CROWD: "3" });
  const dir = mkdtempSync(join(tmpdir(), "plynth-e2e-consumer-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const dep = JSON.parse(readFileSync(repoDep, "utf8"));
  // forge's vm.getBlockNumber() on an Orbit fork is the parent-chain number; the indexer needs the L2 block.
  dep.deployBlock = Number(startBlock) + 1;
  writeFileSync(join(dir, "46630.json"), JSON.stringify(dep, null, 2));
  renameSync(repoDep, join(dir, "kit-output.json"));
  if (backup) writeFileSync(repoDep, backup);
  c.must("deployment has vault, crowd, stealth claims and shielded pool", ["savingsVault", "crowdBuy", "stealthClaims", "shieldedPool"].every((k) => typeof dep[k] === "string"));
  c.eq("CrowdBuy.MIN_CROWD", await pub.readContract({ address: dep.crowdBuy, abi: crowdAbi, functionName: "MIN_CROWD" }), 3);
  const tsla = dep.stocks.mTSLA.token as Address;
  const stocks = Object.entries(dep.stocks as Record<string, { token: Address; feed: Address }>);

  const read = <T>(address: Address, abi: any, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  async function tx(account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[]) {
    const hash = await wc.writeContract({ account, address, abi, functionName, args, chain } as never);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  }
  const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const warpTo = async (ts: bigint) => {
    await rpc("evm_setNextBlockTimestamp", [Number(ts)]);
    await rpc("evm_mine");
  };
  // Mock feeds go stale after 30 min (kit Valuer); a keeper-side job would re-post them on testnet.
  const refreshFeeds = async () => {
    for (const [, s] of stocks) await tx(deployer, s.feed, feedAbi, "set", [await read<bigint>(s.feed, feedAbi, "latestAnswer")]);
  };

  // ---- services ----
  const db = await e2eDb("consumer");
  const secretKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const svcEnv = { DATABASE_URL: db.url, RHC_TESTNET_RPC_URL: anvil.rpc };
  const cli = (entry: string, env: Record<string, string>) => run(["bun", entry, "--once"], { env: { ...svcEnv, ...env } });
  const indexer = () => cli("apps/indexer/src/main.ts", { INDEXER_CHAIN: "testnet", INDEXER_DEPLOYMENTS_DIR: dir, INDEXER_CONFIRMATIONS: "0" });
  const keeper = (jobs?: string) =>
    cli("apps/keeper/src/main.ts", { KEEPER_CHAIN: "testnet", KEEPER_DEPLOYMENTS_DIR: dir, KEEPER_PRIVATE_KEY: DEV_KEYS.keeper, KEEPER_SECRET_KEY: secretKey, SPLIT_PARTS: "1", ...(jobs ? { KEEPER_JOBS: jobs } : {}) });
  const cycle = (jobs?: string) => (indexer(), keeper(jobs));
  const apiPort = freePort();
  const relayerPort = freePort();
  const logDir = join(dir, "logs");
  c.step(`starting api :${apiPort} and relayer :${relayerPort} (logs in ${logDir})`);
  await startService("api", "apps/api/src/main.ts", { ...svcEnv, API_CHAIN: "testnet", API_DEPLOYMENTS_DIR: dir, API_PORT: String(apiPort) }, `http://127.0.0.1:${apiPort}/v1/meta/health`, logDir);
  await startService("relayer", "apps/relayer/src/main.ts", { RELAYER_CHAIN: "testnet", RHC_TESTNET_RPC_URL: anvil.rpc, RELAYER_DEPLOYMENTS_DIR: dir, RELAYER_PRIVATE_KEY: DEV_KEYS.relayer, RELAYER_PORT: String(relayerPort) }, `http://127.0.0.1:${relayerPort}/health`, logDir);
  const relayer = privateKeyToAccount(DEV_KEYS.relayer).address;

  // ---- Hidden Vault caps apply 48h after the deploy proposed them ----
  await warpTo((await now()) + 48n * 3600n + 1n);
  for (const a of [dep.usdg, tsla]) await tx(deployer, dep.shieldedPool, poolAbi, "applyCap", [a]);
  c.eq("Hidden Vault mTSLA cap applied after 48h", await read(dep.shieldedPool, poolAbi, "cap", [tsla]), 10n ** 24n);
  await refreshFeeds();

  // ---- three savers: Open, Quiet, Hidden ----
  c.step("onboarding three users (Open, Quiet, Hidden)");
  await initVault();
  onCleanup(() => destroyProver());
  let stealthKeys: StealthKeys | undefined;
  let vaultKeys: VaultKeys | undefined;
  for (const [i, u] of users.entries()) {
    await tx(deployer, dep.usdg, tokenAbi, "mint", [u, 1_000n * U]);
    await tx(u, dep.usdg, tokenAbi, "approve", [dep.savingsVault, 300n * U]);
    await tx(u, dep.savingsVault, vaultAbi, "deposit", [300n * U]);
    await tx(u, dep.savingsVault, vaultAbi, "setSettings", [{ roundTo: 10, multiplier: 1, weeklyCap: 500n * U, fixedTopUp: 0n, mode: i }]);
    await tx(u, dep.savingsVault, vaultAbi, "setMix", [[{ stockToken: tsla, weightBps: 10_000 }]]);
    await tx(deployer, dep.usdg, tokenAbi, "mint", [wallets[i]!, 200n * U]);
    const nonce = await read<bigint>(dep.savingsVault, vaultAbi, "linkNonce", [wallets[i]!]);
    const deadline = (await now()) + 3600n;
    const sig = await wc.signTypedData({
      account: wallets[i]!,
      domain: { name: "Plynth SavingsVault", version: "1", chainId: 46630, verifyingContract: dep.savingsVault },
      types: { LinkWallet: [{ name: "user", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "LinkWallet",
      message: { user: u, wallet: wallets[i]!, nonce, deadline },
    });
    await tx(u, dep.savingsVault, vaultAbi, "linkSpendingWallet", [wallets[i]!, deadline, sig]);
    if (MODES[i] === "quiet") {
      stealthKeys = generateKeys(await wc.signMessage({ account: u, message: KEY_DERIVATION_MESSAGE }));
      const r = registerTx(metaAddress(stealthKeys), dep.erc6538Registry);
      const hash = await wc.sendTransaction({ account: u, to: r.to, data: r.data, chain });
      c.must("Quiet user registered on the real ERC-6538 registry", (await pub.waitForTransactionReceipt({ hash })).status === "success");
    }
    if (MODES[i] === "hidden") {
      vaultKeys = deriveVaultKeys(await wc.signMessage({ account: u, message: VAULT_KEY_MESSAGE }));
      const r = registration(vaultKeys);
      await tx(u, dep.savingsVault, vaultAbi, "setHiddenKeys", [r.ownerPk, r.viewingPub]);
    }
  }

  // ---- spend -> round-ups -> sweep -> beacon -> one jittered crowd execution ----
  c.step("spending from linked wallets; keeper accrues round-ups and sweeps them into the mTSLA book");
  for (const w of wallets) await tx(w, dep.usdg, tokenAbi, "transfer", [merchant, 5_500_000n]); // 5.50 -> 4.50 round-up each
  cycle();
  const [bookId, open] = await read<[bigint, { usdgTotal: bigint; accounts: number }]>(dep.crowdBuy, crowdAbi, "openBook", [tsla]);
  c.eq("book 0 holds three accounts", open.accounts, 3);
  c.eq("book 0 holds 3 x 4.50 USDG of round-ups", open.usdgTotal, 13_500_000n);
  const genesis = BigInt(dep.genesis);
  const w1 = genesis + (((await now()) - genesis) / DAY) * DAY + DAY;
  await warpTo(w1 + 5n);
  keeper("beacon"); // reveal the window's secret
  const executeAt = await read<bigint>(dep.jitterBeacon, beaconAbi, "executeAfter", [beaconKey(tsla, w1)]);
  c.must("jittered execution time falls inside the window", executeAt >= w1 && executeAt < w1 + DAY, `${executeAt} vs window ${w1}`);
  await warpTo((executeAt > (await now()) ? executeAt : await now()) + 1n);
  await refreshFeeds();
  const exe = cycle("execute");
  c.must("keeper executed book 0 on the real v4 pool", exe.includes("execute: ok actions=1"), exe.slice(-500));
  const book = await read<{ executed: boolean; rawOut: bigint }>(dep.crowdBuy, crowdAbi, "book", [tsla, bookId]);
  c.ok("book 0 executed with mTSLA out", book.executed && book.rawOut > 0n);
  const alloc = await Promise.all(users.map((u) => read<bigint>(dep.crowdBuy, crowdAbi, "allocationOf", [tsla, bookId, u])));
  c.ok("allocations sum to at most rawOut (rounding stays in the book)", alloc.reduce((a, b) => a + b, 0n) <= book.rawOut && alloc.every((a) => a > 0n));

  // ---- delivery, one per mode ----
  c.step("delivery: Open claims, keeper delivers Quiet and Hidden");
  await tx(users[0]!, dep.crowdBuy, crowdAbi, "claimOpen", [tsla, bookId]);
  c.eq("Open user holds the allocation in her wallet", await read(tsla, tokenAbi, "balanceOf", [users[0]!]), alloc[0]!);
  const dq = cycle("deliver-quiet");
  c.ok("keeper delivered the Quiet user (deliver + 1 part)", dq.includes("deliver-quiet: ok actions=2"), dq.slice(-400));
  const dh = keeper("deliver-hidden");
  c.ok("keeper queued one shielded note for the Hidden user", dh.includes("deliver-hidden: ok actions=1"), dh.slice(-400));
  await warpTo((await now()) + 3601n);
  const ins = keeper("deliver-hidden");
  c.ok("keeper batch-inserted the pending note after the 1h delay", ins.includes("deliver-hidden: ok actions=1"), ins.slice(-400));
  for (const i of [1, 2]) c.eq(`${MODES[i]} allocation settled on-chain`, await read(dep.crowdBuy, crowdAbi, "settled", [tsla, bookId, users[i]!]), true);

  // Quiet: scan with the viewing key, claim through the running relayer to a fresh address
  c.step("Quiet: scan announcements, relayed claim to a fresh address");
  const logs = await pub.getLogs({ address: dep.erc5564Announcer, event: announcementEvent, args: { caller: dep.crowdBuy }, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" });
  const hits = scan(logs.map((l) => decodeAnnouncementLog(l as never)), stealthKeys!.viewingPrivateKey, stealthKeys!.spendingPublicKey, { callers: [dep.crowdBuy] });
  c.eq("Quiet user finds exactly her one stealth part", hits.length, 1);
  c.eq("stealth part equals her allocation", hits[0]?.amount, alloc[1]!);
  const quietTo = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
  {
    const h = hits[0]!;
    const nonce = await read<bigint>(dep.stealthClaims, scAbi, "nonces", [h.stealthAddress]);
    const { message, sig } = await signClaim(keyForHit(h, stealthKeys!), 46630, dep.stealthClaims, { token: tsla, to: quietTo, raw: h.amount!, nonce, deadline: (await now()) + 3600n });
    const r = await fetch(`http://127.0.0.1:${relayerPort}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: message.token, stealth: message.stealth, to: message.to, raw: message.raw.toString(), deadline: message.deadline.toString(), sig }) });
    const j = (await r.json()) as { txHash?: Hex };
    c.ok("relayer accepted the stealth claim", r.status === 200, JSON.stringify(j));
    if (j.txHash) c.eq("claim tx was paid by the relayer", (await pub.getTransactionReceipt({ hash: j.txHash })).from.toLowerCase(), relayer.toLowerCase());
    c.eq("fresh Quiet address received the allocation", await read(tsla, tokenAbi, "balanceOf", [quietTo]), alloc[1]!);
    c.eq("stealth address never held gas", await pub.getBalance({ address: h.stealthAddress }), 0n);
    c.eq("StealthClaims pool is empty", await read(dep.stealthClaims, scAbi, "pooled", [tsla]), 0n);
  }

  // Hidden: sync the pool, prove a withdraw, send it through the running relayer
  c.step("Hidden: sync notes, prove withdraw, relayed withdraw to a fresh address");
  const state = await syncPool(pub, dep.shieldedPool, undefined, { fromBlock: BigInt(dep.deployBlock) });
  const notes = myNotes(state, vaultKeys!);
  c.eq("Hidden user's only note is her allocation", notes.map((n) => n.raw), [alloc[2]!]);
  const hiddenTo = privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;
  const fee = alloc[2]! / 100n;
  const w = await proveWithdraw({ keys: vaultKeys!, tree: state.tree, note: notes[0]!, amount: alloc[2]!, recipient: hiddenTo, relayerFee: fee });
  {
    const r = await fetch(`http://127.0.0.1:${relayerPort}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withdrawRequest(w)) });
    const j = await r.json();
    c.ok("relayer accepted the shielded withdraw", r.status === 200, JSON.stringify(j));
    c.eq("fresh Hidden address received allocation - fee", await read(tsla, tokenAbi, "balanceOf", [hiddenTo]), alloc[2]! - fee);
    c.eq("pool shielded mTSLA is back to 0", await read(dep.shieldedPool, poolAbi, "shielded", [tsla]), 0n);
  }

  // ---- API overview == on-chain truth, for every user ----
  c.step("API overview vs on-chain truth");
  indexer();
  for (const [i, u] of users.entries()) {
    const r = await fetch(`http://127.0.0.1:${apiPort}/v1/account/${u}/overview`);
    c.must(`overview ${MODES[i]} answers 200`, r.status === 200, String(r.status));
    const o = (await r.json()) as any;
    const [available, pending] = await read<[bigint, bigint]>(dep.savingsVault, vaultAbi, "balancesOf", [u]);
    // Queued = orders in unexecuted books; claimable = executed, unsettled allocations. Only book 0 exists.
    const [openId] = await read<[bigint]>(dep.crowdBuy, crowdAbi, "openBook", [tsla]);
    let queued = 0n;
    let claimable = 0n;
    for (let b = 0n; b <= openId; b++) {
      const bk = await read<{ executed: boolean }>(dep.crowdBuy, crowdAbi, "book", [tsla, b]);
      if (await read<boolean>(dep.crowdBuy, crowdAbi, "settled", [tsla, b, u])) continue;
      if (bk.executed) claimable += await read<bigint>(dep.crowdBuy, crowdAbi, "allocationOf", [tsla, b, u]);
      else queued += await read<bigint>(dep.crowdBuy, crowdAbi, "orderOf", [tsla, b, u]);
    }
    let stockUsd = 0n;
    const want: { symbol: string; raw: string; walletRaw: string; claimableRaw: string; usd: string }[] = [];
    for (const [sym, s] of stocks) {
      const walletRaw = await read<bigint>(s.token, tokenAbi, "balanceOf", [u]);
      const cl = s.token === tsla ? claimable : 0n;
      if (walletRaw + cl === 0n) continue;
      const [v] = await read<[bigint, boolean]>(dep.valuer, valuerAbi, "value", [s.token, walletRaw + cl]);
      stockUsd += v;
      want.push({ symbol: sym, raw: (walletRaw + cl).toString(), walletRaw: walletRaw.toString(), claimableRaw: cl.toString(), usd: fixed6(v, 18) });
    }
    const avail = available + pending + queued;
    c.eq(`${MODES[i]}: mode`, o.mode, MODES[i]);
    c.eq(`${MODES[i]}: vaultUsdg`, o.allocation.vaultUsdg, fixed6(available + pending, 6));
    c.eq(`${MODES[i]}: queuedUsdg`, o.allocation.queuedUsdg, fixed6(queued, 6));
    c.eq(`${MODES[i]}: availableUsdg`, o.allocation.availableUsdg, fixed6(avail, 6));
    c.eq(`${MODES[i]}: stockTokensUsd`, o.allocation.stockTokensUsd, fixed6(stockUsd, 18));
    c.eq(`${MODES[i]}: totalHoldingsUsd`, o.totalHoldingsUsd, fixed6(stockUsd + avail * 10n ** 12n, 18));
    c.eq(`${MODES[i]}: holdings`, o.holdings.map((h: any) => ({ symbol: h.symbol, raw: h.raw, walletRaw: h.walletRaw, claimableRaw: h.claimableRaw, usd: h.usd })), want);
    const acct = await read<{ week: bigint; accruedThisWeek: bigint }>(dep.savingsVault, keeperVaultAbi, "accountOf", [u]);
    const thisWeek = (await now()) / 604_800n;
    c.eq(`${MODES[i]}: weekRoundups`, o.weekRoundups, fixed6(BigInt(acct.week) === thisWeek ? acct.accruedThisWeek : 0n, 6));
  }
  // Stealth and Hidden users never received tokens at their own address; only the Open user did.
  c.eq("Quiet user's own wallet holds no mTSLA", await read(tsla, tokenAbi, "balanceOf", [users[1]!]), 0n);
  c.eq("Hidden user's own wallet holds no mTSLA", await read(tsla, tokenAbi, "balanceOf", [users[2]!]), 0n);
  const vaultUsdg = await read<bigint>(dep.usdg, tokenAbi, "balanceOf", [dep.savingsVault]);
  let owed = 0n;
  for (const u of users) {
    const [a, p] = await read<[bigint, bigint]>(dep.savingsVault, vaultAbi, "balancesOf", [u]);
    owed += a + p;
  }
  c.eq("vault USDG balance equals what it owes the three users", vaultUsdg, owed);
  const health = (await (await fetch(`http://127.0.0.1:${apiPort}/v1/meta/health`)).json()) as any;
  c.ok("API health reports ok on chain 46630", health.ok === true, JSON.stringify(health));
}

const c = new Checks("consumer");
let code = 1;
try {
  await main(c);
  code = c.finish();
} catch (e) {
  console.error(`[e2e consumer] ${(e as Error).stack ?? e}`);
  c.finish();
  code = 1;
} finally {
  await runCleanup();
}
process.exit(code);
