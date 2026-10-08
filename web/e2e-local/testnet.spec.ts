// The `dev:testnet` profile against the running Robinhood Chain TESTNET (46630) stack, READ-ONLY.
// A stub wallet (window.ethereum) answers accounts and chain id for a watched address and REFUSES every signature and
// every send; reads go to the public testnet RPC and the testnet API on this machine. Nothing is ever broadcast: the test
// asserts the stub saw no send. Screenshots: test-results/screens-<date>/testnet/.
// Addresses: a fresh random one (nothing attested, nothing held) and, when the testnet database has one, an attested
// saver found at run time (TESTNET_VIEW_ADDRESS overrides), so no address is written into the repo.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DATE = new Date().toISOString().slice(0, 10);
const OUT = resolve(process.env.TESTNET_REPORT_DIR || `test-results/screens-${DATE}/testnet`);
mkdirSync(OUT, { recursive: true });

const RPC = "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const pub = createPublicClient({ transport: http(RPC, { retryCount: 5 }) });
const dep = JSON.parse(
  readFileSync(resolve("../app/deployments/46630.json"), "utf8"),
) as { usdg: Address; savingsVault: Address; eligibilityRegistry: Address; chainId: number };
const abi = parseAbi([
  "function isEligible(address) view returns (bool)",
  "function balancesOf(address) view returns (uint256 available, uint256 pending)",
  "function balanceOf(address) view returns (uint256)",
]);

const fresh = (): Address =>
  privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;

/** An attested saver with USDG in the vault, from the testnet database (read-only), or TESTNET_VIEW_ADDRESS. */
async function attestedSaver(): Promise<Address | null> {
  if (process.env.TESTNET_VIEW_ADDRESS) return getAddress(process.env.TESTNET_VIEW_ADDRESS);
  let rows: string[] = [];
  try {
    rows = execFileSync(
      "psql",
      ["-d", "plynth_testnet", "-Atc", `select distinct address from eligibility_decisions where allowed and chain_id = ${CHAIN_ID}`],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
  for (const r of rows) {
    const a = getAddress(r);
    const [ok, [avail, pend]] = await Promise.all([
      pub.readContract({ address: dep.eligibilityRegistry, abi, functionName: "isEligible", args: [a] }),
      pub.readContract({ address: dep.savingsVault, abi, functionName: "balancesOf", args: [a] }),
    ]);
    if (ok && avail + pend > 0n) return a;
  }
  return null;
}

/** Installs the read-only stub wallet for `address` before the page loads. */
async function watchOnly(page: Page, address: Address) {
  await page.addInitScript(
    ({ address, chainHex, rpc }) => {
      const sent: unknown[] = [];
      (window as unknown as { __stubSent: unknown[] }).__stubSent = sent;
      const refuse = (method: string, params: unknown) => {
        sent.push({ method, params });
        throw Object.assign(new Error("Read-only test wallet: refused"), { code: 4001 });
      };
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      (window as unknown as { ethereum: unknown }).ethereum = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return chainHex;
            case "net_version":
              return String(parseInt(chainHex, 16));
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
            case "wallet_revokePermissions":
              return null;
            case "eth_sendTransaction":
            case "eth_sendRawTransaction":
            case "eth_sign":
            case "personal_sign":
            case "eth_signTypedData_v4":
            case "eth_signTransaction":
              return refuse(method, params);
            default: {
              const r = await fetch(rpc, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
              }).then((x) => x.json());
              if (r.error) throw Object.assign(new Error(r.error.message), r.error);
              return r.result;
            }
          }
        },
        on: (ev: string, f: (...a: unknown[]) => void) => ((listeners[ev] ??= []).push(f), undefined),
        removeListener: (ev: string, f: (...a: unknown[]) => void) => {
          listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f);
        },
      };
    },
    { address, chainHex: `0x${CHAIN_ID.toString(16)}`, rpc: RPC },
  );
}

