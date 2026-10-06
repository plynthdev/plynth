// Rules of the local-fork wiring that need no running fork (the flows themselves: e2e-local/flows.spec.ts).
import { describe, expect, it } from "vitest";
import {
  hashTypedData,
  recoverMessageAddress,
  recoverTypedDataAddress,
  toHex,
  type Address,
} from "viem";
import { DEFAULTS, devWalletAllowed, isLocalHost, PROXY, readForkConfig } from "./config";
import { ANVIL_MNEMONIC, createDevProvider, devAccount, DEV_WALLET_INDEX } from "./dev-wallet";
import { errorText } from "./api";
import {
  chartPoints,
  esc,
  formatRaw,
  formatUsdg,
  mixFromPercents,
  modeKey,
  money,
  parseUsdg,
  roundupMessage,
  selfAttestationTypedData,
  sha256Hex,
  STATEMENT,
  trimDecimals,
} from "./logic";
import { plynthForkChain } from "./wallet";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;

describe("config", () => {
  it("defaults to the fork stack's ports and chain 31337", () => {
    const c = readForkConfig({});
    expect(c).toMatchObject({
      enabled: true,
      apiUrl: DEFAULTS.apiUrl,
      rpcUrl: DEFAULTS.rpcUrl,
      relayerUrl: DEFAULTS.relayerUrl,
      chainId: 31337,
      devWalletFlag: false,
    });
    expect(c.apiBase).toBe(DEFAULTS.apiUrl);
  });
  it("reads every VITE_* setting and strips trailing slashes", () => {
    const c = readForkConfig({
      VITE_API_URL: "http://127.0.0.1:9000/",
      VITE_RPC_URL: "http://127.0.0.1:9545",
      VITE_CHAIN_ID: "1337",
      VITE_RELAYER_URL: "http://127.0.0.1:9001//",
      VITE_DEV_WALLET: "1",
    });
    expect(c).toMatchObject({
      apiUrl: "http://127.0.0.1:9000",
      rpcUrl: "http://127.0.0.1:9545",
      chainId: 1337,
      relayerUrl: "http://127.0.0.1:9001",
      devWalletFlag: true,
    });
  });
  it("uses the dev-server proxy paths under vite dev (no CORS needed)", () => {
    const c = readForkConfig({ DEV: true });
    expect(c.apiBase).toBe(PROXY.api);
    expect(c.relayerBase).toBe(PROXY.relayer);
  });
  it("VITE_FORK=0 brings back the preview dashboard", () => {
    expect(readForkConfig({ VITE_FORK: "0" }).enabled).toBe(false);
  });
  it("refuses a malformed chain id", () => {
    expect(() => readForkConfig({ VITE_CHAIN_ID: "abc" })).toThrow(/VITE_CHAIN_ID/);
    expect(() => readForkConfig({ VITE_CHAIN_ID: "0" })).toThrow(/VITE_CHAIN_ID/);
  });
});

describe("dev wallet gating", () => {
  const on = { devWalletFlag: true, chainId: 31337 };
  it("is offered only with VITE_DEV_WALLET=1 on a localhost page of the 31337 fork", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "app.localhost"])
      expect(devWalletAllowed(on, h)).toBe(true);
  });
  it("is never offered on a real host, without the flag, or on another chain", () => {
    for (const h of ["plynthlations.lovable.app", "example.com", "10.0.0.5", "localhost.evil.com"])
      expect(devWalletAllowed(on, h)).toBe(false);
    expect(devWalletAllowed({ devWalletFlag: false, chainId: 31337 }, "localhost")).toBe(false);
    expect(devWalletAllowed({ devWalletFlag: true, chainId: 4663 }, "localhost")).toBe(false);
    expect(isLocalHost("127.0.0.2")).toBe(false);
  });
  it("uses anvil's public mnemonic, account #20 (outside the fork's service roles 0-9)", () => {
    expect(ANVIL_MNEMONIC).toBe("test test test test test test test test test test test junk");
    expect(DEV_WALLET_INDEX).toBe(20);
    expect(devAccount().address).toBe("0x09DB0a93B389bEF724429898f539AEB7ac2Dd55f");
  });
});

describe("dev wallet provider", () => {
  const chain = plynthForkChain({ chainId: 31337, rpcUrl: "http://127.0.0.1:1" });
  const account = devAccount();
  const forwarded: string[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    forwarded.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x10" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const p = createDevProvider({ account, chain, rpcUrl: "http://127.0.0.1:1", fetchFn });

  it("answers accounts and chain id locally", async () => {
    expect(await p.request({ method: "eth_requestAccounts" } as never)).toEqual([account.address]);
    expect(await p.request({ method: "eth_chainId" } as never)).toBe("0x7a69");
  });
  it("personal_sign signs as the dev account", async () => {
    const sig = (await p.request({
      method: "personal_sign",
      params: [toHex("hello"), account.address],
    } as never)) as `0x${string}`;
    expect(await recoverMessageAddress({ message: "hello", signature: sig })).toBe(account.address);
  });
  it("eth_signTypedData_v4 signs the eligibility statement as the dev account", async () => {
    const td = selfAttestationTypedData(31337, account.address, 2_000_000_000n);
    const json = JSON.stringify({
      ...td,
      types: { EIP712Domain: [{ name: "name", type: "string" }], ...td.types },
      message: { ...td.message, expiry: "2000000000" },
    });
    const sig = (await p.request({
      method: "eth_signTypedData_v4",
      params: [account.address, json],
    } as never)) as `0x${string}`;
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(account.address);
  });
  it("refuses to sign for another account or switch to another chain", async () => {
    await expect(
      p.request({ method: "personal_sign", params: ["0x00", A] } as never),
    ).rejects.toThrow(/another account/);
    await expect(
      p.request({ method: "eth_sendTransaction", params: [{ from: A, to: B }] } as never),
    ).rejects.toThrow(/another account/);
    await expect(
      p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] } as never),
    ).rejects.toThrow(/only knows chain 31337/);
  });
  it("forwards reads to the fork RPC", async () => {
    expect(await p.request({ method: "eth_blockNumber" } as never)).toBe("0x10");
    expect(forwarded).toContain("eth_blockNumber");
  });
});

