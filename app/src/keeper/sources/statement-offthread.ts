// Statement parsing off the request thread (review v2, V2-M4 / PARSE-2). The parser is linear, but a 2 MB upload is
// still tens of milliseconds of CPU, and a future regression must cost one worker, not the whole API. Each parse
// runs in a Worker with a wall-clock timeout (a worker that runs past it is terminated, not left spinning), and the
// size cap is enforced before any worker is used.
//
// Review v3 (R3-SVC-1): the pool used to be one global counter of 2 slots that answered 503 at once. Fresh wallets on
// a few /64s kept both slots busy (a worker start alone took ~115 ms), so honest imports got 503. Now:
//   - each caller key (the route passes the client's /64 and the wallet) has its own slot: one parse at a time per
//     key, so one client can never hold more than one of the pool's workers;
//   - the pool has DEFAULT_MAX_CONCURRENT_PARSES workers, and a request that finds them all busy waits in line (up
//     to DEFAULT_PARSE_WAIT_MS) instead of being refused at once. Parses take milliseconds, so the line moves;
//   - finished workers are kept warm and reused, so a parse no longer pays a worker start.
import { MAX_STATEMENT_BYTES, StatementError, type ParsedStatement, type ParseOptions } from "./statement";

export const DEFAULT_PARSE_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_CONCURRENT_PARSES = 4;
export const DEFAULT_PARSE_WAIT_MS = 2_000;
/** Requests waiting for a worker; past it a request is refused (503) rather than queued without bound. */
export const DEFAULT_MAX_PARSE_QUEUE = 64;

export class ParseBusyError extends Error {}

/** keys: the caller's identities (client /64, wallet); each may have one parse running at a time. */
export type OffThreadOptions = { timeoutMs?: number | undefined; keys?: readonly string[] | undefined };
export type ParsePoolOptions = { max?: number; waitMs?: number; maxQueue?: number };

type Reply = { ok: true; parsed: ParsedStatement } | { ok: false; statementError: boolean; message: string };

export class ParsePool {
  private running = 0;
  private readonly idle: Worker[] = [];
  private readonly waiting: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly busyKeys = new Set<string>();
  readonly max: number;
  readonly waitMs: number;
  readonly maxQueue: number;

  constructor(o: ParsePoolOptions = {}) {
    this.max = o.max ?? DEFAULT_MAX_CONCURRENT_PARSES;
    this.waitMs = o.waitMs ?? DEFAULT_PARSE_WAIT_MS;
    this.maxQueue = o.maxQueue ?? DEFAULT_MAX_PARSE_QUEUE;
  }

  /** Workers parsing now, and requests waiting for one. */
  get stats() {
    return { running: this.running, waiting: this.waiting.length, idle: this.idle.length };
  }

  private async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    if (this.waitMs <= 0 || this.waiting.length >= this.maxQueue) throw new ParseBusyError("the server is busy parsing other statements; try again shortly");
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new ParseBusyError("the server is busy parsing other statements; try again shortly"));
        }, this.waitMs),
      };
      this.waiting.push(entry);
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // the slot passes straight to the next in line
    } else this.running--;
  }

  async parse(text: string, opts: ParseOptions = {}, o: OffThreadOptions = {}): Promise<ParsedStatement> {
    // Before any worker or slot is used: oversized input is refused with the same error the parser gives.
    if (text.length > MAX_STATEMENT_BYTES || Buffer.byteLength(text, "utf8") > MAX_STATEMENT_BYTES) throw new StatementError(`statement larger than ${MAX_STATEMENT_BYTES} bytes`);
    const keys = [...new Set(o.keys ?? [])];
    if (keys.some((k) => this.busyKeys.has(k))) throw new ParseBusyError("a statement from this wallet or address is already being parsed; wait for it to finish");
    for (const k of keys) this.busyKeys.add(k);
    try {
      await this.acquire();
      let worker = this.idle.pop() ?? newWorker();
      let reusable = false;
      try {
        const out = await new Promise<ParsedStatement>((resolve, reject) => {
          const timer = setTimeout(() => reject(new StatementError("statement took too long to parse")), o.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS);
          worker.onmessage = (ev: MessageEvent<Reply>) => {
            clearTimeout(timer);
            reusable = true; // it answered: it is idle again
            const m = ev.data;
            if (m.ok) resolve(m.parsed);
            else reject(m.statementError ? new StatementError(m.message) : new Error(m.message));
          };
          worker.onerror = (ev) => {
            clearTimeout(timer);
            reject(new Error(`statement parser failed: ${ev.message}`));
          };
          worker.postMessage({ text, opts });
        });
        return out;
      } finally {
        worker.onmessage = null;
        worker.onerror = null;
        // A worker that timed out or crashed may still be spinning: never reuse it.
        if (reusable && this.idle.length < this.max) this.idle.push(worker);
        else worker.terminate();
        worker = undefined as never;
        this.release();
      }
    } finally {
      for (const k of keys) this.busyKeys.delete(k);
    }
  }

  /** Terminates the warm workers (tests, shutdown). */
  close() {
    for (const w of this.idle.splice(0)) w.terminate();
  }
}

function newWorker(): Worker {
  const w = new Worker(new URL("./statement-worker.ts", import.meta.url).href);
  (w as Worker & { unref?: () => void }).unref?.(); // a warm idle worker never keeps the process alive (Bun)
  return w;
}

/** The API process's pool. */
export const defaultParsePool = new ParsePool();

/** Parses `text` in a worker of the default pool. */
export async function parseStatementOffThread(text: string, opts: ParseOptions = {}, o: OffThreadOptions = {}): Promise<ParsedStatement> {
  return defaultParsePool.parse(text, opts, o);
}
