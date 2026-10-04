// Optional live test against Plaid's free Sandbox. Skips unless PLAID_CLIENT_ID and PLAID_SECRET (sandbox
// keys) are set. Creates a sandbox item, exchanges the token, syncs transactions through the same adapter
// the keeper uses, and removes the item.
import { describe, expect, test } from "bun:test";
import { PlaidApi } from "plaid";
import { plaidFromEnv, syncItem } from "./";

const live = !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET && (process.env.PLAID_ENV ?? "sandbox") === "sandbox";

describe.skipIf(!live)("Plaid Sandbox (live)", () => {
  test("public token -> access token -> /transactions/sync yields USD spends", async () => {
    const cfg = plaidFromEnv(process.env)!;
    const api = cfg.api as PlaidApi;
    const { data: pt } = await api.sandboxPublicTokenCreate({ institution_id: "ins_109508", initial_products: ["transactions" as any] });
    const { data: ex } = await api.itemPublicTokenExchange({ public_token: pt.public_token });
    try {
      // Sandbox items need a moment before the first sync returns history.
      let r = await syncItem(api, ex.access_token, undefined);
      for (let i = 0; i < 15 && r.upserts.length === 0; i++) {
        await Bun.sleep(2_000);
        r = await syncItem(api, ex.access_token, undefined);
      }
      expect(r.cursor).toBeTruthy();
      expect(r.upserts.length).toBeGreaterThan(0);
      for (const u of r.upserts) {
        expect(u.event.currency).toBe("USD");
        expect(u.event.amountCents > 0n).toBe(true);
      }
    } finally {
      await api.itemRemove({ access_token: ex.access_token });
    }
  }, 60_000);
});
