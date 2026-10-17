// Statement import (free): bank CSV exports and OFX/QFX files, parsed into SpendEvents. Pure functions; the
// API's POST /roundups/import stores the result and the keeper's `spends` job accrues it.
//
// Rules:
//  S1 layouts are detected from the header row (preamble lines before it, e.g. a summary block, are ignored).
//  S2 debit sign: a single Amount column is a spend when negative (bank style) unless the layout or the caller
//     says spends are positive (card style); separate Debit/Credit columns: Debit is the spend.
//  S3 credits, zero amounts, unreadable dates/amounts and non-USD rows are skipped with a reason.
//  S4 dedupe key = sha256(normalised row + occurrence number in the file): re-importing the same or an
//     overlapping statement adds nothing, while two identical purchases on one day still count twice.
//  S5 OFX: TRNAMT < 0 is money out (same for bank and card statements); FITID is the row identity when present.
import { sha256Hex, type SpendEvent } from "./types";

export const MAX_STATEMENT_BYTES = 2_000_000;
export const MAX_STATEMENT_ROWS = 20_000;

export type DebitSign = "negative" | "positive";
export type ParsedRow = { line: number; rowHash: string; event?: SpendEvent; skip?: string };
export type ParsedStatement = { format: "csv" | "ofx"; layout: string; rows: ParsedRow[] };
export type ParseOptions = { format?: "csv" | "ofx" | undefined; debitSign?: DebitSign | undefined; layout?: string | undefined };

export class StatementError extends Error {}

// ---------------------------------------------------------------- shared

/** "$1,234.56", "(12.34)", "-12.34", "12.34-", "+5" -> signed cents. More than 2 decimals or junk -> null. */
export function parseCents(raw: string): bigint | null {
  let s = raw.trim().replace(/[$\s,]/g, "").replace(/^USD/i, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "0").padEnd(2, "0"));
  return neg ? -cents : cents;
}

/** MM/DD/YYYY, M/D/YY, YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD -> UTC midnight. Invalid calendar dates -> null. */
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    mo = +m[1]!;
    d = +m[2]!;
    y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
  } else if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)) || (m = s.match(/^(\d{4})(\d{2})(\d{2})/))) {
    y = +m[1]!;
    mo = +m[2]!;
    d = +m[3]!;
  } else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t;
}

const merchantOf = (s: string | undefined) => {
  const v = (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return v || undefined;
};

/** Hash of a normalised row plus how many identical rows came before it in this file (S4). */
function hasher() {
  const seen = new Map<string, number>();
  return (normalised: string) => {
    const n = seen.get(normalised) ?? 0;
    seen.set(normalised, n + 1);
    return sha256Hex(`${normalised}\n#${n}`);
  };
}

// ---------------------------------------------------------------- CSV

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, BOM. Returns rows with their 1-based line numbers. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  const s = text.replace(/^﻿/, "");
  let cells: string[] = [];
  let cell = "";
  let q = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      cells.push(cell);
      out.push({ line: rowLine, cells });
      cells = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += c;
  }
  if (q) throw new StatementError("unterminated quoted field");
  if (cell !== "" || cells.length) {
    cells.push(cell);
    out.push({ line: rowLine, cells });
  }
  return out;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

type Layout = {
  name: string;
  date: string[];
  desc: string[];
  amount?: string[];
  debit?: string[];
  credit?: string[];
  /** Columns that must be present (normalised) for this layout to match. */
  needs: string[];
  debitSign: DebitSign;
};

/** Ordered: the first layout whose required columns are all present wins. */
export const CSV_LAYOUTS: Layout[] = [
  // Chase card/checking export: Transaction Date, Post Date, Description, Category, Type, Amount, Memo. Spends negative.
  { name: "chase", needs: ["transactiondate", "postdate", "description", "type", "amount"], date: ["transactiondate"], desc: ["description"], amount: ["amount"], debitSign: "negative" },
  // Capital One card export: Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit.
  { name: "capitalone", needs: ["transactiondate", "posteddate", "cardno", "description", "debit", "credit"], date: ["transactiondate"], desc: ["description"], debit: ["debit"], credit: ["credit"], debitSign: "positive" },
  // Bank of America checking export: a summary preamble, then Date, Description, Amount, Running Bal. Spends negative.
  { name: "bankofamerica", needs: ["date", "description", "amount", "runningbal"], date: ["date"], desc: ["description"], amount: ["amount"], debitSign: "negative" },
  // Anything else with a date, a description and either Amount or Debit/Credit.
  { name: "generic-debitcredit", needs: [], date: ["date", "transactiondate", "postingdate", "posteddate", "postdate"], desc: ["description", "payee", "merchant", "name", "details", "memo"], debit: ["debit", "withdrawal", "withdrawals", "debitamount"], credit: ["credit", "deposit", "deposits", "creditamount"], debitSign: "positive" },
  { name: "generic", needs: [], date: ["date", "transactiondate", "postingdate", "posteddate", "postdate"], desc: ["description", "payee", "merchant", "name", "details", "memo"], amount: ["amount", "transactionamount"], debitSign: "negative" },
];

