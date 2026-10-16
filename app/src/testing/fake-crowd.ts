// A fake CrowdBuy book (asset, book 0) + StealthClaims behind the real Sender, shared by the deliver-quiet tests:
// it can fail a simulate, hold a transaction pending, lose a receipt, kill the process before a broadcast, reorg
// transactions out, and serve a different ERC-6538 meta-address per user.
import { generateKeys, metaAddressBytes } from "@plynth/sdk/stealth";
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  hexToString,
  keccak256,
  parseAbiItem,
  toHex,
  type AbiEvent,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { crowdAbi, errorsAbi } from "@/abi/keeper";
import type { SenderIO } from "@/keeper/sender";

export const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const KEEPER = A(0xaa);
export const CROWD = A(0xc0);
export const CLAIMS = A(0xc1);
export const VAULT = A(0xc2);
export const REGISTRY = A(0xc3);
export const SHIELDED = A(0xc4);
export const ASSET = A(0x7e);
export const VICTIM = A(0x11); // sorts first: delivered normally, owed parts from the pool
export const USER = A(0x22); // the user whose deliver does not land, then claims openly
export const META = metaAddressBytes(generateKeys(`0x${"ab".repeat(32)}${"cd".repeat(32)}1b` as Hex));

export const ev = {
  Delivered: parseAbiItem("event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)"),
  Claimed: parseAbiItem("event Claimed(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)"),
  Pooled: parseAbiItem("event Pooled(address indexed token, uint256 raw)"),
  Credited: parseAbiItem("event Credited(address indexed token, address indexed stealth, uint256 raw)"),
  Deposited: parseAbiItem("event Deposited(address indexed token, uint256 raw)"),
} as const;

export type Log = { address: Address; eventName: string; args: Record<string, unknown>; transactionHash: Hash; logIndex: number; blockNumber: bigint; blockHash: Hash; topics: Hex[]; data: Hex };
export const blockHash = (n: bigint) => keccak256(toHex(`block-${n}`));

export function revert(errorName: string, args: readonly unknown[] = []): never {
  throw new ContractFunctionRevertedError({ abi: errorsAbi as any, data: encodeErrorResult({ abi: errorsAbi as any, errorName, args } as any), functionName: "x" });
}

/** A CrowdBuy book (asset, book 0) + StealthClaims, as one keeper key and its users see them. */
export class FakeCrowd {
  head = 100n;
  nonce = 0;
  pool = new Map<number, { raw: Hex; hash: Hash; data: Hex }>();
  receipts = new Map<Hash, { status: "success" | "reverted"; blockNumber: bigint; logs: Log[] }>();
  signed: { hash: Hash; fn: string }[] = [];
  fee = 30n;
  autoMine = true;
  /** The node never returns a receipt for keeper transactions (lost): the job must find the logs. */
  loseReceipts = false;
  killNextBroadcast = false;
  simFail = new Map<string, string>(); // user -> error name the deliver simulate reverts with
  alloc = new Map<string, bigint>([[VICTIM.toLowerCase(), 600n], [USER.toLowerCase(), 400n]]);
  mode = new Map<string, number>();
  /** Per-user ERC-6538 meta-address (the registry stores any bytes); META when unset. */
  meta = new Map<string, Hex>();
  settledAt = new Map<string, bigint>();
  pooled = 0n;
  credits: { stealth: string; raw: bigint; block: bigint }[] = [];
  paidOpen = new Map<string, bigint>();
  logs: Log[] = [];
  /** Blocks the log node serving a by-hash query does not have (a load-balanced RPC behind on one backend). */
  unknownBlocks = new Set<Hash>();
  private txn = 0;