let shot = 0;
const snap = async (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, "0")}-${name}.png`, fullPage: true });

async function settled(page: Page) {
  await page.waitForFunction(() => !document.body.dataset.forkBusy && !document.body.dataset.forkLoading, null, {
    timeout: 120_000,
  });
  await expect(page.locator('[data-field="loading"]')).toHaveCount(0);
}

async function connect(page: Page, address: Address) {
  await page.goto("/dashboard/");
  await settled(page);
  await page.locator('[data-action="connect"]').click();
  await expect(page.locator("[data-fork-dashboard]")).toHaveAttribute("data-account", address);
  await settled(page);
  await expect(page.locator('[data-field="total"]')).toBeVisible();
}

const noSends = async (page: Page) =>
  expect(await page.evaluate(() => (window as unknown as { __stubSent: unknown[] }).__stubSent.length)).toBe(0);

test.beforeAll(async () => {
  expect(dep.chainId).toBe(CHAIN_ID);
  expect(await pub.getChainId()).toBe(CHAIN_ID); // never 4663
});

test("testnet profile: labels, empty state, gates and decoded reverts (fresh address, read-only)", async ({ page }) => {
  const me = fresh();
  await watchOnly(page, me);

  await test.step("before connecting: testnet labels, no dev wallet anywhere", async () => {
    await page.goto("/dashboard/");
    await settled(page);
    await expect(page.locator("[data-network-badge]")).toHaveText("ROBINHOOD CHAIN TESTNET · 46630");
    await expect(page.locator('[data-action="connect-dev"]')).toHaveCount(0);
    await expect(page.locator("[data-dev-wallet-badge]")).toHaveCount(0);
    await expect(page.locator('[data-field="footnote"]')).toContainText("test tokens only");
    expect(await page.locator("body").innerText()).not.toMatch(/local fork/i);
    await expect(page.locator("#fork-status")).toHaveText("TESTNET · NO TRANSACTIONS YET");
    await snap(page, "testnet-not-connected");
  });

  await test.step("connected: wallet USDG 0 + MAX off, empty allocation, Crowd Buy explained, Join gated", async () => {
    await connect(page, me);
    await expect(page.locator('[data-field="wallet-usdg"]')).toHaveText("0");
    await expect(page.locator('[data-action="deposit-max"]')).toBeDisabled();
    await expect(page.locator('[data-field="allocation-bar"]')).toHaveAttribute("data-empty", "1");
    const crowd = page.locator('[data-field="crowd"]');
    await expect(crowd).toContainText("Join only uses pending round-ups");
    await expect(crowd).toContainText("keeper joins you automatically");
    await expect(page.locator('[data-field="crowd-window"]')).toContainText("Window 2 h");
    await expect(page.locator('[data-action="join"]')).toBeDisabled();
    await expect(page.locator('[data-why="join"]')).toContainText("eligibility");
    expect(await page.locator("body").innerText()).not.toMatch(/local fork/i);
    await snap(page, "testnet-fresh-overview");
  });

  await test.step("a withdraw the vault cannot cover is decoded (InsufficientBalance), the wallet is never asked", async () => {
    await page.fill("#withdraw-amount", "5");
    await page.locator('[data-action="withdraw"]').click();
    await settled(page);
    const entry = page.locator("#fork-log > li").first();
    await expect(entry).toHaveAttribute("data-state", "error");
    await expect(entry).toContainText("would revert (InsufficientBalance)");
    await expect(entry).toContainText("Nothing was sent");
    await noSends(page);
    await snap(page, "testnet-revert-decoded");
  });

  await test.step("Settings: Save Mix disabled with the reason and a link to eligibility", async () => {
    await page.locator('.dashboard-nav a[href="/dashboard/settings/"]').click();
    await settled(page);
    await expect(page.locator('[data-field="eligible"]')).toHaveText("not attested");
    await expect(page.locator('[data-action="save-mix"]')).toBeDisabled();
    await expect(page.locator('[data-why="save-mix"]')).toContainText("NotEligible");
    await expect(page.locator('[data-why="save-mix"] a')).toHaveAttribute("href", "#eligibility");
    await snap(page, "testnet-fresh-settings");
    await noSends(page);
  });
});

test("testnet profile: an attested saver's dashboard (read-only)", async ({ page }) => {
  const saver = await attestedSaver();
  test.skip(!saver, "no attested saver with a vault balance on testnet");
  await watchOnly(page, saver!);
  await connect(page, saver!);

  await test.step("allocation in colour, weekly cap from the chain, Crowd Buy timing", async () => {
    const segs = page.locator('[data-field="allocation-bar"] i');
    expect(await segs.count()).toBeGreaterThan(0);
    for (const c of await segs.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor)))
      expect(c).not.toBe("rgb(17, 19, 20)");
    const wal = await pub.readContract({ address: dep.usdg, abi, functionName: "balanceOf", args: [saver!] });
    const f = (wal % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    await expect(page.locator('[data-field="wallet-usdg"]')).toHaveText(`${wal / 1_000_000n}${f ? `.${f}` : ""}`);
    await expect(page.locator('[data-field="weekly-cap"]')).not.toHaveText("");
    await expect(page.locator('[data-field="crowd-window"]')).toContainText("Window 2 h");
    await snap(page, "testnet-saver-overview");
  });

  await test.step("eligible: Save Mix enabled (sending would need the real wallet; the stub refuses)", async () => {
    await page.locator('.dashboard-nav a[href="/dashboard/settings/"]').click();
    await settled(page);
    await expect(page.locator('[data-field="eligible"]')).toHaveText("eligible");
    await expect(page.locator('[data-action="save-mix"]')).toBeEnabled();
    await expect(page.locator('[data-why="save-mix"]')).toHaveCount(0);
    await snap(page, "testnet-saver-settings");
    await noSends(page);
  });
});
