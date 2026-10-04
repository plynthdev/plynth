// Test kit for the desks on plain anvil: mock USDG, three mock Stock Tokens (per-share feeds + uiMultiplier,
// like the testnet kit), a fixed-rate MockPoolManager behind the real StockRouter, an OpenZeppelin ERC-4626
// mock vault, and a treasury built from the balanced template with the real sleeves and a JitterBeacon.
import { compileTemplate, loadTemplate } from "@plynth/policy-compiler";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, stringToHex, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(ROOT, "contracts", "out");

export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // test-key (anvil #0)
  cash: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // test-key (anvil #1)
  equity: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // test-key (anvil #2)
} as const;

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const chainFor = (rpc: string) =>
  defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

export class Kit {
  pub: PublicClient;
  deployer: PrivateKeyAccount = privateKeyToAccount(KEYS.deployer);
  cashKey: PrivateKeyAccount = privateKeyToAccount(KEYS.cash);
  equityKey: PrivateKeyAccount = privateKeyToAccount(KEYS.equity);
  a: Record<string, Address> = {};
  stocks: { sym: string; token: Address; feed: Address; share: bigint; mult: bigint; supply: bigint }[] = [];
  chain;

  constructor(readonly rpc: string) {
    this.chain = chainFor(rpc);
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  }

  wallet(acct: PrivateKeyAccount) {
    return createWalletClient({ chain: this.chain, transport: http(this.rpc), account: acct, pollingInterval: 50 });
  }

  async deploy(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const { abi, bytecode } = artifact(file, name);
    const hash = await this.wallet(this.deployer).deployContract({ abi, bytecode, args });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  }

