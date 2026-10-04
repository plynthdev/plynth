/** Errors worth waiting on (rate limit / server trouble) vs errors that mean "ask for less". */
export function httpStatusOf(err: unknown): number | undefined {
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (typeof e.status === "number") return e.status;
  }
  return undefined;
}

const RATE_LIMIT_CODES = new Set([429, -32005, -32029]);

export function isBackoffError(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (typeof e.status === "number" && (e.status === 429 || e.status >= 500)) return true;
    if (typeof e.code === "number" && RATE_LIMIT_CODES.has(e.code)) return true;
    if (e.name === "TimeoutError") return true;
  }
  return false;
}

export type BackoffOptions = { baseMs: number; maxMs: number; random?: () => number };

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^attempt)]. */
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor((opts.random ?? Math.random)() * cap);
}

export type RetryOptions = BackoffOptions & {
  maxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry fn on backoff-worthy errors only; anything else is thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const should = opts.shouldRetry ?? isBackoffError;
  const nap = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!should(err) || attempt + 1 >= opts.maxAttempts) throw err;
      await nap(backoffDelay(attempt, opts));
    }
  }
}
