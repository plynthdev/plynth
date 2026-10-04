// Local copy of ShieldedPool's commitment tree (depth 20, Poseidon2 nodes, empty subtrees from ZERO_LEAF),
// rebuilt from LeafInserted events. Only the filled part of each level is stored.
import { TREE_DEPTH, hashNode, zeroHashes } from "./note";

export class NoteTree {
  private levels: bigint[][] = Array.from({ length: TREE_DEPTH + 1 }, () => []);

  get size(): number {
    return this.levels[0]!.length;
  }

  insert(leaf: bigint): number {
    const zeros = zeroHashes();
    const index = this.size;
    if (index >= 2 ** TREE_DEPTH) throw new Error("tree full");
    this.levels[0]!.push(leaf);
    let pos = index;
    for (let d = 0; d < TREE_DEPTH; d++) {
      const lvl = this.levels[d]!;
      const left = pos % 2 === 0 ? lvl[pos]! : lvl[pos - 1]!;
      const right = pos % 2 === 0 ? (lvl[pos + 1] ?? zeros[d]!) : lvl[pos]!;
      pos >>= 1;
      this.levels[d + 1]![pos] = hashNode(left, right);
    }
    return index;
  }

  root(): bigint {
    return this.levels[TREE_DEPTH]![0] ?? zeroHashes()[TREE_DEPTH]!;
  }

  leaf(index: number): bigint | undefined {
    return this.levels[0]![index];
  }

  /** Sibling path for `index`, bottom-up (the circuits' `path`). */
  path(index: number): bigint[] {
    if (index < 0 || index >= this.size) throw new Error(`no leaf ${index}`);
    const zeros = zeroHashes();
    return Array.from({ length: TREE_DEPTH }, (_, d) => this.levels[d]![(index >> d) ^ 1] ?? zeros[d]!);
  }
}