  async send(address: Address, file: string, name: string, fn: string, args: unknown[] = [], from = this.deployer) {
    const { abi } = artifact(file, name);
    const hash = await this.wallet(from).writeContract({ address, abi, functionName: fn, args });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${name}.${fn} reverted`);
    return r;
  }

  read<T>(address: Address, file: string, name: string, fn: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi: artifact(file, name).abi, functionName: fn, args }) as Promise<T>;
  }

  async now(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** Moves chain time to `ts` (never backwards) and mines a block. */
  async warpTo(ts: bigint) {
    const now = await this.now();
    if (ts > now) await this.pub.request({ method: "evm_increaseTime" as never, params: [Number(ts - now)] as never });
    await this.pub.request({ method: "evm_mine" as never, params: [] as never });
  }

  /** New round on every feed (fresh `updatedAt`), optionally moving one share price. */
  async refreshFeeds(newShare: Record<string, bigint> = {}) {
    for (const s of this.stocks) {
      if (newShare[s.sym] !== undefined) s.share = newShare[s.sym]!;
      await this.send(s.feed, "MockFeed.sol", "MockFeed", "set", [s.share]);
      await this.setPoolPrice(s);
    }
  }

  /** Token price (USD 1e18) = share price (8dp) x multiplier. The pool fills at exactly that rate. */
  async setPoolPrice(s: (typeof this.stocks)[number]) {
    const price = (s.share * 10n ** 10n * s.mult) / 10n ** 18n;
    const usdg = this.a.usdg!;
    const usdgIs0 = BigInt(usdg) < BigInt(s.token);
    const key = { currency0: usdgIs0 ? usdg : s.token, currency1: usdgIs0 ? s.token : usdg, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" };
    const rate = usdgIs0 ? 10n ** 54n / (price * 10n ** 6n) : (price * 10n ** 6n) / 10n ** 18n;
    await this.send(this.a.pm!, "MockV4.sol", "MockPoolManager", "setRate", [key, rate]);
    return key;
  }

  /** Deploys everything and funds the treasury with `funding` USDG (6dp). Returns the desk config path. */
  async setup(dir: string, funding: bigint): Promise<string> {
    const d = this.deployer.address;
    const a = this.a;
    a.usdg = await this.deploy("MockUSDG.sol", "MockUSDG");
    a.registry = await this.deploy("StockTokenRegistry.sol", "StockTokenRegistry", [d]);
    a.valuer = await this.deploy("Valuer.sol", "Valuer", [a.registry, 6n * 3600n]);
    a.pm = await this.deploy("MockV4.sol", "MockPoolManager");
    a.router = await this.deploy("StockRouter.sol", "StockRouter", [a.pm, a.registry, a.valuer, a.usdg, d]);
    // mSPY is thin on purpose: supply 5,000 tokens, so the 1% float cap is 50 tokens (~$28.5k).
    for (const [sym, share, mult, supply] of [
      ["mTSLA", 250n * 10n ** 8n, 10n ** 18n, 10n ** 24n],
      ["mAAPL", 230n * 10n ** 8n, 10005n * 10n ** 14n, 10n ** 24n],
      ["mSPY", 570n * 10n ** 8n, 10017n * 10n ** 14n, 5000n * 10n ** 18n],
    ] as const) {
      const token = await this.deploy("MockStockToken.sol", "MockStockToken", [sym, sym]);
      if (mult !== 10n ** 18n) await this.send(token, "MockStockToken.sol", "MockStockToken", "setUiMultiplier", [mult]);
      const feed = await this.deploy("MockFeed.sol", "MockFeed", [8, share, `${sym} / USD (mock, per share)`]);
      await this.send(a.registry, "StockTokenRegistry.sol", "StockTokenRegistry", "list", [token, feed, false]);
      const s = { sym, token, feed, share, mult, supply };
      this.stocks.push(s);
      const key = await this.setPoolPrice(s);
      await this.send(a.router, "StockRouter.sol", "StockRouter", "setPool", [token, key]);
      await this.send(token, "MockStockToken.sol", "MockStockToken", "mint", [a.pm, supply]);
    }
    await this.send(a.usdg, "MockUSDG.sol", "MockUSDG", "mint", [a.pm, 10n ** 9n * 10n ** 6n]);
    a.vault = await this.deploy("TreasuryMocks.sol", "MockCashVault", [a.usdg]);

    // The balanced template, with this chain's addresses as the instruments.
    const balanced = loadTemplate(join(ROOT, "templates", "balanced.yaml"));
    const tpl = {
      ...balanced,
      name: "balanced-local",
      network: "testnet",
      controller: d,
      instruments: [
        { asset: a.usdg, kind: "cash" },
        { asset: a.vault, kind: "cash_vault" },
        ...this.stocks.map((s) => ({ asset: s.token, kind: "stock_token" })),
      ],
      desks: { equity: { weights: Object.fromEntries(this.stocks.map((s) => [s.token, 1])) } },
    };
    const tplPath = join(dir, "policy.yaml");
    writeFileSync(tplPath, JSON.stringify(tpl, null, 2)); // JSON is YAML
    const compiled = compileTemplate(tpl as never, { controller: d });

    a.policy = await this.deploy("TreasuryPolicy.sol", "TreasuryPolicy", [d, compiled.policy]);
    a.guard = await this.deploy("PolicyGuard.sol", "PolicyGuard", [a.registry, a.valuer, 200]);
    a.approvals = await this.deploy("BoardApprovals.sol", "BoardApprovals", [d, a.guard]);
    a.account = await this.deploy("TreasuryAccount.sol", "TreasuryAccount", [d, a.policy, a.guard, a.approvals]);
    a.cashSleeve = await this.deploy("CashSleeve.sol", "CashSleeve", [a.valuer, a.usdg, [a.vault]]);
    a.equitySleeve = await this.deploy("EquitySleeve.sol", "EquitySleeve", [a.router, this.stocks.map((s) => s.token)]);
    a.beacon = await this.deploy("JitterBeacon.sol", "JitterBeacon", [this.equityKey.address, d]);

    await this.send(a.approvals, "BoardApprovals.sol", "BoardApprovals", "bindAccount", [a.account]);
    await this.send(a.account, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("cash", { size: 32 }), this.cashKey.address, [a.cashSleeve]]);
    await this.send(a.account, "TreasuryAccount.sol", "TreasuryAccount", "registerDesk", [stringToHex("equity", { size: 32 }), this.equityKey.address, [a.equitySleeve]]);
    await this.send(a.usdg, "MockUSDG.sol", "MockUSDG", "mint", [a.account, funding]);

    const cfgPath = join(dir, "desks.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        rpcUrl: this.rpc,
        account: a.account,
        cashSleeve: a.cashSleeve,
        equitySleeve: a.equitySleeve,
        vault: a.vault,
        beacon: a.beacon,
        cashDeskId: "cash",
        equityDeskId: "equity",
        policyTemplate: "policy.yaml",
        network: "testnet",
      }),
    );
    return cfgPath;
  }
}
