// The multi-wallet picker: the WalletConnect project id per profile, the chain handed to AppKit as its only network,
// and the fallback when there is no id (every EIP-6963 browser wallet by name and icon, never a broken modal).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAINNET_CHAIN_ID,
  readForkConfig,
  TESTNET_CHAIN_ID,
  walletConnectProjectId,
  type ForkConfig,
} from "./config";

const ID = "0123456789abcdef0123456789abcdef";

const h = vi.hoisted(() => ({
  cfg: undefined as unknown as ForkConfig,
  createWalletModal: vi.fn(),
}));

vi.mock("./config", async (orig) => {
  const real = await orig<typeof import("./config")>();
  return { ...real, forkConfig: () => h.cfg };
});
vi.mock("./wallet-modal", () => ({ createWalletModal: h.createWalletModal }));

const W = await import("./wallet");

/** What a wallet extension does on page load (EIP-6963), answering wagmi's requestProvider too. */
function announce(name: string, rdns: string, icon = "data:image/svg+xml;base64,PHN2Zy8+") {
  const detail = Object.freeze({
    info: { uuid: `${rdns}-uuid`, name, icon, rdns },
    provider: { request: async () => [], on() {}, removeListener() {} },
  });
  const fire = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", fire);
  fire();
  return () => window.removeEventListener("eip6963:requestProvider", fire);
}

beforeEach(() => {
  W._resetWalletForTests();
  h.createWalletModal.mockReset();
});
afterEach(() => {
  delete (window as { ethereum?: unknown }).ethereum;
});

describe("WalletConnect project id per profile", () => {
  it("is read from VITE_WALLETCONNECT_PROJECT_ID on mainnet, testnet and the fork", () => {
    for (const chainId of ["4663", "46630", "31337"])
      expect(
        readForkConfig({ VITE_CHAIN_ID: chainId, VITE_WALLETCONNECT_PROJECT_ID: ` ${ID} ` })
          .walletConnectProjectId,
      ).toBe(ID);
  });
  it("missing, empty or a placeholder counts as unset (the browser-wallet list, not a broken modal)", () => {
    expect(readForkConfig({ VITE_CHAIN_ID: "4663" }).walletConnectProjectId).toBe("");
    expect(walletConnectProjectId("")).toBe("");
    expect(walletConnectProjectId("your-project-id")).toBe("");
    expect(walletConnectProjectId(`${ID}0`)).toBe("");
    expect(walletConnectProjectId(ID.toUpperCase())).toBe(ID.toUpperCase());
  });
});

