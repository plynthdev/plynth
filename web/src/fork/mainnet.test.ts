// The mainnet profile (Robinhood Chain 4663, the closed beta) and the production build: chain defaults, the
// deployment file (inlined at build time, absent until the beta deploy), explorer links, and the dev wallet that
// must never appear outside localhost + 31337.
import { describe, expect, it } from "vitest";
import { CHAINS, devWalletAllowed, MAINNET_CHAIN_ID, PROXY, readForkConfig } from "./config";
import { DeploymentMissing, loadDeployment, normalizeDeployment, REQUIRED_ADDRESSES } from "./deployment";
import { notDeployedText, renderTxLog, type LogEntry } from "./logic";
import { plynthForkChain } from "./wallet";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
/** A 4663-beta.json as MainnetBeta.s.sol writes it: stocks and perpMarkets may arrive as JSON strings. */
function betaFile(over: Record<string, unknown> = {}) {
  const f: Record<string, unknown> = {
    chainId: 4663,
    deployBlock: 1234,
    fork: false,
    beta: true,
    stocks: JSON.stringify({ TSLA: { token: addr(0xc3), feed: addr(0xf1), poolId: `0x${"ab".repeat(32)}` } }), // not-a-key
    perpMarkets: JSON.stringify({ TSLA: addr(0xd1) }),
    shieldedTrade: addr(0x99),
  };
  REQUIRED_ADDRESSES.forEach((k, i) => (f[k] = addr(0x100 + i)));
  return { ...f, ...over };
}

