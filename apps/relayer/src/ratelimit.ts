/** Sliding-window counter per key, in memory (one relayer process). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if it is within the limit. */
  take(key: string): boolean {
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (xs.length >= this.limit) {
      this.hits.set(key, xs);
      return false;
    }
    xs.push(t);
    this.hits.set(key, xs);
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, xs] of this.hits) if (!xs.some((x) => x > t - this.windowMs)) this.hits.delete(k);
  }
}
