// The whole consumer flow through the dashboard on the local fork, with the dev wallet:
// connect -> eligibility -> deposit -> settings -> mix -> (round-ups accrue, crowd executes: keeper + helper)
// -> claim (Open) -> switch to Quiet -> second round -> relayer claim -> Hidden deposit/withdraw -> withdraw all.
// Every step takes a screenshot into docs/reports/frontend-fork-<date>/ (FORK_REPORT_DIR overrides).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, type Address } from "viem";
import * as F from "./fork-helper";

const DATE = new Date().toISOString().slice(0, 10);
const OUT = resolve(process.env.FORK_REPORT_DIR || `../docs/reports/frontend-fork-${DATE}`);
mkdirSync(OUT, { recursive: true });

const USER = F.devAccount(20).address; // the dashboard's dev wallet (src/fork/dev-wallet.ts DEV_WALLET_INDEX)
const HELPERS = [30, 32];
const TSLA = F.dep.stocks.TSLA!.token;
const fresh = (): Address =>
  privateKeyToAccount(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).address;

let shot = 0;
async function snap(page: Page, name: string) {
  shot++;
  await page.screenshot({
    path: `${OUT}/${String(shot).padStart(2, "0")}-${name}.png`,
    fullPage: true,
  });
}

const log = (s: string) => console.log(`  [fork] ${s}`);

/** Waits for the dashboard to settle (no action running, no reload in flight). */
async function settled(page: Page) {
  await page.waitForFunction(
    () => !document.body.dataset.forkBusy && !document.body.dataset.forkLoading,
    null,
    { timeout: 15 * 60_000 },
  );
}

/** Clicks an action button and asserts the action's log line ends OK; returns the tx hashes it logged. */
async function act(
  page: Page,
  action: string,
  opts: { allowError?: RegExp } = {},
): Promise<string[]> {
  await settled(page);
  const before = await page.locator("#fork-log > li").count();
  await page.locator(`[data-action="${action}"]`).first().click();
  await settled(page);
  const entry = page.locator("#fork-log > li").first();
  const state = await entry.getAttribute("data-state");
  const text = await entry.innerText();
  if (state !== "ok") {
    if (opts.allowError && opts.allowError.test(text)) return [];
    throw new Error(`${action} failed: ${text}`);
  }
  const added = (await page.locator("#fork-log > li").count()) - before;
  const hashes = await page.locator("#fork-log > li").evaluateAll(
    (els, n) =>
      els
        .slice(0, n)
        .map((e) => e.getAttribute("data-tx-hash"))
        .filter((h): h is string => !!h),
    added,
  );
  for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  log(`${action}: ${text.split("\n").join(" ")}${hashes.length ? ` [${hashes.length} tx]` : ""}`);
  return hashes;
}

async function tab(page: Page, name: "" | "activity" | "privacy" | "settings") {
  await page.locator(`.dashboard-nav a[href="/dashboard/${name ? `${name}/` : ""}"]`).click();
  await settled(page);
}

