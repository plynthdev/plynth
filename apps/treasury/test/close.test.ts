// Unit tests for the close bundle (canonical JSON, hashes), the CFO pack's verification (refuses any bundle
// that does not match the on-chain event) and the renderers.
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";
import { BUNDLE_SCHEMA, bundleHashOf, bundlePositionsHash, canonicalJson, positionsHashOf, type Bundle } from "../close/bundle";
import { toCsv, toHtml, toJson } from "../cfo-pack/render";
import { CfoPackRefused, verifyBundle, type ClosedEvent } from "../cfo-pack/verify";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const PC = "0x3333333333333333333333333333333333333333" as Address;

function sample(): Bundle {
  const positions = [
    { asset: A.toLowerCase(), symbol: "USDG", kind: 0, band: 0, decimals: 6, raw: "600000000000", price: (10n ** 18n).toString(), multiplier: (10n ** 18n).toString(), roundId: "0", usd: (600_000n * 10n ** 18n).toString(), weightBps: 6000 },
    { asset: B.toLowerCase(), symbol: "AAPL", kind: 2, band: 1, decimals: 18, raw: (2000n * 10n ** 18n).toString(), price: (200n * 10n ** 18n).toString(), multiplier: "1000500000000000000", roundId: "7", usd: (400_000n * 10n ** 18n).toString(), weightBps: 4000 },
  ];
  const b: Bundle = {
    schema: BUNDLE_SCHEMA,
    chainId: 31337,
    periodClose: PC.toLowerCase(),
    account: "0x4444444444444444444444444444444444444444",
    closeIndex: 0,
    periodStart: 1_800_000_000,
    periodEnd: 1_802_592_000,
    navUsd: (1_000_000n * 10n ** 18n).toString(),
    cashBps: 6000,
    equityBps: 4000,
    positionsHash: "0x",
    policy: { hash: keccak256(toBytes("policy")), version: 1 },
    positions,
    deskActions: [{ id: 1, desk: "cash", action: "deposit", status: "rejected", reasonCode: 6, reason: "R4_BAND", asset: null, amount: "1", notionalUsd: null, txHash: null, at: "2026-10-04T00:00:00.000Z" }],
    guardDenials: [],
    deskActionRange: { afterId: 0, toId: 1 },
    fee: { bps: 25, recipient: "0x5555555555555555555555555555555555555555" },
    preview: { block: "10", timestamp: 1_802_592_100 },
  };
  b.guardDenials = b.deskActions;
  b.positionsHash = bundlePositionsHash(b);
  return b;
}

function eventFor(b: Bundle, json = canonicalJson(b)): ClosedEvent {
  return {
    chainId: 31337,
    periodClose: PC,
    index: 0,
    close: {
      periodEnd: BigInt(b.periodEnd),
      navUsd: BigInt(b.navUsd),
      cashBps: b.cashBps,
      equityBps: b.equityBps,
      positionsHash: b.positionsHash as Hex,
      bundleHash: bundleHashOf(json),
      policyHash: b.policy.hash as Hex,
      policyVersion: b.policy.version,
    },
    feeRaw: 205_479452n,
    feePaid: 205_479452n,
    feeOwed: 0n,
    txHash: keccak256(toBytes("tx")),
    blockNumber: 11n,
  };
}

describe("close bundle", () => {
  test("canonical JSON sorts keys at every level, drops undefined, stringifies bigints", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [{ z: 1, y: undefined, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"z":1}],"d":"2"},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("bundleHash is keccak256 of the exact JSON bytes", () => {
    const j = canonicalJson(sample());
    expect(bundleHashOf(j)).toBe(keccak256(toBytes(j)));
    expect(bundleHashOf(j + " ")).not.toBe(bundleHashOf(j));
  });

  test("positionsHash = keccak256(abi.encode(Position[])) sorted by address, like PeriodClose", () => {
    const p = [
      { asset: B, raw: 2n, price: 3n, multiplier: 4n, roundId: 5n },
      { asset: A, raw: 6n, price: 7n, multiplier: 8n, roundId: 9n },
    ];
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }],
        [[[A, 6n, 7n, 8n, 9n], [B, 2n, 3n, 4n, 5n]] as never],
      ),
    );
    expect(positionsHashOf(p)).toBe(manual);
    expect(positionsHashOf([...p].reverse())).toBe(manual);
  });
});