  emit(txHash: Hash, address: Address, event: AbiEvent, args: Record<string, unknown>, logIndex: number): Log {
    const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as any) as Hex[];
    const plain = event.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
    const l: Log = { address, eventName: event.name, args, transactionHash: txHash, logIndex, blockNumber: this.head, blockHash: blockHash(this.head), topics, data };
    this.logs.push(l);
    return l;
  }

  settled(user: Address, at = this.head) {
    const s = this.settledAt.get(user.toLowerCase());
    return s !== undefined && s <= at;
  }

  private settle(user: Address) {
    if (this.settled(user)) return false;
    this.settledAt.set(user.toLowerCase(), this.head);
    return true;
  }

  /** The user's ungated exit: their whole allocation to their wallet. */
  claimOpen(user: Address) {
    this.head++;
    const hash = keccak256(toHex(`claim-${this.txn++}`));
    if (!this.settle(user)) throw new Error("AlreadySettled");
    const raw = this.alloc.get(user.toLowerCase())!;
    this.paidOpen.set(user.toLowerCase(), (this.paidOpen.get(user.toLowerCase()) ?? 0n) + raw);
    this.emit(hash, ASSET, parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), { from: CROWD, to: user, value: raw }, 0);
    this.emit(hash, CROWD, ev.Claimed, { asset: ASSET, bookId: 0n, user, raw }, 1);
  }

  /** Another keeper path (Hidden) settles the user: Delivered, but nothing pooled into StealthClaims. */
  deliverHidden(user: Address) {
    this.head++;
    const hash = keccak256(toHex(`hidden-${this.txn++}`));
    this.settle(user);
    const raw = this.alloc.get(user.toLowerCase())!;
    this.emit(hash, SHIELDED, ev.Deposited, { token: ASSET, raw }, 1);
    this.emit(hash, CROWD, ev.Delivered, { asset: ASSET, bookId: 0n, user, raw }, 2);
  }

  /** What a mined keeper transaction does on CrowdBuy. */
  private apply(hash: Hash, data: Hex): { ok: boolean; logs: Log[] } {
    const { functionName, args } = decodeFunctionData({ abi: crowdAbi, data }) as { functionName: string; args: readonly any[] };
    if (functionName === "deliver") {
      const user = args[2] as Address;
      if (!this.settle(user)) return { ok: false, logs: [] }; // AlreadySettled
      const raw = this.alloc.get(user.toLowerCase())!;
      this.pooled += raw;
      return {
        ok: true,
        logs: [
          this.emit(hash, ASSET, parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), { from: CROWD, to: CLAIMS, value: raw }, 0),
          this.emit(hash, CLAIMS, ev.Pooled, { token: ASSET, raw }, 1),
          this.emit(hash, CROWD, ev.Delivered, { asset: ASSET, bookId: 0n, user, raw }, 2),
        ],
      };
    }
    if (functionName === "deliverStealth") {
      const raw = args[2] as bigint;
      if (this.pooled < raw) return { ok: false, logs: [] }; // PoolTooSmall
      this.pooled -= raw;
      this.credits.push({ stealth: String(args[1]).toLowerCase(), raw, block: this.head });
      return { ok: true, logs: [this.emit(hash, CLAIMS, ev.Credited, { token: ASSET, stealth: args[1], raw }, 0)] };
    }
    throw new Error(`unexpected ${functionName}`);
  }

  /**
   * A reorg deeper than the keeper's confirmations removes these mined transactions (a deliver and the credits of
   * its parts): their receipts and logs vanish and their effects are undone. The nonces stay used (other keeper
   * transactions took them on the new branch).
   */
  reorgOut(hashes: Hash[]) {
    for (const hash of hashes) {
      this.receipts.delete(hash);
      const gone = this.logs.filter((l) => l.transactionHash === hash);
      this.logs = this.logs.filter((l) => l.transactionHash !== hash);
      for (const l of gone) {
        if (l.eventName === "Delivered") {
          this.settledAt.delete(String(l.args.user).toLowerCase());
          this.pooled -= l.args.raw as bigint;
        }
        if (l.eventName === "Credited") {
          const i = this.credits.findIndex((c) => c.stealth === String(l.args.stealth).toLowerCase() && c.raw === l.args.raw);
          this.credits.splice(i, 1);
          this.pooled += l.args.raw as bigint;
        }
      }
    }
  }

  mine() {
    const tx = this.pool.get(this.nonce);
    if (!tx) return false;
    this.pool.delete(this.nonce);
    this.head++;
    this.nonce++;
    const r = this.apply(tx.hash, tx.data);
    this.receipts.set(tx.hash, { status: r.ok ? "success" : "reverted", blockNumber: this.head, logs: r.ok ? r.logs : [] });
    return true;
  }

  deliversSigned() {
    return this.signed.filter((s) => s.fn === "deliver").length;
  }
  creditedTotal() {
    return this.credits.reduce((a, c) => a + c.raw, 0n);
  }

  io(): SenderIO {
    return {
      estimateGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: this.fee++, maxPriorityFeePerGas: 2n }),
      getTransactionCount: async ({ blockTag }) => (blockTag === "pending" ? this.nonce + this.pool.size : this.nonce),
      signTransaction: async (tx) => {
        const raw = toHex(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        this.signed.push({ hash: keccak256(raw), fn: decodeFunctionData({ abi: crowdAbi, data: tx.data }).functionName });
        return raw;
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        if (this.killNextBroadcast) {
          this.killNextBroadcast = false;
          throw new Error("process killed before the broadcast left");
        }
        const hash = keccak256(serializedTransaction);
        const j = JSON.parse(hexToString(serializedTransaction)) as { nonce: number; data: Hex };
        if (this.receipts.has(hash) || [...this.pool.values()].some((t) => t.hash === hash)) throw new Error("already known");
        if (j.nonce < this.nonce) throw new Error(`nonce too low: next nonce ${this.nonce}`);
        if (this.pool.has(j.nonce)) throw new Error("replacement transaction underpriced");
        this.pool.set(j.nonce, { raw: serializedTransaction, hash, data: j.data });
        if (this.autoMine) while (this.mine());
        return hash;
      },
      getTransactionReceipt: async ({ hash }) => {
        const r = this.receipts.get(hash);
        if (!r || this.loseReceipts) return null;
        return { transactionHash: hash, status: r.status, blockNumber: r.blockNumber, logs: r.logs } as unknown as TransactionReceipt;
      },
    };
  }

  pub(): PublicClient {
    const match = (l: Log, args: Record<string, unknown> | undefined) =>
      Object.entries(args ?? {}).every(([k, v]) => (typeof v === "string" ? String(l.args[k]).toLowerCase() === v.toLowerCase() : l.args[k] === v));
    return {
      getBlockNumber: async () => this.head,
      getTransactionCount: async () => this.nonce,
      simulateContract: async ({ functionName, args }: { functionName: string; args: readonly any[] }) => {
        if (functionName === "deliver") {
          const f = this.simFail.get(String(args[2]).toLowerCase());
          if (f) revert(f);
          if (this.settled(args[2])) revert("AlreadySettled");
        }
        if (functionName === "deliverStealth" && this.pooled < (args[2] as bigint)) revert("PoolTooSmall", [this.pooled, args[2]]);
        return { result: undefined };
      },
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly any[]; blockNumber?: bigint }) => {
        if (blockNumber !== undefined && blockNumber > this.head) throw new Error(`header not found (block ${blockNumber})`);
        switch (functionName) {
          case "settled":
            return this.settled(args[2], blockNumber ?? this.head);
          case "orderOf":
            return 1n;
          case "allocationOf":
            return this.alloc.get(String(args[2]).toLowerCase())!;
          case "settingsOf":
            return { mode: this.mode.get(String(args[0]).toLowerCase()) ?? 1 };
          case "stealthMetaAddressOf":
            return this.meta.get(String(args[0]).toLowerCase()) ?? META;
          case "balanceOf":
            return this.credits.filter((c) => c.stealth === String(args[1]).toLowerCase() && c.block <= (blockNumber ?? this.head)).reduce((a, c) => a + c.raw, 0n);
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      getLogs: async (q: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock?: bigint; toBlock?: bigint | "latest"; blockHash?: Hash }) => {
        if (q.blockHash !== undefined) {
          if (this.unknownBlocks.has(q.blockHash)) throw new Error(`unknown block ${q.blockHash}`);
        } else if (q.toBlock !== "latest" && q.toBlock! > this.head) throw new Error(`header not found (block ${q.toBlock})`);
        const inRange = (l: Log) => (q.blockHash !== undefined ? l.blockHash === q.blockHash : l.blockNumber >= q.fromBlock! && (q.toBlock === "latest" || l.blockNumber <= q.toBlock!));
        return this.logs.filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && l.eventName === q.event.name && match(l, q.args) && inRange(l));
      },
    } as unknown as PublicClient;
  }
}