test("consumer flow on the local fork through the dashboard", async ({ page }) => {
  page.on("pageerror", (e) => console.log("  [page error]", e.message));
  await page.goto("/dashboard/");

  await test.step("connect the dev wallet", async () => {
    await expect(page.locator("[data-dev-wallet-badge]")).toHaveText(/DEV WALLET — local fork/i);
    await act(page, "connect-dev");
    await expect(page.locator("[data-fork-dashboard]")).toHaveAttribute("data-account", USER);
    await snap(page, "connected");
  });

  await test.step("eligibility self-attestation", async () => {
    await tab(page, "settings");
    const hashes = await act(page, "attest");
    expect(hashes.length).toBe(1);
    await expect(page.locator('[data-field="eligible"]')).toHaveText("eligible");
    await snap(page, "eligibility");
  });

  await test.step("deposit 300 USDG", async () => {
    await tab(page, "");
    await page.fill("#deposit-amount", "300");
    const hashes = await act(page, "deposit");
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-field="vault-available"]')).toHaveText("300");
    await snap(page, "deposit");
  });

  await test.step("settings: round to 10, x1, weekly cap 100", async () => {
    await tab(page, "settings");
    await page.selectOption("#round-to", "10");
    await page.selectOption("#multiplier", "1");
    await page.locator("#weekly-cap").fill("100");
    await act(page, "save-settings");
    await expect(page.locator("#round-to")).toHaveValue("10");
    await expect(page.locator("#cap-value")).toHaveText("100 USDG");
    await snap(page, "settings");
  });

  await test.step("buy mix: 100% TSLA", async () => {
    await page.fill("#mix-TSLA", "100");
    await act(page, "save-mix");
    await expect(page.locator("#mix-TSLA")).toHaveValue("100");
    await snap(page, "mix");
  });

  await test.step("round-up: statement import, keeper accrues, the user joins the crowd", async () => {
    await page.fill(
      "#statement-csv",
      `Date,Description,Amount\n${await F.chainDate()},Coffee roasters,-12.30\n`,
    );
    await act(page, "import-statement");
    // The keeper accrues 7.70 USDG (12.30 rounded up to 20) into pending, then joins it on its own sweep;
    // the dashboard's JOIN CROWD NOW does the same if it gets there first.
    const joinedBy = await F.until("accrued round-up (pending or joined)", async () => {
      const [, pending] = await F.vaultBalances(USER);
      if (pending > 0n) return "user";
      const [bookId] = await F.pub.readContract({
        address: F.dep.crowdBuy,
        abi: F.crowdAbi,
        functionName: "openBook",
        args: [TSLA],
      });
      return (await F.pub.readContract({
        address: F.dep.crowdBuy,
        abi: F.crowdAbi,
        functionName: "orderOf",
        args: [TSLA, bookId, USER],
      })) > 0n
        ? "keeper"
        : undefined;
    });
    await tab(page, "");
    const byUi =
      joinedBy === "user"
        ? (await act(page, "join", { allowError: /Nothing pending/ })).length > 0
        : false;
    const { order } = await F.waitOrder(TSLA, USER);
    expect(order).toBe(7_700_000n);
    log(
      `order 7.7 USDG in the TSLA book (joined by ${byUi ? "the dashboard's JOIN CROWD NOW" : "the keeper's sweep, which got there first"})`,
    );
    await page.reload();
    await settled(page);
    await snap(page, "joined-crowd");
  });

  await test.step("crowd: two more savers, keeper commits/reveals/executes the TSLA book", async () => {
    const date = await F.chainDate();
    for (const [n, i] of HELPERS.entries()) {
      await F.onboardSaver(i, "TSLA");
      await F.importSpend(i, `Helper lunch ${n}`, "4.10", date);
    }
    for (const i of HELPERS) await F.waitOrder(TSLA, F.devAccount(i).address);
    await F.executeRound(TSLA, log);
    await page.reload();
    await settled(page);
    await expect(page.locator('[data-action="claim-open"]')).toHaveText(/CLAIM 1 ALLOCATION/);
    await snap(page, "crowd-executed");
  });

  await test.step("claim the allocation (Open)", async () => {
    const before = await F.balanceOf(TSLA, USER);
    const hashes = await act(page, "claim-open");
    expect(hashes.length).toBe(1);
    expect(await F.balanceOf(TSLA, USER)).toBeGreaterThan(before);
    await expect(page.locator('[data-field="stocks"]')).not.toHaveText("$0.00");
    await snap(page, "claimed-open");
  });

  await test.step("switch to Quiet (meta-address registration + settings)", async () => {
    await tab(page, "privacy");
    await page.locator('[data-live-mode="quiet"]').first().click();
    await settled(page);
    const entry = page.locator("#fork-log > li").first();
    await expect(entry).toHaveAttribute("data-state", "ok");
    await expect(page.locator('[data-field="meta"]')).toHaveText("registered");
    await expect(page.locator('.mode-button.chosen[data-live-mode="quiet"]')).toHaveCount(1);
    await snap(page, "quiet-mode");
  });

  await test.step("second round as Quiet: keeper delivers to stealth addresses", async () => {
    await tab(page, "settings");
    await page.fill(
      "#statement-csv",
      `Date,Description,Amount\n${await F.chainDate()},Bakery,-3.40\n`,
    );
    await act(page, "import-statement");
    await F.waitOrder(TSLA, USER);
    const date = await F.chainDate();
    for (const [n, i] of HELPERS.entries())
      await F.importSpend(i, `Helper dinner ${n}`, "6.20", date);
    for (const i of HELPERS) await F.waitOrder(TSLA, F.devAccount(i).address);
    await F.executeRound(TSLA, log);
    await tab(page, "privacy");
    // The keeper settles the Quiet allocation into StealthClaims and releases the first part right away.
    await F.until(
      "a stealth part for the user",
      async () => {
        await act(page, "quiet-scan");
        const n = Number(await page.locator('[data-field="quiet-parts"]').innerText());
        return n > 0 ? n : undefined;
      },
      180_000,
      3_000,
    );
    await snap(page, "quiet-parts");
  });

  await test.step("Quiet claim through the relayer to a fresh address", async () => {
    const to = fresh();
    await page.fill("#quiet-to", to);
    const hashes = await act(page, "quiet-claim");
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    const got = await F.balanceOf(TSLA, to);
    expect(got).toBeGreaterThan(0n);
    expect(await F.pub.getBalance({ address: to })).toBe(0n);
    log(`fresh address holds ${got} raw TSLA; it never had gas`);
    await snap(page, "quiet-claimed");
  });

  await test.step("switch to Hidden (vault keys) and deposit 50 USDG into the Hidden Vault", async () => {
    await page.locator('[data-live-mode="hidden"]').first().click();
    await settled(page);
    await expect(page.locator("#fork-log > li").first()).toHaveAttribute("data-state", "ok");
    await expect(page.locator('[data-field="hidden-keys"]')).toHaveText("registered");
    // Chain time is ~2 days past the deploy by now (two crowd windows): the cap's 48 h timelock may still run.
    const pending = await F.until(
      "cap timelock",
      async () => {
        try {
          await F.applyHiddenUsdgCap(log);
          return true;
        } catch {
          await F.warp(6n * 3600n);
          return undefined;
        }
      },
      60_000,
      200,
    );
    expect(pending).toBe(true);
    await page.fill("#hidden-amount", "50");
    const hashes = await act(page, "hidden-deposit");
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    await F.insertHidden(log);
    await F.until(
      "the note in the tree",
      async () => {
        await act(page, "hidden-notes");
        const t = await page.locator('[data-field="notes"]').innerText();
        return Number(t) > 0 &&
          !(await page.locator('[data-field="notes-detail"]').innerText()).includes("pending")
          ? true
          : undefined;
      },
      120_000,
      3_000,
    );
    await snap(page, "hidden-deposit");
  });

  await test.step("Hidden withdraw (proof in the browser) to a fresh address", async () => {
    const to = fresh();
    await page.fill("#hidden-to", to);
    const hashes = await act(page, "hidden-withdraw");
    expect(hashes.length).toBe(1);
    expect(await F.balanceOf(F.dep.usdg, to)).toBe(50n * F.U);
    log("fresh address holds 50 USDG from the shielded note");
    await snap(page, "hidden-withdraw");
  });

  await test.step("statement view", async () => {
    await act(page, "statements");
    await expect(page.locator('[data-field="statements"]')).toBeVisible();
    await snap(page, "statements");
  });

  await test.step("activity", async () => {
    await tab(page, "activity");
    await expect(page.locator(".activity-table tbody tr").first()).toBeVisible();
    await snap(page, "activity");
  });

  await test.step("withdraw everything from the vault", async () => {
    await tab(page, "");
    const hashes = await act(page, "withdraw-all");
    expect(hashes.length).toBe(1);
    const [a, p] = await F.vaultBalances(USER);
    expect(a + p).toBe(0n);
    await expect(page.locator('[data-field="vault-available"]')).toHaveText("0");
    await snap(page, "withdraw-all");
  });
});
