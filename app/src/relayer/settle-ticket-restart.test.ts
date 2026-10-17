// Review v3, R3-SVC-3 (Info, open in v4): settle tickets were burnt in memory only and bin/relayer.ts derives the HMAC
// key deterministically from the relayer key, so after a restart (every deploy restarts plynth-relayer) each ticket of
// the last 7 days relayed one more fee-less settle. Burnt ids now live in a FileTicketStore (the unit's StateDirectory).
// PoC review3/settle-ticket-restart.test.ts, now asserting the safe side.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FileTicketStore, SettleTickets } from "@/relayer/economics";

const relayerKey = privateKeyToAccount(generatePrivateKey());
const keyOf = async () => createHash("sha256").update(await relayerKey.signMessage({ message: "plynth relayer settle tickets v1 chain 4663" })).digest();
const storeAt = () => new FileTicketStore(join(mkdtempSync(join(tmpdir(), "plynth-tickets-")), "settle-tickets-used"));

describe("R3-SVC-3: a used settle ticket stays used across a relayer restart", () => {
  test("one ticket, one settle: the restarted relayer (same derived key, same store) refuses it", async () => {
    const store = storeAt();
    const before = new SettleTickets(await keyOf(), undefined, undefined, store);
    const ticket = before.issue();
    expect(before.redeem(ticket)).toBeUndefined();
    expect(before.redeem(ticket)).toBe("settle ticket already used");
    const after = new SettleTickets(await keyOf(), undefined, undefined, new FileTicketStore(store.path)); // restart
    expect(after.redeem(ticket)).toBe("settle ticket already used");
    // a ticket that was never used still works after the restart
    expect(after.redeem(before.issue())).toBeUndefined();
  });

  test("a released ticket (its settle refused before sending) is good again after a restart, once", async () => {
    const store = storeAt();
    const a = new SettleTickets(await keyOf(), undefined, undefined, store);
    const ticket = a.issue();
    expect(a.redeem(ticket)).toBeUndefined();
    a.release(ticket);
    const b = new SettleTickets(await keyOf(), undefined, undefined, new FileTicketStore(store.path));
    expect(b.redeem(ticket)).toBeUndefined();
    expect(new SettleTickets(await keyOf(), undefined, undefined, new FileTicketStore(store.path)).redeem(ticket)).toBe("settle ticket already used");
  });

  test("expired ids are compacted out of the file when it is loaded", async () => {
    let now = 1_000_000;
    const store = storeAt();
    const a = new SettleTickets(await keyOf(), 60, () => now, store);
    for (let i = 0; i < 5; i++) expect(a.redeem(a.issue())).toBeUndefined();
    expect(readFileSync(store.path, "utf8").trim().split("\n")).toHaveLength(5);
    now += 120; // every ticket expired
    new SettleTickets(await keyOf(), 60, () => now, new FileTicketStore(store.path));
    expect(readFileSync(store.path, "utf8")).toBe("");
  });

  test("without a store (local) the old in-memory behaviour is unchanged", async () => {
    const a = new SettleTickets(await keyOf());
    const t = a.issue();
    expect(a.redeem(t)).toBeUndefined();
    expect(new SettleTickets(await keyOf()).redeem(t)).toBeUndefined();
  });
});
