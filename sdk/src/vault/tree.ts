// Local copy of ShieldedPool's commitment trees (depth 20, Poseidon2 nodes, empty subtrees from ZERO_LEAF),
// rebuilt from LeafInserted events. Only the filled part of each level is stored.
//
// Leaf indexes are global, as the pool emits them: when a tree's 2^20 leaves are used the pool starts the next
// tree, so leaf i is at position i % 2^20 of tree floor(i / 2^20) and the full tree's final root stays known.
// A proof uses the note's own tree: rootOf(i) and position(i) (the circuits' `index`), with path(i).
import { TREE_DEPTH, hashNode, zeroHashes } from "./note";

export class NoteTree {
  private trees: bigint[][][] = [];
  private count = 0;

  /** `capacity`: leaves per tree; the pool's is 2^TREE_DEPTH (smaller only to test rollover). */
  constructor(readonly capacity = 2 ** TREE_DEPTH) {
    if (capacity < 1 || capacity > 2 ** TREE_DEPTH || (capacity & (capacity - 1)) !== 0) throw new Error("capacity must be a power of two <= 2^20");
  }

  /** Leaves inserted, over every tree (the next global index). */
  get size(): number {
    return this.count;
  }

  /** Position of global leaf `index` in its tree (the circuits' `index`, which the nullifier uses). */
  position(index: number): number {
    return index % this.capacity;
  }

  treeOf(index: number): number {
    return Math.floor(index / this.capacity);
  }

  insert(leaf: bigint): number {
    const zeros = zeroHashes();
    const index = this.count;
    const t = this.treeOf(index);
    const levels = (this.trees[t] ??= Array.from({ length: TREE_DEPTH + 1 }, () => []));
    levels[0]!.push(leaf);
    let pos = this.position(index);
    for (let d = 0; d < TREE_DEPTH; d++) {
      const lvl = levels[d]!;
      const left = pos % 2 === 0 ? lvl[pos]! : lvl[pos - 1]!;
      const right = pos % 2 === 0 ? (lvl[pos + 1] ?? zeros[d]!) : lvl[pos]!;
      pos >>= 1;
      levels[d + 1]![pos] = hashNode(left, right);
    }
    this.count++;
    return index;
  }

  /** Root of the tree new leaves go into (the pool's currentRoot). */
  root(): bigint {
    return this.count === 0 ? zeroHashes()[TREE_DEPTH]! : this.rootOf(this.count - 1);
  }

  /** Root of the tree that holds global leaf `index` (a full tree's root stays known on-chain forever). */
  rootOf(index: number): bigint {
    const levels = this.trees[this.treeOf(index)];
    return levels?.[TREE_DEPTH]![0] ?? zeroHashes()[TREE_DEPTH]!;
  }

  leaf(index: number): bigint | undefined {
    return this.trees[this.treeOf(index)]?.[0]![this.position(index)];
  }

  /** Sibling path for global leaf `index` in its own tree, bottom-up (the circuits' `path`). */
  path(index: number): bigint[] {
    if (index < 0 || index >= this.count) throw new Error(`no leaf ${index}`);
    const zeros = zeroHashes();
    const levels = this.trees[this.treeOf(index)]!;
    const pos = this.position(index);
    return Array.from({ length: TREE_DEPTH }, (_, d) => levels[d]![(pos >> d) ^ 1] ?? zeros[d]!);
  }
}