describe("eligibility statement and round-up message (must match the backend byte for byte)", () => {
  it("statement text, version and EIP-712 domain", () => {
    const td = selfAttestationTypedData(31337, A, 1n);
    expect(td.domain).toEqual({ name: "Plynth Eligibility", version: "1", chainId: 31337 });
    expect(td.message.statement).toBe(STATEMENT);
    expect(td.message.version).toBe(1);
    // Digest computed with backend app/src/eligibility/statement.ts (same wallet/expiry): any drift breaks this.
    expect(hashTypedData(td)).toBe(
      "0x9b2f320016bf00a2d9a7d674ef1c11983154b05b9fc4193da67eb14f9a22023c",
    );
  });
  it("round-up import message lines", () => {
    expect(
      roundupMessage({ action: "import", user: A, chainId: 31337, subject: "ab", issuedAt: 5 }),
    ).toBe(
      `Plynth round-up sources\naction: import\nuser: ${A}\nchain: 31337\nsubject: ab\nissued: 5`,
    );
  });
  it("sha256 of the CSV as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("amounts", () => {
  it("parses USDG with at most 6 decimals and refuses 0, signs and junk", () => {
    expect(parseUsdg("12.5")).toBe(12_500_000n);
    expect(parseUsdg(" 300 ")).toBe(300_000_000n);
    expect(parseUsdg("0.000001")).toBe(1n);
    for (const bad of ["0", "-1", "1e3", "1.0000001", "", "abc", "1,5"])
      expect(() => parseUsdg(bad)).toThrow();
  });
  it("formats USDG, raw token units, API decimals and dollars", () => {
    expect(formatUsdg(7_700_000n)).toBe("7.7");
    expect(formatUsdg(300_000_000n)).toBe("300");
    expect(formatUsdg(0n)).toBe("0");
    expect(formatRaw("1500000000000000000")).toBe("1.5");
    expect(formatRaw(50_000_000n, 6)).toBe("50");
    expect(trimDecimals("0.012345678901234567")).toBe("0.012345");
    expect(trimDecimals("12.300000")).toBe("12.3");
    expect(trimDecimals("5.000000")).toBe("5");
    expect(money("2486.500000")).toBe("$2,486.50");
    expect(money("junk")).toBe("$0.00");
  });
});

describe("buy mix", () => {
  it("turns percentages into bps that sum to exactly 10000 and drops zero rows", () => {
    expect(
      mixFromPercents([
        { token: A, percent: "50" },
        { token: B, percent: "50" },
        { token: A, percent: "" },
      ]),
    ).toEqual([
      { token: A, weightBps: 5000 },
      { token: B, weightBps: 5000 },
    ]);
    expect(
      mixFromPercents([
        { token: A, percent: "33.33" },
        { token: B, percent: "66.67" },
      ]),
    ).toEqual([
      { token: A, weightBps: 3333 },
      { token: B, weightBps: 6667 },
    ]);
  });
  it("refuses empty, more than 5, negative, or not 100 in total", () => {
    expect(() => mixFromPercents([])).toThrow(/at least one/);
    expect(() =>
      mixFromPercents(Array.from({ length: 6 }, () => ({ token: A, percent: "10" }))),
    ).toThrow(/at most 5/);
    expect(() =>
      mixFromPercents([
        { token: A, percent: "-10" },
        { token: B, percent: "110" },
      ]),
    ).toThrow(/positive/);
    expect(() => mixFromPercents([{ token: A, percent: "90" }])).toThrow(
      /add up to 100 \(now 90\)/,
    );
  });
});

describe("chart and markup helpers", () => {
  it("maps habit values onto the 600x220 chart (first point left, last right, highest at the top margin)", () => {
    expect(chartPoints([0, 5, 10])).toBe("0,200 300,110 600,20");
    expect(chartPoints([])).toBe("0,200 600,200");
    expect(chartPoints([3])).toBe("600,20");
    expect(chartPoints([0, 0])).toBe("0,200 600,200");
  });
  it("escapes API text before it reaches innerHTML", () => {
    expect(esc(`<img src=x onerror="a">&'`)).toBe(
      "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;",
    );
  });
  it("accepts only the three modes", () => {
    expect(modeKey("Quiet")).toBe("quiet");
    expect(() => modeKey("Loud")).toThrow(/Open, Quiet or Hidden/);
  });
  it("reads both error shapes (API {error:{message}}, relayer {error})", () => {
    expect(errorText({ error: { code: "BAD_REQUEST", message: "weights must sum" } }, 400)).toBe(
      "weights must sum",
    );
    expect(errorText({ error: "nullifier spent" }, 409)).toBe("nullifier spent");
    expect(errorText(null, 502)).toBe("HTTP 502");
  });
});