describe("mainnet profile config", () => {
  it("VITE_CHAIN_ID=4663 alone gives the public mainnet RPC, the Blockscout explorer and the chain name", () => {
    const c = readForkConfig({ VITE_CHAIN_ID: "4663", PROD: true });
    expect(c).toMatchObject({
      enabled: true,
      chainId: MAINNET_CHAIN_ID,
      chainName: "Robinhood Chain",
      rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
      explorerUrl: "https://robinhoodchain.blockscout.com",
      devWalletFlag: false,
    });
    expect(CHAINS[4663]!.rpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
  it("a production build calls the API and relayer directly (no dev proxy)", () => {
    const c = readForkConfig({
      VITE_CHAIN_ID: "4663",
      VITE_API_URL: "https://api.example.test/",
      VITE_RELAYER_URL: "https://relayer.example.test",
      PROD: true,
    });
    expect(c.apiBase).toBe("https://api.example.test");
    expect(c.relayerBase).toBe("https://relayer.example.test");
    expect(c.apiBase).not.toBe(PROXY.api);
  });
  it("VITE_RPC_URL and VITE_EXPLORER_URL override the defaults", () => {
    const c = readForkConfig({
      VITE_CHAIN_ID: "4663",
      VITE_RPC_URL: "https://rpc.example.test/",
      VITE_EXPLORER_URL: "https://scan.example.test/",
    });
    expect(c.rpcUrl).toBe("https://rpc.example.test");
    expect(c.explorerUrl).toBe("https://scan.example.test");
  });
  it("the fork has no explorer and keeps its local RPC", () => {
    const c = readForkConfig({});
    expect(c.explorerUrl).toBe("");
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
  });
  it("a production build without VITE_CHAIN_ID keeps the preview dashboard (never points visitors at 127.0.0.1)", () => {
    expect(readForkConfig({ PROD: true }).enabled).toBe(false);
    expect(readForkConfig({ PROD: true, VITE_CHAIN_ID: "4663", VITE_FORK: "0" }).enabled).toBe(false);
    expect(readForkConfig({}).enabled).toBe(true); // vite dev: the fork
  });
  it("the dev wallet is never offered on mainnet, even with VITE_DEV_WALLET=1 on localhost", () => {
    const c = readForkConfig({ VITE_CHAIN_ID: "4663", VITE_DEV_WALLET: "1" });
    for (const h of ["localhost", "127.0.0.1", "plynth.vercel.app"]) expect(devWalletAllowed(c, h)).toBe(false);
    // ...and a fork build served from a real host does not offer it either.
    expect(devWalletAllowed(readForkConfig({ VITE_DEV_WALLET: "1" }), "plynth.vercel.app")).toBe(false);
  });
  it("the wallet's chain is mainnet (not testnet) with the explorer attached", () => {
    const chain = plynthForkChain(readForkConfig({ VITE_CHAIN_ID: "4663" }));
    expect(chain.testnet).toBe(false);
    expect(chain.blockExplorers?.default.url).toBe("https://robinhoodchain.blockscout.com");
    expect(plynthForkChain(readForkConfig({})).testnet).toBe(true);
    expect(plynthForkChain(readForkConfig({})).blockExplorers).toBeUndefined();
  });
});

describe("deployment file", () => {
  it("reads the raw 4663-beta.json shape (stocks and perpMarkets as JSON strings)", () => {
    const d = normalizeDeployment(betaFile(), 4663);
    expect(d.stocks["TSLA"]!.token).toBe(addr(0xc3));
    expect((d as unknown as { perpMarkets: Record<string, string> }).perpMarkets["TSLA"]).toBe(addr(0xd1));
    expect(d.savingsVault).toBe(addr(0x100));
  });
  it("reads the normalized 4663.json shape (objects)", () => {
    const d = normalizeDeployment(betaFile({ stocks: { TSLA: { token: addr(0xc3) } }, perpMarkets: {} }), 4663);
    expect(d.stocks["TSLA"]!.token).toBe(addr(0xc3));
  });
  it("refuses a file for another chain, a fork-mode mainnet run, or one missing an address", () => {
    expect(() => normalizeDeployment(betaFile({ chainId: 46630 }), 4663)).toThrow(/chain 46630, not 4663/);
    expect(() => normalizeDeployment(betaFile({ fork: true }), 4663)).toThrow(/fork-mode/);
    expect(() => normalizeDeployment(betaFile({ crowdBuy: undefined }), 4663)).toThrow(/crowdBuy/);
    expect(() => normalizeDeployment(betaFile({ usdg: "0x1234" }), 4663)).toThrow(/usdg/);
    expect(() => normalizeDeployment(null, 4663)).toThrow(/not a JSON object/);
  });
  it("a build without the file (null inlined) rejects with DeploymentMissing, not a crash", async () => {
    await expect(loadDeployment({ dev: false, chainId: 4663, bundled: null })).rejects.toBeInstanceOf(
      DeploymentMissing,
    );
    await expect(loadDeployment({ dev: false, chainId: 4663, bundled: undefined })).rejects.toThrow(
      /not deployed on chain 4663 yet/,
    );
  });
  it("a build with the file uses the inlined copy and makes no request", async () => {
    const fetchFn = (() => {
      throw new Error("no request expected");
    }) as unknown as typeof fetch;
    const d = await loadDeployment({ dev: false, chainId: 4663, bundled: betaFile(), fetchFn });
    expect(d.crowdBuy).toBe(addr(0x101));
  });
  it("vite dev fetches the dev server's file; a 404 means not deployed", async () => {
    const respond = (status: number, body: unknown) =>
      (async (url: string) => {
        expect(url).toBe(PROXY.deployment);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    await expect(
      loadDeployment({ dev: true, chainId: 4663, bundled: null, fetchFn: respond(404, { error: "none" }) }),
    ).rejects.toBeInstanceOf(DeploymentMissing);
    const d = await loadDeployment({ dev: true, chainId: 4663, bundled: null, fetchFn: respond(200, betaFile()) });
    expect(d.usdg).toBe(addr(0x102));
  });
});

describe("not deployed yet / explorer links", () => {
  it("names mainnet and the closed beta, and how to fix the fork", () => {
    expect(notDeployedText(4663).title).toMatch(/not live on Robinhood Chain yet/);
    expect(notDeployedText(4663).body).toMatch(/chain id 4663/);
    expect(notDeployedText(31337).body).toMatch(/app\/scripts\/fork\/up\.sh/);
  });
  it("confirmed hashes link to the explorer when there is one", () => {
    const hash = `0x${"12".repeat(32)}`; // not-a-key (tx hash)
    const e: LogEntry = { id: 1, label: "Deposit", state: "ok", msg: "1 transaction confirmed", txs: [{ msg: "deposit confirmed", hash }] };
    const linked = renderTxLog([e], "none", "https://robinhoodchain.blockscout.com/");
    expect(linked).toContain(`href="https://robinhoodchain.blockscout.com/tx/${hash}"`);
    expect(linked).toContain('rel="noopener noreferrer"');
    expect(renderTxLog([e], "none")).not.toContain("href=");
  });
});
