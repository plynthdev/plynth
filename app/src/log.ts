// Service logs: one line per event, `[service] message`, on stdout (stderr for errors). Nothing here prints a key,
// a secret or a URL: errors go through safeErrorSummary, configuration through safeConfigSummary (config.ts).
import { configValue } from "@/config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type Level = keyof typeof LEVELS;

export type Logger = {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
};

/** JSON with bigints as decimal strings. */
export const stringifySafe = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** An error as {name, message} with URLs, hex keys and `secret=…` style values removed. */
export function safeErrorSummary(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : stringifySafe(error);
  const message = String(raw)
    .replace(/https?:\/\/[^\s)'"<>]+/gi, "[URL]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[HEX32]")
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return { name, message: message.slice(0, 1000) };
}

export function createLogger(service: string, level: Level = configValue("LOG_LEVEL")): Logger {
  const min = LEVELS[level];
  const line = (msg: string, extra?: unknown) => `[${service}] ${msg}${extra === undefined ? "" : ` ${stringifySafe(extra)}`}`;
  return {
    debug: (m, x) => void (min <= LEVELS.debug && console.log(line(m, x))),
    info: (m, x) => void (min <= LEVELS.info && console.log(line(m, x))),
    warn: (m, x) => void (min <= LEVELS.warn && console.error(line(m, x))),
    error: (m, x) => void (min <= LEVELS.error && console.error(line(m, x))),
  };
}