describe("the chain AppKit gets", () => {
  const fakeModal = (config: unknown) => ({
    config,
    open: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    walletInfo: () => ({ name: "Rainbow", icon: "https://example.org/rainbow.png" }),
    ready: async () => {},
    onWalletInfo: () => () => {},
  });

  for (const [chainId, name, rpc, testnet] of [
    [MAINNET_CHAIN_ID, "Robinhood Chain", "https://rpc.mainnet.chain.robinhood.com", false],
    [TESTNET_CHAIN_ID, "Robinhood Chain Testnet", "https://rpc.testnet.chain.robinhood.com", true],
    [31337, "Plynth fork", "http://127.0.0.1:8545", true],
  ] as const)
    it(`${chainId}: the profile's chain is the only network, on its own RPC; the dev wallet is not passed`, async () => {
      h.cfg = readForkConfig({
        VITE_CHAIN_ID: String(chainId),
        VITE_WALLETCONNECT_PROJECT_ID: ID,
        VITE_DEV_WALLET: "0",
      });
      const { createConfig } = await import("@wagmi/core");
      h.createWalletModal.mockImplementation(async (o: { chain: { id: number } }) =>
        fakeModal(
          createConfig({
            chains: [o.chain as never],
            transports: { [o.chain.id]: (await import("viem")).http() },
          }),
        ),
      );
      await W.initWallet();
      expect(h.createWalletModal).toHaveBeenCalledTimes(1);
      const arg = h.createWalletModal.mock.calls[0]![0];
      expect(arg.projectId).toBe(ID);
      expect(arg.chain).toMatchObject({
        id: chainId,
        name,
        testnet,
        nativeCurrency: { symbol: "ETH", decimals: 18 },
      });
      expect(arg.chain.rpcUrls.default.http).toEqual([rpc]);
      expect(arg.rpcUrl).toBe(rpc);
      expect(arg.connectors).toEqual([]);
      if (chainId === MAINNET_CHAIN_ID) {
        expect(arg.chain.blockExplorers.default.url).toBe("https://robinhoodchain.blockscout.com");
      }
      expect(W.walletModalEnabled()).toBe(true);
      expect(await W.openWalletModal()).toBe(true);
    });

  it("the dev wallet rides along only on localhost + 31337 + VITE_DEV_WALLET=1", async () => {
    h.cfg = readForkConfig({
      VITE_CHAIN_ID: "31337",
      VITE_DEV_WALLET: "1",
      VITE_WALLETCONNECT_PROJECT_ID: ID,
    });
    h.createWalletModal.mockImplementation(async (o: { chain: never; connectors: never[] }) => {
      const { createConfig } = await import("@wagmi/core");
      return fakeModal(
        createConfig({
          chains: [o.chain],
          connectors: o.connectors,
          transports: { 31337: (await import("viem")).http() },
        }),
      );
    });
    await W.initWallet();
    expect(location.hostname).toBe("localhost");
    expect(h.createWalletModal.mock.calls[0]![0].connectors).toHaveLength(1);
    expect(W.devWalletEnabled()).toBe(true);
  });

  it("a page load fetches the modal only when a wallet was connected on this browser before", async () => {
    h.cfg = readForkConfig({ VITE_CHAIN_ID: "4663", VITE_WALLETCONNECT_PROJECT_ID: ID });
    h.createWalletModal.mockImplementation(async (o: { chain: { id: number } }) => {
      const { createConfig } = await import("@wagmi/core");
      return fakeModal(
        createConfig({
          chains: [o.chain as never],
          transports: { [o.chain.id]: (await import("viem")).http() },
        }),
      );
    });
    localStorage.removeItem("plynth.wallet.used");
    await W.restoreConnection();
    expect(h.createWalletModal).not.toHaveBeenCalled();
    W._resetWalletForTests();
    localStorage.setItem("plynth.wallet.used", "1");
    await W.restoreConnection();
    expect(h.createWalletModal).toHaveBeenCalledTimes(1);
    localStorage.removeItem("plynth.wallet.used");
  });

  it("a modal that fails to load falls back to the browser-wallet list", async () => {
    h.cfg = readForkConfig({ VITE_CHAIN_ID: "4663", VITE_WALLETCONNECT_PROJECT_ID: ID });
    h.createWalletModal.mockRejectedValue(new Error("blocked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await W.initWallet();
    expect(await W.openWalletModal()).toBe(false);
    expect(W.wagmiConfig()?.chains.map((c) => c.id)).toEqual([MAINNET_CHAIN_ID]);
    warn.mockRestore();
  });
});

describe("fallback without a project id: EIP-6963 browser wallets", () => {
  it("never loads the modal; lists every announced wallet by name and icon", async () => {
    h.cfg = readForkConfig({ VITE_CHAIN_ID: "4663" });
    const off = [announce("MetaMask", "io.metamask"), announce("Rabby Wallet", "io.rabby")];
    await W.initWallet();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.createWalletModal).not.toHaveBeenCalled();
    expect(await W.openWalletModal()).toBe(false);
    const list = W.browserWallets();
    expect(list.map((w) => w.name)).toEqual(expect.arrayContaining(["MetaMask", "Rabby Wallet"]));
    expect(list.map((w) => w.name)).not.toContain("Browser wallet");
    expect(list.every((w) => w.icon?.startsWith("data:image/"))).toBe(true);
    expect(W.wagmiConfig()?.chains.map((c) => c.id)).toEqual([MAINNET_CHAIN_ID]);
    off.forEach((f) => f());
  });

  it("pickWallets: the plain window.ethereum wallet only when nothing announced itself", () => {
    const plain = { uid: "u0", id: "injected", name: "Injected", type: "injected" };
    const mm = {
      uid: "u1",
      id: "io.metamask",
      name: "MetaMask",
      type: "injected",
      icon: "data:image/png;base64,AA",
    };
    const dev = {
      uid: "u2",
      id: "plynthDevWallet",
      name: "Dev wallet (local fork)",
      type: "plynthDevWallet",
    };
    expect(W.pickWallets([plain, mm, dev], true)).toEqual([
      { uid: "u1", name: "MetaMask", icon: "data:image/png;base64,AA" },
    ]);
    expect(W.pickWallets([plain, dev], true)).toEqual([
      { uid: "u0", name: "Browser wallet", icon: undefined },
    ]);
    expect(W.pickWallets([plain, dev], false)).toEqual([]);
  });

  it("wallet icons are images only (no javascript: or other schemes)", () => {
    expect(W.safeIcon("data:image/svg+xml;base64,AA")).toBe("data:image/svg+xml;base64,AA");
    expect(W.safeIcon("https://x.org/i.png")).toBe("https://x.org/i.png");
    expect(W.safeIcon("javascript:alert(1)")).toBeUndefined();
    expect(W.safeIcon("http://x.org/i.png")).toBeUndefined();
    expect(W.safeIcon(undefined)).toBeUndefined();
  });

  it("the dashboard's list shows one button per wallet, or how to get one", async () => {
    h.cfg = readForkConfig({ VITE_CHAIN_ID: "4663" });
    const { walletPicker } = await import("./dashboard");
    await W.initWallet();
    document.body.innerHTML = walletPicker(false);
    expect(document.querySelector("[data-no-wallets]")!.textContent).toMatch(
      /No browser wallet found/,
    );
    W._resetWalletForTests();
    const off = announce("Coinbase Wallet", "com.coinbase.wallet");
    await W.initWallet();
    await new Promise((r) => setTimeout(r, 0));
    document.body.innerHTML = walletPicker(false);
    const btn = document.querySelector<HTMLButtonElement>('[data-action="connect-wallet"]')!;
    expect(btn.textContent).toBe("Coinbase Wallet");
    expect(btn.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\//);
    off();
  });

  it("no wallet connected before the layer is built (server render, first paint)", () => {
    h.cfg = readForkConfig({ VITE_CHAIN_ID: "4663" });
    expect(W.currentAccount()).toBeNull();
    expect(W.browserWallets()).toEqual([]);
  });
});
