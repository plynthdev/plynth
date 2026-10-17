// Worker entry for parseStatementOffThread: parses one statement off the API's event loop (review v2, V2-M4 /
// PARSE-2). One message in, one message out; the parent terminates the worker afterwards or on timeout.
import { parseStatement, StatementError, type ParseOptions } from "./statement";

declare const self: Worker;

self.onmessage = (ev: MessageEvent<{ text: string; opts: ParseOptions }>) => {
  try {
    self.postMessage({ ok: true, parsed: parseStatement(ev.data.text, ev.data.opts) });
  } catch (e) {
    self.postMessage({ ok: false, statementError: e instanceof StatementError, message: (e as Error)?.message ?? String(e) });
  }
};