const CURRENCY_COLS = ["currency", "currencycode", "ccy"];

function indexOf(headers: string[], names: string[] | undefined): number {
  if (!names) return -1;
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function matchLayout(headers: string[], only?: string): Layout | undefined {
  for (const l of CSV_LAYOUTS) {
    if (only && l.name !== only) continue;
    if (!l.needs.every((n) => headers.includes(n))) continue;
    if (indexOf(headers, l.date) < 0 || indexOf(headers, l.desc) < 0) continue;
    if (l.amount && indexOf(headers, l.amount) < 0) continue;
    if (l.debit && (indexOf(headers, l.debit) < 0 || indexOf(headers, l.credit) < 0)) continue;
    return l;
  }
  return undefined;
}

export function parseCsvStatement(text: string, opts: ParseOptions = {}): ParsedStatement {
  const rows = parseCsv(text);
  let hi = -1;
  let layout: Layout | undefined;
  for (let i = 0; i < Math.min(rows.length, 40) && !layout; i++) {
    layout = matchLayout(rows[i]!.cells.map(norm), opts.layout);
    if (layout) hi = i;
  }
  if (!layout) throw new StatementError("no recognised header row (need date, description and amount or debit/credit columns)");
  const headers = rows[hi]!.cells.map(norm);
  const col = {
    date: indexOf(headers, layout.date),
    desc: indexOf(headers, layout.desc),
    amount: indexOf(headers, layout.amount),
    debit: indexOf(headers, layout.debit),
    credit: indexOf(headers, layout.credit),
    currency: indexOf(headers, CURRENCY_COLS),
  };
  const sign: DebitSign = opts.debitSign ?? layout.debitSign;
  const hash = hasher();
  const out: ParsedRow[] = [];
  for (const { line, cells } of rows.slice(hi + 1)) {
    if (cells.every((c) => c.trim() === "")) continue;
    if (out.length >= MAX_STATEMENT_ROWS) throw new StatementError(`more than ${MAX_STATEMENT_ROWS} rows`);
    const rowHash = hash(cells.map((c) => c.trim()).join("\u001f"));
    const row: ParsedRow = { line, rowHash };
    out.push(row);
    const at = parseDate(cells[col.date] ?? "");
    if (!at) {
      row.skip = "unreadable date";
      continue;
    }
    const currency = col.currency >= 0 ? (cells[col.currency] ?? "").trim().toUpperCase() || "USD" : "USD";
    if (currency !== "USD") {
      row.skip = `currency ${currency} is not USD`;
      continue;
    }
    let spend: bigint;
    if (col.amount >= 0) {
      if (!(cells[col.amount] ?? "").trim()) {
        row.skip = "no amount";
        continue;
      }
      const a = parseCents(cells[col.amount] ?? "");
      if (a === null) {
        row.skip = "unreadable amount";
        continue;
      }
      spend = sign === "negative" ? -a : a;
    } else {
      const dRaw = (cells[col.debit] ?? "").trim();
      const cRaw = (cells[col.credit] ?? "").trim();
      const d = dRaw ? parseCents(dRaw) : 0n;
      const c = cRaw ? parseCents(cRaw) : 0n;
      if (d === null || c === null) {
        row.skip = "unreadable amount";
        continue;
      }
      // Some exports write debits negative in the Debit column: the column, not the sign, says it is a spend.
      spend = d !== 0n ? (d < 0n ? -d : d) : c !== 0n ? -(c < 0n ? -c : c) : 0n;
    }
    if (spend === 0n) {
      row.skip = "zero amount";
      continue;
    }
    if (spend < 0n) {
      row.skip = "credit, not a spend";
      continue;
    }
    row.event = { id: rowHash, amountCents: spend, currency, at, merchant: merchantOf(cells[col.desc]) };
  }
  return { format: "csv", layout: layout.amount && opts.debitSign && opts.debitSign !== layout.debitSign ? `${layout.name}/${sign}` : layout.name, rows: out };
}

// ---------------------------------------------------------------- OFX / QFX

/** Leaf value of <TAG> inside an OFX block: works for SGML (no close tag) and XML. */
function ofxField(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  const v = m?.[1]?.trim();
  return v ? v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : undefined;
}

/**
 * The CURSYM of a transaction's <CURRENCY> aggregate: the first <CURSYM> (followed by a 3-letter code) after the first
 * <CURRENCY>. Two forward scans, so linear in the block. The regex this replaces, /<CURRENCY>[\s\S]*?<CURSYM>/, was
 * quadratic: a block of repeated <CURRENCY> with no <CURSYM> took 145 s at 2 MB (review v2, V2-M4).
 */
export function currencyOf(block: string): string | undefined {
  const open = /<CURRENCY>/i.exec(block);
  if (!open) return undefined;
  const sym = /<CURSYM>\s*([A-Za-z]{3})/gi;
  sym.lastIndex = open.index + open[0].length;
  return sym.exec(block)?.[1];
}

export function looksLikeOfx(text: string): boolean {
  return /OFXHEADER|<OFX>/i.test(text.slice(0, 4096));
}

export function parseOfxStatement(text: string): ParsedStatement {
  if (!looksLikeOfx(text)) throw new StatementError("not an OFX/QFX file");
  const hash = hasher();
  const out: ParsedRow[] = [];
  // Line numbers are counted incrementally: re-splitting the text up to every row made a 20,000-row file take ~50 s
  // of API CPU (quadratic; audit M-9). Every match below advances monotonically, so this stays linear.
  // nextNl caches the first newline at or after seenTo (-1: none left), so a file with no newlines is not rescanned
  // to EOF once per row (review v2, V2-M4).
  let seenTo = 0;
  let seenLines = 1;
  let nextNl = text.indexOf("\n");
  const lineAt = (i: number) => {
    if (i < seenTo) {
      seenTo = 0;
      seenLines = 1;
      nextNl = text.indexOf("\n");
    }
    while (nextNl !== -1 && nextNl < i) {
      seenLines++;
      nextNl = text.indexOf("\n", nextNl + 1);
    }
    seenTo = i;
    return seenLines;
  };
  // One statement per <STMTRS> (bank) or <CCSTMTRS> (card); each has its CURDEF and account id.
  // base: where the statement's body starts in the file (after the opening tag), for line numbers.
  const stmts = [...text.matchAll(/<(CC)?STMTRS>([\s\S]*?)(<\/(CC)?STMTRS>|(?=<(CC)?STMTRS>)|$)/gi)].map((m) => ({ st: m[2]!, base: m.index + (m[1] ? 10 : 8) }));
  if (!stmts.length) throw new StatementError("OFX file has no statement (STMTRS/CCSTMTRS)");
  for (const { st, base } of stmts) {
    const curdef = (ofxField(st, "CURDEF") ?? "USD").toUpperCase();
    const acct = ofxField(st, "ACCTID") ?? "";
    for (const m of st.matchAll(/<STMTTRN>([\s\S]*?)(<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)) {
      if (out.length >= MAX_STATEMENT_ROWS) throw new StatementError(`more than ${MAX_STATEMENT_ROWS} rows`);
      const b = m[1]!;
      const line = lineAt(base + (m.index ?? 0));
      const fitid = ofxField(b, "FITID");
      const dt = ofxField(b, "DTPOSTED") ?? ofxField(b, "DTUSER") ?? "";
      const amt = ofxField(b, "TRNAMT") ?? "";
      const name = ofxField(b, "NAME") ?? ofxField(b, "PAYEE");
      const memo = ofxField(b, "MEMO");
      const rowHash = hash(fitid ? `ofx\u001f${acct}\u001f${fitid}` : `ofx\u001f${acct}\u001f${dt}\u001f${amt}\u001f${name ?? ""}\u001f${memo ?? ""}`);
      const row: ParsedRow = { line, rowHash };
      out.push(row);
      const at = parseDate(dt.slice(0, 8));
      if (!at) {
        row.skip = "unreadable date";
        continue;
      }
      // <CURRENCY><CURSYM>: TRNAMT is in that currency. <ORIGCURRENCY>: TRNAMT was already converted to CURDEF.
      const cur = (currencyOf(b) ?? curdef).toUpperCase();
      if (cur !== "USD") {
        row.skip = `currency ${cur} is not USD`;
        continue;
      }
      const a = parseCents(amt);
      if (a === null) {
        row.skip = "unreadable amount";
        continue;
      }
      if (a === 0n) {
        row.skip = "zero amount";
        continue;
      }
      if (a > 0n) {
        row.skip = "credit, not a spend";
        continue;
      }
      row.event = { id: rowHash, amountCents: -a, currency: "USD", at, merchant: merchantOf(name ?? memo) };
    }
  }
  return { format: "ofx", layout: "ofx", rows: out };
}

/** Auto-detects OFX/QFX vs CSV unless opts.format says which. */
export function parseStatement(text: string, opts: ParseOptions = {}): ParsedStatement {
  if (new TextEncoder().encode(text).length > MAX_STATEMENT_BYTES) throw new StatementError(`statement larger than ${MAX_STATEMENT_BYTES} bytes`);
  const fmt = opts.format ?? (looksLikeOfx(text) ? "ofx" : "csv");
  return fmt === "ofx" ? parseOfxStatement(text) : parseCsvStatement(text, opts);
}
