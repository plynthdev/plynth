// Review v3 (ofx-worst): 11 adversarial OFX / CSV shapes at the 2 MB cap must each parse (or be refused) in < 1 s and
// stay linear: twice the input may cost at most ~2x the time (< 3x allowed). A single timing flaked under heavy host
// load (load average 50): one run of the half-size input landed on a quiet moment and the full-size one on a busy one.
// So each size is timed in CPU time (see `ms`), several times, interleaved (full, half, full, half, ...), and the
// MEDIANS are compared. A quadratic shape still fails: at 2 MB it is >= 4x per doubling in every run, and its
// absolute time is seconds, not milliseconds (the old CURRENCY bomb took 145 s).
import { expect, test } from "bun:test";
import { MAX_STATEMENT_BYTES, parseStatement } from "./statement";

const H = "OFXHEADER:100\n<OFX>";
const fill = (prefix: string, unit: string, suffix = "", bytes = MAX_STATEMENT_BYTES - 300) => prefix + unit.repeat(Math.floor((bytes - prefix.length - suffix.length) / unit.length)) + suffix;
const shapes: Record<string, (b: number) => string> = {
  manyStmtrs: (b) => fill(H, "<STMTRS>", "", b),
  manyCcStmtrsNoClose: (b) => fill(H, "<CCSTMTRS>x", "", b),
  oneStmtrsManyStmttrnOpen: (b) => fill(H + "<STMTRS>", "<STMTTRN>", "", b),
  stmttrnNoCloseNoNl: (b) => fill(H + "<STMTRS><BANKTRANLIST>", "<STMTTRN><DTPOSTED>20261001<TRNAMT>-1.23", "", b),
  currencyNoCursym: (b) => fill(H + "<STMTRS><STMTTRN><DTPOSTED>20261001<TRNAMT>-1.23", "<CURRENCY>", "</STMTTRN>", b),
  cursymSpaces: (b) => fill(H + "<STMTRS><STMTTRN><CURRENCY><CURSYM>", " ", "</STMTTRN>", b),
  fieldNoValue: (b) => fill(H + "<STMTRS><STMTTRN>", "<FITI", "</STMTTRN>", b),
  ltStorm: (b) => fill(H + "<STMTRS><STMTTRN>", "<", "</STMTTRN>", b),
  csvOneHugeLine: (b) => fill("date,description,amount\n", '"a', "", b),
  csvManyCommas: (b) => fill("", ",", "", b),
  csvQuotesNl: (b) => fill('date,description,amount\n2026-10-01,"', "x\n", "", b),
};
/**
 * CPU milliseconds (user + system) of one parse, not wall time. Under a loaded host a longer run is preempted
 * disproportionately often (it spans more scheduler slices), which made a linear 2x input look like 4.5x in wall time
 * at load average ~200. CPU time is what an attacker can make the parser spend, and it is immune to that.
 */
const ms = (s: string) => {
  const t = process.cpuUsage();
  try {
    parseStatement(s);
  } catch {
    // a refusal is fine: the time is what is measured
  }
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const RUNS = 5;
/** Below this the timer and GC noise dominate: a ratio of two tiny numbers proves nothing either way. */
const RATIO_FLOOR_MS = 20;

test("adversarial statement shapes stay linear and fast at 2 MB (medians of interleaved runs)", () => {
  const out: Record<string, { full: number; half: number }> = {};
  for (const [k, f] of Object.entries(shapes)) {
    const full = f(MAX_STATEMENT_BYTES - 300);
    const half = f((MAX_STATEMENT_BYTES - 300) / 2);
    ms(full); // warm up the JIT for this shape
    const tf: number[] = [];
    const th: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      tf.push(ms(full));
      th.push(ms(half));
    }
    out[k] = { full: Math.round(median(tf)), half: Math.round(median(th)) };
  }
  for (const [k, { full, half }] of Object.entries(out)) {
    expect(full, `${k}: ${JSON.stringify(out[k])}`).toBeLessThan(1000);
    if (half >= RATIO_FLOOR_MS) expect(full / half, `${k}: ${JSON.stringify(out[k])}`).toBeLessThan(3);
  }
}, 600_000);
