// A deterministic in-memory chain behind a viem custom transport: lets tests control range errors,
// rate limits and reorgs without a node.
import { createPublicClient, custom, encodeAbiParameters, keccak256, numberToHex, toHex, type Address, type Hex, type PublicClient } from "viem";

export const PING_TOPIC = keccak256(toHex("Ping(uint256)"));
export const FAKE_ADDRESS: Address = "0x00000000000000000000000000000000000000a1";

export type FakeOptions = {
  head: number;
  /** Blocks that carry one Ping log. */
  logEvery?: number;
  /** eth_getLogs throws a range error when (to - from + 1) > maxRange. */
  maxRange?: number;
};

export class FakeChain {
  head: number;
  salt = new Map<number, string>(); // per-block fork salt; changing it = reorg
  maxRange: number;
  logEvery: number;
  rateLimitNext = 0; // next N eth_getLogs calls return HTTP 429
  calls: { method: string; params: any }[] = [];

  constructor(o: FakeOptions) {
    this.head = o.head;
    this.maxRange = o.maxRange ?? Number.MAX_SAFE_INTEGER;
    this.logEvery = o.logEvery ?? 7;
  }

  private saltOf(n: number) {
    return this.salt.get(n) ?? "a";
  }
  hash(n: number): Hex {
    return keccak256(toHex(`block:${n}:${this.saltOf(n)}`));
  }
  /** Replace every block >= n (new hashes, and logs move to different tx hashes). */
  reorgFrom(n: number, salt: string) {
    for (let i = n; i <= this.head; i++) this.salt.set(i, salt);
  }
  hasLog(n: number) {
    return n % this.logEvery === 0;
  }
  logsIn(from: number, to: number) {
    const out = [];
    for (let n = from; n <= Math.min(to, this.head); n++) {
      if (!this.hasLog(n)) continue;
      out.push({
        address: FAKE_ADDRESS,
        topics: [PING_TOPIC, encodeAbiParameters([{ type: "uint256" }], [BigInt(n)])],
        data: "0x",
        blockNumber: numberToHex(n),
        blockHash: this.hash(n),
        transactionHash: keccak256(toHex(`tx:${n}:${this.saltOf(n)}`)),
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      });
    }
    return out;
  }
  expectedLogs(upTo: number) {
    let c = 0;
    for (let n = 0; n <= upTo; n++) if (this.hasLog(n)) c++;
    return c;
  }

  async request({ method, params }: { method: string; params?: any }): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return numberToHex(this.head);
      case "eth_getBlockByNumber": {
        const n = Number(BigInt(params[0]));
        if (n > this.head) return null;
        return {
          number: numberToHex(n),
          hash: this.hash(n),
          parentHash: n === 0 ? `0x${"0".repeat(64)}` : this.hash(n - 1),
          timestamp: numberToHex(1_700_000_000 + n),
          transactions: [],
          uncles: [],
          logsBloom: `0x${"0".repeat(512)}`,
          gasLimit: "0x1",
          gasUsed: "0x0",
          miner: FAKE_ADDRESS,
          extraData: "0x",
          nonce: "0x0000000000000000",
          difficulty: "0x1",
          size: "0x1",
          stateRoot: this.hash(n),
          receiptsRoot: this.hash(n),
          transactionsRoot: this.hash(n),
          sha3Uncles: this.hash(n),
        };
      }
      case "eth_getLogs": {
        const f = params[0];
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        if (this.rateLimitNext > 0) {
          this.rateLimitNext--;
          throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        }
        if (to - from + 1 > this.maxRange) throw Object.assign(new Error("block range too large"), { code: -32602 });
        return this.logsIn(from, to);
      }
      default:
        throw new Error(`fake chain: unsupported ${method}`);
    }
  }

  client(): PublicClient {
    return createPublicClient({ transport: custom({ request: (a: any) => this.request(a) }, { retryCount: 0 }) }) as PublicClient;
  }
}
