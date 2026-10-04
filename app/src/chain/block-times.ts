import type { PublicClient } from "viem";

/** Block number -> timestamp, cached (blocks are immutable once confirmed; reorged blocks are rare and only shift a label). */
export class BlockTimes {
  private cache = new Map<string, bigint>();
  constructor(
    private pub: Pick<PublicClient, "getBlock">,
    private max = 50_000,
  ) {}

  async get(blocks: bigint[]): Promise<Map<bigint, bigint>> {
    const out = new Map<bigint, bigint>();
    const missing = [...new Set(blocks)].filter((b) => {
      const hit = this.cache.get(b.toString());
      if (hit !== undefined) out.set(b, hit);
      return hit === undefined;
    });
    for (let i = 0; i < missing.length; i += 20) {
      const part = missing.slice(i, i + 20);
      const got = await Promise.all(part.map((n) => this.pub.getBlock({ blockNumber: n })));
      got.forEach((blk, j) => {
        if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(part[j]!.toString(), blk.timestamp);
        out.set(part[j]!, blk.timestamp);
      });
    }
    return out;
  }
}
