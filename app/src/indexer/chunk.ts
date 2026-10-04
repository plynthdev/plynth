/** getLogs range sizing: halve on RPC error, double after a run of successes, always within [min, max]. */
export type ChunkOptions = { initial: number; min: number; max: number; successesToGrow: number };
export const DEFAULT_CHUNK: ChunkOptions = { initial: 5_000, min: 50, max: 50_000, successesToGrow: 5 };

export class ChunkSizer {
  private size: number;
  private streak = 0;
  readonly opts: ChunkOptions;

  constructor(opts: Partial<ChunkOptions> = {}) {
    this.opts = { ...DEFAULT_CHUNK, ...opts };
    const { min, max, initial, successesToGrow } = this.opts;
    if (!(min >= 1 && min <= max) || successesToGrow < 1) throw new Error("bad chunk options");
    this.size = clamp(Math.floor(initial), min, max);
  }

  get current(): number {
    return this.size;
  }

  /** The range-too-large style error: halve. Returns false if already at min (caller decides to give up). */
  fail(): boolean {
    this.streak = 0;
    if (this.size <= this.opts.min) return false;
    this.size = Math.max(this.opts.min, Math.floor(this.size / 2));
    return true;
  }

  success(): void {
    this.streak++;
    if (this.streak >= this.opts.successesToGrow) {
      this.streak = 0;
      this.size = Math.min(this.opts.max, this.size * 2);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
