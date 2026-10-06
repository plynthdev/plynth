// Dev wallet: an EIP-1193 provider that signs locally with one of anvil's PUBLIC dev keys, wrapped as a wagmi
// connector. It exists so Claude (Playwright) can click through the dashboard with no browser extension.
// Offered only when VITE_DEV_WALLET=1 AND the page is on localhost AND the chain is 31337 (config.ts).
import { createConnector } from "@wagmi/core";
import {
  createWalletClient,
  fromHex,
  getAddress,
  http,
  numberToHex,
  type Account,
  type Chain,
  type EIP1193RequestFn,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

/** Anvil's default mnemonic: every key derived from it is public. Never fund these on a real network. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"; // test-key (anvil default mnemonic)
/** Account #20 of the dev mnemonic: funded by the fork's fund step, unused by the fork's service roles (0-9). */
export const DEV_WALLET_INDEX = 20;

export function devAccount(index = DEV_WALLET_INDEX): Account {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }); // test-key
}

type RpcTx = { from?: Hex; to?: Hex; data?: Hex; input?: Hex; value?: Hex; gas?: Hex };

/** EIP-1193 provider: account, chain and signing methods answered locally, everything else forwarded to the RPC. */
export function createDevProvider(opts: {
  account: Account;
  chain: Chain;
  rpcUrl: string;
  fetchFn?: typeof fetch;
}) {
  const { account, chain, rpcUrl } = opts;
  const transport = http(rpcUrl, opts.fetchFn ? { fetchFn: opts.fetchFn } : {});
  const wallet = createWalletClient({ account, chain, transport });
  const forward = transport({ chain }).request as EIP1193RequestFn;
  const mine = (a: unknown) =>
    typeof a === "string" && a.toLowerCase() === account.address.toLowerCase();

  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "eth_chainId":
        return numberToHex(chain.id);
      case "wallet_switchEthereumChain": {
        const id = fromHex((p[0] as { chainId: Hex }).chainId, "number");
        if (id !== chain.id) throw new Error(`dev wallet only knows chain ${chain.id}`);
        return null;
      }
      case "personal_sign": {
        const [data, addr] = p as [Hex, string];
        if (!mine(addr)) throw new Error("personal_sign for another account");
        return account.signMessage!({ message: { raw: data } });
      }
      case "eth_signTypedData_v4": {
        const [addr, json] = p as [string, string];
        if (!mine(addr)) throw new Error("signTypedData for another account");
        const td = typeof json === "string" ? JSON.parse(json) : json;
        const { EIP712Domain: _drop, ...types } = td.types ?? {};
        return account.signTypedData!({
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: td.message,
        });
      }
      case "eth_sendTransaction": {
        const tx = p[0] as RpcTx;
        if (tx.from && !mine(tx.from)) throw new Error("eth_sendTransaction from another account");
        return wallet.sendTransaction({
          account,
          chain,
          to: tx.to ? getAddress(tx.to) : null,
          data: tx.data ?? tx.input,
          value: tx.value ? fromHex(tx.value, "bigint") : 0n,
          ...(tx.gas ? { gas: fromHex(tx.gas, "bigint") } : {}),
        });
      }
      default:
        return forward({ method, params } as never);
    }
  };
  return { request } as { request: EIP1193RequestFn };
}

/** wagmi connector over createDevProvider. */
/** Remembers "connected" across reloads (like MetaMask's own permission); only a flag, never a key. */
const REMEMBER = "plynth.devWallet.connected";
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBER) === "1";
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(REMEMBER, "1");
    else localStorage.removeItem(REMEMBER);
  } catch {
    // Storage blocked (private window): the dev wallet just asks to connect again after a reload.
  }
};

export function devWallet(opts: { rpcUrl: string; index?: number }) {
  const account = devAccount(opts.index);
  let connected = remembered();
  let provider: ReturnType<typeof createDevProvider> | undefined;
  return createConnector((config) => ({
    id: "plynthDevWallet",
    name: "Dev wallet (local fork)",
    type: "plynthDevWallet",
    async connect(params?: { chainId?: number; withCapabilities?: boolean }) {
      connected = true;
      remember(true);
      const chainId = config.chains[0].id;
      const accounts = params?.withCapabilities
        ? [{ address: account.address, capabilities: {} }]
        : [account.address];
      return { accounts, chainId } as never;
    },
    async disconnect() {
      connected = false;
      remember(false);
    },
    async getAccounts() {
      return connected ? [account.address] : [];
    },
    async getChainId() {
      return config.chains[0].id;
    },
    async getProvider() {
      return (provider ??= createDevProvider({
        account,
        chain: config.chains[0],
        rpcUrl: opts.rpcUrl,
      }));
    },
    async isAuthorized() {
      return connected;
    },
    async switchChain({ chainId }: { chainId: number }) {
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain) throw new Error(`chain ${chainId} not configured`);
      return chain;
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      connected = false;
      remember(false);
      config.emitter.emit("disconnect");
    },
  }));
}
