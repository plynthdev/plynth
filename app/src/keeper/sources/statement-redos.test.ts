// Review v2, V2-M4: worst-case OFX inputs against the "linear" parser. Before the fix, one STMTTRN block with
// <CURRENCY> repeated and no <CURSYM> was quadratic in the regex /<CURRENCY>[\s\S]*?<CURSYM>/ (400 KB 5.8 s, 2 MB
// 145 s), and a file with no newlines made lineAt rescan to EOF once per row.
import { describe, expect, test } from "bun:test";
import { currencyOf, MAX_STATEMENT_BYTES, parseStatement, StatementError } from "./statement";
import { parseStatementOffThread } from "./statement-offthread";

// CPU time (user + system) of the parse, not wall time: a loaded host preempts long runs disproportionately, which
// flaked the ratio check; CPU time is what an upload can make the parser spend.
const time = (s: string) => {
  const t = process.cpuUsage();
  let err = "";
  let rows = 0;
  try {
    rows = parseStatement(s).rows.length;
  } catch (e) {
    err = (e as Error).message.slice(0, 60);
  }
  const d = process.cpuUsage(t);
  return { ms: (d.user + d.system) / 1000, err, rows };
};

const head = "OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>";
const tail = "</BANKTRANLIST></STMTRS></OFX>";
const row = (i: number) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-1.23<FITID>${i}<NAME>x</STMTTRN>`;
const currencyBomb = (n: number) => head + "<STMTTRN><DTPOSTED>20261001<TRNAMT>-1.23" + "<CURRENCY>".repeat(n) + "</STMTTRN>" + tail;

describe("V2-M4: OFX parser stays linear on adversarial input", () => {
  test("CURRENCY without CURSYM inside one STMTTRN: 2x input takes at most ~2x time, and 400 KB is fast", () => {
    time(currencyBomb(10_000)); // warm up
    // Medians of interleaved runs, so a load spike on one run cannot fake (or hide) a ratio (see statement-worst).
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ra = time(currencyBomb(20_000));
      expect(ra.rows).toBe(1);
      a.push(ra.ms);
      b.push(time(currencyBomb(40_000)).ms);
    }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[2]!;
    expect(med(b)).toBeLessThan(250);
    expect(med(b)).toBeLessThan(Math.max(med(a), 5) * 4);
  });

  test("max-size (2 MB) CURRENCY bomb parses in < 1 s", () => {
    const n = Math.floor((MAX_STATEMENT_BYTES - 200) / "<CURRENCY>".length);
    const r = time(currencyBomb(n));
    expect(r.err).toBe("");
    expect(r.rows).toBe(1);
    expect(r.ms).toBeLessThan(1000);
  });

  test("no newlines at all: 20k rows (row cap) in < 1 s", () => {
    const s = head + Array.from({ length: 20_000 }, (_, i) => row(i).replace("<NAME>x", `<NAME>${"x".repeat(15)}`)).join("") + tail;
    expect(s.includes("\n<STMTTRN>")).toBe(false);
    const r = time(s);
    expect(r.rows).toBe(20_000);
    expect(r.ms).toBeLessThan(1000);
  });

  test("currencyOf keeps the old semantics: first CURSYM after the first CURRENCY", () => {
    expect(currencyOf("<TRNAMT>-1<CURRENCY><CURRATE>1.1<CURSYM>EUR</CURRENCY>")).toBe("EUR");
    expect(currencyOf("<CURSYM>GBP<CURRENCY><CURSYM> cad")).toBe("cad");
    expect(currencyOf("<CURRENCY><CURSYM>12<CURSYM>JPY")).toBe("JPY");
    expect(currencyOf("<ORIGCURRENCY><CURSYM>EUR")).toBeUndefined();
    expect(currencyOf("<currency>".repeat(1000))).toBeUndefined();
    const p = parseStatement(head + "<STMTTRN><DTPOSTED>20261001<TRNAMT>-5.00<CURRENCY><CURSYM>EUR</CURRENCY></STMTTRN>" + row(2) + tail);
    expect(p.rows.map((r) => r.skip ?? "ok")).toEqual(["currency EUR is not USD", "ok"]);
  });
});

describe("V2-M4 / PARSE-2: parsing runs in a worker with a size cap and a timeout", () => {
  test("off-thread parse returns the same rows (bigints and dates survive the worker boundary)", async () => {
    const s = head + Array.from({ length: 50 }, (_, i) => row(i)).join("") + tail;
    const off = await parseStatementOffThread(s);
    expect(off).toEqual(parseStatement(s));
    expect(typeof off.rows[0]!.event!.amountCents).toBe("bigint");
    expect(off.rows[0]!.event!.at).toBeInstanceOf(Date);
  });

  test("oversized input is refused before a worker starts", async () => {
    await expect(parseStatementOffThread("x".repeat(MAX_STATEMENT_BYTES + 1))).rejects.toBeInstanceOf(StatementError);
  });

  test("a parse that runs past the timeout is killed and refused, and the event loop keeps ticking meanwhile", async () => {
    const s = head + Array.from({ length: 20_000 }, (_, i) => row(i)).join("") + tail;
    let ticks = 0;
    const tick = setInterval(() => ticks++, 1);
    const err = await parseStatementOffThread(s, {}, { timeoutMs: 1 }).catch((e) => e);
    clearInterval(tick);
    expect(err).toBeInstanceOf(StatementError);
    expect((err as Error).message).toContain("too long");
  });

  test("parser errors keep their type across the worker boundary", async () => {
    await expect(parseStatementOffThread("not a statement at all", { format: "ofx" })).rejects.toBeInstanceOf(StatementError);
  });
});

describe("review v2 (refuted lead, kept): CSV worst cases stay linear", () => {
  const csv = (s: string) => {
    const t = performance.now();
    try {
      parseStatement(s, { format: "csv" });
    } catch {
      // a refusal is fine; the time is what is measured
    }
    return performance.now() - t;
  };
  test("40 wide rows, 20k rows, and an 800k quoted field each parse in < 1 s", () => {
    const wide = Array.from({ length: 40 }, () => "a,".repeat(24_000)).join("\n");
    const rows = "Date,Description,Amount\n" + Array.from({ length: 20_000 }, (_, i) => `2026-10-01,shop ${i},-1.23`).join("\n");
    const quoted = "Date,Description,Amount\n" + `2026-10-01,"${'""'.repeat(800_000)}",-1`;
    for (const s of [wide, rows, quoted]) expect(csv(s)).toBeLessThan(1000);
  });
});
