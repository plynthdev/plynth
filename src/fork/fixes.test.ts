// Todo 41: the fixes from Kal's click-throughs, one describe per item. The dashboard is rendered with the wallet,
// API and chain reads mocked (the same flows against a real stack: e2e-local/flows.spec.ts and testnet.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeErrorResult, type Address, type Hex } from "viem";
import {
  allocationSegments,
  bookTimingText,
  joinGate,
  mixGate,
  networkText,
  recordProgress,
  renderTxLog,
  settingsMatch,
  type LogEntry,
} from "./logic";
import { decodeRevert, ERRORS_ABI, revertData, simulateTx, SimulationRevert } from "./simulate";

const USER = "0x00000000000000000000000000000000000000a1" as Address;
const TSLA = "0x00000000000000000000000000000000000000c3" as Address;

// ---------------------------------------------------------------- mocks for the rendered dashboard

const m = vi.hoisted(() => ({
  acct: null as null | { address: Address; kind: "dev" | "injected" },
  chainId: 31337,
  devEnabled: true,
  eligible: false,
  balances: { available: 0n, pending: 0n },
  walletUsdg: 0n,
  overview: undefined as unknown,
  settings: undefined as unknown,
  books: undefined as unknown,
  saveSettings: vi.fn(),
}));

vi.mock("./wallet", () => ({
  currentAccount: () => m.acct,
  devWalletEnabled: () => m.devEnabled,
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(async () => {}),
  onAccountChange: () => () => {},
  restoreConnection: async () => {},
}));
vi.mock("./config", async (orig) => {
  const real = await orig<typeof import("./config")>();
  return {
    ...real,
    forkConfig: () => ({
      ...real.readForkConfig({ VITE_CHAIN_ID: String(m.chainId) }),
    }),
  };
});
vi.mock("./api", () => ({
  api: {
    get: async (path: string) => {
      if (path.endsWith("/overview")) return m.overview;
      if (path.includes("/habit")) return { range: "1M", unit: "day", points: [] };
      if (path.includes("/activity")) return { rows: [], nextCursor: null };
      if (path.endsWith("/settings")) return m.settings;
      if (path === "/v1/crowd/books") return m.books;
      throw new Error(`unexpected GET ${path}`);
    },
    post: vi.fn(),
  },
}));
vi.mock("./actions", () => ({
  isEligible: async () => m.eligible,
  vaultBalances: async () => m.balances,
  walletUsdg: async () => m.walletUsdg,
  hasMetaAddress: async () => false,
  hasHiddenKeys: async () => false,
  claimables: async () => [],
  statementsOf: async () => ({ hidden: false, ownerPk: null, pool: USER, statements: [] }),
  saveSettings: m.saveSettings,
}));

const { liveDashboard, _resetForTests } = await import("./dashboard");

const kit = { icon: () => "", logo: () => "", footer: () => "" } as never;

function overview(alloc: { stockTokensUsd: string; parkUsd: string; availableUsdg: string }, weeklyCap = "0") {
  return {
    totalHoldingsUsd: "0",
    allocation: { ...alloc, vaultUsdg: alloc.availableUsdg, queuedUsdg: "0" },
    weekRoundups: "0",
    weeklyCap,
    mode: "open",
    holdings: [],
  };
}
const settings = (weeklyCap: string) => ({
  configured: weeklyCap !== "0",
  roundTo: 10,
  multiplier: 1,
  weeklyCap,
  fixedTopUp: "0",
  mode: "open",
  mix: [],
});
const books = (accounts: number, executeAfter: string | null = null) => ({
  now: "2026-10-07T14:30:00.000Z",
  window: { start: "2026-10-07T14:00:00.000Z", end: "2026-10-07T16:00:00.000Z", next: "2026-10-07T16:00:00.000Z" },
  books: [
    {
      asset: TSLA,
      symbol: "TSLA",
      open: { bookId: "4", accounts, minCrowd: 3, usdgTotal: "7.7", executeAfter, executedThisWindow: false },
    },
  ],
});

