// Statement parsing off the request thread (review v2, V2-M4 / PARSE-2). The parser is linear, but a 2 MB upload is
// still tens of milliseconds of CPU, and a future regression must cost one worker, not the whole API. Each parse
// runs in its own Worker with a wall-clock timeout (the worker is terminated, not left spinning), the size cap is
// enforced before the worker starts, and only a few parses run at once.
import { MAX_STATEMENT_BYTES, StatementError, type ParsedStatement, type ParseOptions } from "./statement";

export const DEFAULT_PARSE_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_CONCURRENT_PARSES = 2;

export class ParseBusyError extends Error {}

let running = 0;

export type OffThreadOptions = { timeoutMs?: number | undefined; maxConcurrent?: number | undefined };

export async function parseStatementOffThread(text: string, opts: ParseOptions = {}, o: OffThreadOptions = {}): Promise<ParsedStatement> {
  // Before a worker exists: oversized input is refused with the same error the parser gives.
  if (text.length > MAX_STATEMENT_BYTES || Buffer.byteLength(text, "utf8") > MAX_STATEMENT_BYTES) throw new StatementError(`statement larger than ${MAX_STATEMENT_BYTES} bytes`);
  const max = o.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PARSES;
  if (running >= max) throw new ParseBusyError("the server is busy parsing other statements; try again shortly");
  running++;
  const worker = new Worker(new URL("./statement-worker.ts", import.meta.url).href);
  try {
    return await new Promise<ParsedStatement>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StatementError("statement took too long to parse")), o.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS);
      worker.onmessage = (ev: MessageEvent<{ ok: true; parsed: ParsedStatement } | { ok: false; statementError: boolean; message: string }>) => {
        clearTimeout(timer);
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
  } finally {
    worker.terminate();
    running--;
  }
}