describe("cfo-pack verification", () => {
  test("a bundle that hashes to the event's bundleHash and agrees with it is accepted", () => {
    const b = sample();
    const json = canonicalJson(b);
    expect(verifyBundle(eventFor(b), json)).toEqual(JSON.parse(json));
  });

  test("tampered bundle (one byte) -> refuses", () => {
    const b = sample();
    const json = canonicalJson(b);
    const tampered = json.replace('"raw":"600000000000"', '"raw":"900000000000"');
    expect(tampered).not.toBe(json);
    expect(() => verifyBundle(eventFor(b), tampered)).toThrow(CfoPackRefused);
    expect(() => verifyBundle(eventFor(b), tampered)).toThrow(/bundle hash/);
  });

  test("a self-consistent bundle that disagrees with the event's NAV -> refuses", () => {
    const b = sample();
    const ev = eventFor(b);
    const lie = { ...b, navUsd: (2_000_000n * 10n ** 18n).toString() };
    const lieJson = canonicalJson(lie);
    expect(() => verifyBundle({ ...ev, close: { ...ev.close, bundleHash: bundleHashOf(lieJson) } }, lieJson)).toThrow(/navUsd/);
  });

  test("positions edited but positionsHash field kept -> refuses on the recomputed hash", () => {
    const b = sample();
    const ev = eventFor(b);
    const edited = { ...b, positions: b.positions.map((p, i) => (i === 1 ? { ...p, raw: "1" } : p)) };
    const j = canonicalJson(edited);
    expect(() => verifyBundle({ ...ev, close: { ...ev.close, bundleHash: bundleHashOf(j) } }, j)).toThrow(/recomputed/);
  });

  test("wrong policy, weights, period end, chain or contract -> refuses", () => {
    const b = sample();
    const base = eventFor(b);
    const j = canonicalJson(b);
    expect(() => verifyBundle({ ...base, close: { ...base.close, policyVersion: 2 } }, j)).toThrow(/policy/);
    expect(() => verifyBundle({ ...base, close: { ...base.close, cashBps: 5999 } }, j)).toThrow(/weights/);
    expect(() => verifyBundle({ ...base, close: { ...base.close, periodEnd: 1n } }, j)).toThrow(/periodEnd/);
    expect(() => verifyBundle({ ...base, chainId: 4663 }, j)).toThrow(/chainId/);
    expect(() => verifyBundle({ ...base, periodClose: A }, j)).toThrow(/periodClose/);
    expect(() => verifyBundle({ ...base, index: 3 }, j)).toThrow(/closeIndex/);
  });
});

describe("cfo-pack render", () => {
  const b = sample();
  const s = { event: eventFor(b), bundle: b };

  test("JSON carries the on-chain figures", () => {
    const j = toJson(s);
    expect(j.statement.navUsd).toBe(b.navUsd);
    expect(j.statement.bundleHash).toBe(s.event.close.bundleHash);
    expect(j.positions).toHaveLength(2);
    expect(j.guardDenials).toHaveLength(1);
  });

  test("CSV: header + one row per position + totals", () => {
    const lines = toCsv(s).trim().split("\n");
    expect(lines[0]).toStartWith("asset,symbol,kind");
    expect(lines.filter((l) => l.startsWith("0x"))).toHaveLength(2);
    expect(lines).toContain(`nav_usd_1e18,${b.navUsd}`);
  });

  test("HTML is one self-contained page: no scripts, no external resources, escaped text", () => {
    const evil = { ...b, positions: b.positions.map((p, i) => (i === 0 ? { ...p, symbol: "<script>x</script>" } : p)) };
    const html = toHtml({ event: s.event, bundle: evil });
    expect(html).toStartWith("<!doctype html>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\b(src|href)=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("$1,000,000.00");
    expect(html).toContain("R4_BAND");
  });
});