/** Mounts the dashboard at `path` the way the site runtime does and waits until the data is loaded. */
async function mount(path = "/dashboard/") {
  const ac = new AbortController();
  const render = () => {
    document.body.innerHTML = liveDashboard.html(path, kit);
  };
  const ctx = { rerender: () => {
    render();
    liveDashboard.setup(ctx);
  }, signal: ac.signal };
  render();
  liveDashboard.setup(ctx); // first call: watchers + restore
  await vi.waitFor(() => expect(document.body.dataset.forkLoading).toBeUndefined());
  ctx.rerender();
  await vi.waitFor(() => {
    expect(document.body.dataset.forkLoading).toBeUndefined();
    expect(document.querySelector('[data-field="loading"]')).toBeNull();
  });
  return { ac, ctx };
}

beforeEach(() => {
  _resetForTests();
  Object.assign(m, {
    acct: { address: USER, kind: "dev" },
    chainId: 31337,
    devEnabled: true,
    eligible: false,
    balances: { available: 0n, pending: 0n },
    walletUsdg: 0n,
    overview: overview({ stockTokensUsd: "0", parkUsd: "0", availableUsdg: "0" }),
    settings: settings("0"),
    books: books(1),
  });
  m.saveSettings.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------- 1. wallet USDG next to Deposit, Max

describe("1. wallet USDG balance next to Deposit, with Max", () => {
  it("shows the wallet's USDG and MAX fills the deposit amount with all of it", async () => {
    m.walletUsdg = 1_234_500_000n;
    await mount();
    expect(document.querySelector('[data-field="wallet-usdg"]')!.textContent).toBe("1234.5");
    (document.querySelector('[data-action="deposit-max"]') as HTMLButtonElement).click();
    expect((document.getElementById("deposit-amount") as HTMLInputElement).value).toBe("1234.5");
  });

  it("MAX is disabled with an empty wallet", async () => {
    await mount();
    expect(document.querySelector('[data-action="deposit-max"]')!.hasAttribute("disabled")).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. allocation bar

describe("2. allocation bar: coloured segment per part, empty state", () => {
  it("drops zero parts and sizes the rest by value (each non-zero part at least 1%)", () => {
    expect(allocationSegments({ stockTokensUsd: "75", parkUsd: "0", availableUsdg: "25" })).toEqual([
      { key: "stocks", label: "Stock tokens", usd: 75, pct: 75 },
      { key: "usdg", label: "Available USDG", usd: 25, pct: 25 },
    ]);
    expect(allocationSegments({ stockTokensUsd: "0.001", parkUsd: "0", availableUsdg: "999" })[0]!.pct).toBe(1);
    expect(allocationSegments({ stockTokensUsd: "0", parkUsd: "0", availableUsdg: "0" })).toEqual([]);
    expect(allocationSegments(undefined)).toEqual([]);
  });

  it("only USDG: one gold (alloc-usdg) segment at 100%, not the ink nth-child that rendered solid black", async () => {
    m.overview = overview({ stockTokensUsd: "0", parkUsd: "0", availableUsdg: "300" });
    await mount();
    const segs = [...document.querySelectorAll<HTMLElement>('[data-field="allocation-bar"] i')];
    expect(segs.map((s) => s.className)).toEqual(["alloc-usdg"]);
    expect(segs[0]!.style.width).toBe("100%");
  });

  it("nothing held: a labelled empty state, no segments", async () => {
    await mount();
    const bar = document.querySelector('[data-field="allocation-bar"]')!;
    expect(bar.getAttribute("data-empty")).toBe("1");
    expect(bar.querySelectorAll("i")).toHaveLength(0);
    expect(bar.textContent).toMatch(/NOTHING ALLOCATED YET/);
  });

  it("every part has its own class (and legend dot)", async () => {
    m.overview = overview({ stockTokensUsd: "50", parkUsd: "20", availableUsdg: "30" });
    await mount();
    expect([...document.querySelectorAll('[data-field="allocation-bar"] i')].map((s) => s.className)).toEqual([
      "alloc-stocks",
      "alloc-park",
      "alloc-usdg",
    ]);
    expect(document.querySelectorAll(".allocation-rows .alloc-dot")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- 3. dev wallet badge

describe("3. DEV WALLET badge only when the dev wallet is the connected connector", () => {
  it("dev wallet connected: badge shown", async () => {
    await mount();
    expect(document.querySelector("[data-dev-wallet-badge]")!.textContent).toBe("DEV WALLET — LOCAL FORK");
  });
  it("MetaMask connected (dev wallet merely offered): no badge", async () => {
    m.acct = { address: USER, kind: "injected" };
    await mount();
    expect(document.querySelector("[data-dev-wallet-badge]")).toBeNull();
  });
  it("not connected: no badge, the DEV WALLET connect button is offered", async () => {
    m.acct = null;
    document.body.innerHTML = liveDashboard.html("/dashboard/", kit);
    expect(document.querySelector("[data-dev-wallet-badge]")).toBeNull();
    expect(document.querySelector('[data-action="connect-dev"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 4. gates and simulation

describe("4. Save Mix and Join wait for eligibility; nothing is sent that simulation says reverts", () => {
  it("gates: eligibility first, then pending round-ups for Join", () => {
    expect(mixGate(false)).toMatchObject({ ok: false, reason: expect.stringMatching(/eligibility/) });
    expect(mixGate(true)).toEqual({ ok: true });
    expect(joinGate(false, 5n)).toMatchObject({ ok: false, reason: expect.stringMatching(/eligibility/) });
    expect(joinGate(true, 0n)).toMatchObject({ ok: false, reason: expect.stringMatching(/pending/) });
    expect(joinGate(true, 1n)).toEqual({ ok: true });
  });

  it("not eligible: SAVE MIX disabled with a one-line reason and a link to eligibility", async () => {
    await mount("/dashboard/settings/");
    const b = document.querySelector('[data-action="save-mix"]')!;
    expect(b.hasAttribute("disabled")).toBe(true);
    const why = document.querySelector('[data-why="save-mix"]')!;
    expect(why.textContent).toMatch(/eligibility/);
    expect(why.querySelector("a")!.getAttribute("href")).toBe("#eligibility");
    expect(document.getElementById("eligibility")).not.toBeNull();
  });

  it("not eligible: JOIN disabled with a reason and a link to Settings", async () => {
    m.balances = { available: 0n, pending: 7_700_000n };
    await mount();
    expect(document.querySelector('[data-action="join"]')!.hasAttribute("disabled")).toBe(true);
    const why = document.querySelector('[data-why="join"]')!;
    expect(why.textContent).toMatch(/NotEligible/);
    expect(why.querySelector("a")!.getAttribute("href")).toBe("/dashboard/settings/");
  });

  it("eligible with pending round-ups: SAVE MIX and JOIN enabled, no reason shown", async () => {
    m.eligible = true;
    m.balances = { available: 0n, pending: 7_700_000n };
    await mount();
    expect(document.querySelector('[data-action="join"]')!.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector('[data-why="join"]')).toBeNull();
  });

  const nope = encodeErrorResult({ abi: ERRORS_ABI, errorName: "NotEligible", args: [USER] });
  const req = { account: USER as Hex, to: TSLA as Hex, data: "0x1234" as Hex, value: 0n };

  it("decodes the contracts' custom errors into a sentence", () => {
    expect(decodeRevert(nope)).toMatchObject({ name: "NotEligible", message: expect.stringMatching(/not eligible/) });
    const bal = encodeErrorResult({
      abi: ERRORS_ABI,
      errorName: "ERC20InsufficientBalance",
      args: [USER, 5_000_000n, 10_000_000n],
    });
    expect(decodeRevert(bal)!.message).toBe("Your wallet holds 5 USDG, the transaction needs 10 USDG.");
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert("0xdeadbeef")).toBeNull();
  });

  it("finds revert data deep in a viem error chain", () => {
    const e = { shortMessage: "Execution reverted", cause: { cause: { data: nope } } };
    expect(revertData(e)).toBe(nope);
  });

  it("a reverting call throws SimulationRevert with the decoded reason and never estimates or sends", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 10n),
      call: vi.fn(async () => {
        throw Object.assign(new Error("execution reverted"), { cause: { data: nope } });
      }),
      estimateGas: vi.fn(async () => 21_000n),
    };
    const err = await simulateTx(client, req, "Save buy mix").catch((e) => e);
    expect(err).toBeInstanceOf(SimulationRevert);
    expect(err.message).toMatch(/^Save buy mix would revert \(NotEligible\): .*Nothing was sent\.$/);
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it("a passing call returns a gas limit with headroom (the wallet does not estimate: no 'fee unavailable')", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 10n),
      call: vi.fn(async () => ({})),
      estimateGas: vi.fn(async () => 100_000n),
    };
    expect(await simulateTx(client, req, "x")).toBe(175_000n);
  });

  it("waits for a node that has the previous receipt's block, and retries once before calling it a revert", async () => {
    let block = 8n;
    let calls = 0;
    const client = {
      getBlockNumber: vi.fn(async () => block++),
      call: vi.fn(async () => {
        if (calls++ === 0) throw new Error("stale node");
        return {};
      }),
      estimateGas: vi.fn(async () => 0n),
    };
    expect(await simulateTx(client, req, "x", { minBlock: 10n, retryMs: 1 })).toBe(50_000n);
    expect(client.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(client.call).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------- 5. Crowd Buy explained

describe("5. Crowd Buy: pending only, the keeper joins, next execution, how to get round-ups", () => {
  const w = { start: "2026-10-07T14:00:00.000Z", end: "2026-10-07T16:00:00.000Z", next: "2026-10-07T16:00:00.000Z" };
  it("book timing text", () => {
    const b = { symbol: "TSLA", accounts: 1, minCrowd: 3, executeAfter: null };
    expect(bookTimingText(b, w)).toBe("needs 2 more account(s) to reach the minimum crowd of 3");
    expect(bookTimingText({ ...b, accounts: 3 }, w)).toBe(
      "executes at a jittered time before 2026-10-07 16:00 UTC (revealed by the keeper's beacon)",
    );
    expect(bookTimingText({ ...b, accounts: 3, executeAfter: "2026-10-07T15:12:00.000Z" }, w)).toBe(
      "executes after 2026-10-07 15:12 UTC (the beacon's revealed time)",
    );
    expect(bookTimingText({ ...b, accounts: 3, executedThisWindow: true }, w)).toMatch(/^executed this window/);
  });

  it("the panel says Join uses pending round-ups only, shows the pending amount, the keeper and the statement import", async () => {
    m.balances = { available: 300_000_000n, pending: 7_700_000n };
    m.books = books(3, "2026-10-07T15:12:00.000Z");
    await mount();
    const p = document.querySelector('[data-field="crowd"]')!;
    expect(p.textContent).toMatch(/Join only uses pending round-ups/);
    expect(p.querySelector('[data-field="crowd-pending"]')!.textContent).toBe("7.7");
    expect(p.textContent).toMatch(/keeper joins you automatically/);
    expect(p.querySelector('[data-field="next-execution"]')!.textContent).toMatch(/executes after 2026-10-07 15:12 UTC/);
    expect(p.querySelector('[data-field="crowd-window"]')!.textContent).toMatch(/Window 2 h/);
    expect(p.querySelector(".fork-howto a")!.getAttribute("href")).toBe("/dashboard/settings/");
  });
});

// ---------------------------------------------------------------- 6. transactions listed once

describe("6. Transactions panel lists every transaction once", () => {
  it("a confirmation moves the hash from pending to the action's list, once even if repeated", () => {
    const e: LogEntry = { id: 1, label: "Deposit", state: "running", msg: "", txs: [] };
    const h1 = `0x${"1".repeat(64)}`;
    const h2 = `0x${"2".repeat(64)}`;
    recordProgress(e, "Approve USDG: sent, waiting for the receipt…", h1);
    expect(e.pending).toBe(h1);
    recordProgress(e, "Approve USDG: confirmed in block 5", h1);
    recordProgress(e, "Approve USDG: confirmed in block 5", h1);
    recordProgress(e, "Deposit 300 USDG: sent, waiting for the receipt…", h2);
    recordProgress(e, "Deposit 300 USDG: confirmed in block 6", h2);
    e.state = "ok";
    expect(e.txs.map((t) => t.hash)).toEqual([h1, h2]);
    const html = renderTxLog([e], "none");
    for (const h of [h1, h2]) expect(html.split(`data-tx-hash="${h}"`)).toHaveLength(2);
    // The confirmation text appears once (not on the action's line and again on its own line).
    expect(html.split("Deposit 300 USDG: confirmed in block 6")).toHaveLength(2);
    expect(html).toMatch(/2 transactions confirmed/);
  });

  it("empty panel names the network", () => {
    expect(renderTxLog([], "TESTNET · NO TRANSACTIONS YET")).toMatch(/TESTNET · NO TRANSACTIONS YET/);
  });
});

// ---------------------------------------------------------------- 7. network-aware labels

describe("7. footer and badges follow the network, never wrong", () => {
  it("fork, testnet, mainnet and unknown chains", () => {
    expect(networkText(31337)).toMatchObject({ kind: "fork", badge: "LOCAL FORK · 31337" });
    expect(networkText(31337).footnote).toMatch(/Local fork .*Nothing here touches a real network/);
    expect(networkText(46630)).toMatchObject({ kind: "testnet", badge: "ROBINHOOD CHAIN TESTNET · 46630" });
    expect(networkText(46630).footnote).toMatch(/Robinhood Chain testnet .*test tokens only/);
    expect(networkText(46630).footnote).not.toMatch(/fork/i);
    expect(networkText(4663).footnote).toMatch(/real funds/);
    expect(networkText(1).footnote).toBe("Unknown network (chain id 1).");
  });

  it("a testnet page never says local fork", async () => {
    m.chainId = 46630;
    m.devEnabled = false;
    m.acct = { address: USER, kind: "injected" };
    await mount();
    const text = document.body.textContent!;
    expect(text).not.toMatch(/local fork/i);
    expect(document.querySelector("[data-network-badge]")!.textContent).toBe("ROBINHOOD CHAIN TESTNET · 46630");
    expect(document.querySelector('[data-field="footnote"]')!.textContent).toMatch(/test tokens only/);
    expect(text).toMatch(/SAVED USDG · TESTNET DATA/);
  });

  it("the fork page says local fork", async () => {
    await mount();
    expect(document.querySelector("[data-network-badge]")!.textContent).toBe("LOCAL FORK · 31337");
    expect(document.querySelector('[data-field="footnote"]')!.textContent).toMatch(/Nothing here touches a real network/);
  });
});

// ---------------------------------------------------------------- 8. weekly cap after Save Settings

describe("8. weekly cap shows the saved value after Save Settings", () => {
  it("settingsMatch compares what was saved with what the API reads", () => {
    const f = { roundTo: 10, multiplier: 1, weeklyCap: "100", fixedTopUp: "0", mode: "open" };
    expect(settingsMatch(f, { ...f, weeklyCap: "100.000000", fixedTopUp: "0.000000" })).toBe(true);
    expect(settingsMatch(f, { ...f, weeklyCap: "0.000000" })).toBe(false);
    expect(settingsMatch(f, undefined)).toBe(false);
  });

  it("a stale API answer after the receipt does not show $0.00: the confirmed value is shown", async () => {
    m.saveSettings.mockResolvedValue({});
    await mount("/dashboard/settings/");
    (document.getElementById("weekly-cap") as HTMLInputElement).value = "100";
    (document.querySelector('[data-action="save-settings"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#fork-log > li[data-state="ok"]')).not.toBeNull());
    await vi.waitFor(() => expect(document.body.dataset.forkLoading).toBeUndefined());
    expect(m.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ weeklyCap: "100", roundTo: 10 }),
      expect.any(Function),
    );
    // The API still answers weeklyCap 0 (a node a block behind), yet the page shows what was confirmed.
    expect((document.getElementById("weekly-cap") as HTMLInputElement).value).toBe("100");
    document.body.innerHTML = liveDashboard.html("/dashboard/", kit);
    expect(document.querySelector('[data-field="weekly-cap"]')!.textContent).toBe("$100.00");
  });
});

describe("typed amounts survive a re-render", () => {
  it("a reload while typing keeps the deposit amount", async () => {
    const { ctx } = await mount();
    (document.getElementById("deposit-amount") as HTMLInputElement).value = "42";
    ctx.rerender();
    expect((document.getElementById("deposit-amount") as HTMLInputElement).value).toBe("42");
  });
});
