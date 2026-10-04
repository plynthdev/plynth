import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

// Sorted-pair Merkle tree, compatible with OpenZeppelin MerkleProof.verify (commutative keccak256 of the pair).
// Leaves are sorted and an odd node is carried up a layer unchanged, so a proof is just the sibling path.
//
// Leaf = keccak256(abi.encode(address asset, uint8 kind)), matching TreasuryPolicy.instrumentLeaf. A leaf
// preimage is 64 bytes like an internal node, but presenting a node as a leaf would need its left half to start
// with 12 zero bytes and its right half to be < 256, so single hashing is safe here.

export function instrumentLeaf(asset: Address, kind: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [asset, kind]));
}

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export type MerkleTree = { root: Hex; layers: Hex[][] };

export const ZERO32: Hex = `0x${"0".repeat(64)}`;

export function buildTree(leaves: Hex[]): MerkleTree {
  const sorted = [...leaves].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new Error(`duplicate leaf ${sorted[i]}`);
  }
  if (sorted.length === 0) return { root: ZERO32, layers: [[]] };
  const layers: Hex[][] = [sorted];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1]![0]!, layers };
}

export function getProof(tree: MerkleTree, leaf: Hex): Hex[] {
  let idx = tree.layers[0]!.indexOf(leaf);
  if (idx < 0) throw new Error(`leaf not in tree: ${leaf}`);
  const proof: Hex[] = [];
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l]!;
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]!);
    idx >>= 1;
  }
  return proof;
}

export function verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h === root;
}
