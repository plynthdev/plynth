// Fixture generator (not deployed): evaluates Noir's Poseidon2 permutation and the Hidden
// Vault sponge on N inputs so Solidity can be checked against them. Run by
// circuits/scripts/fixtures.ts; the output lands in contracts/test/consumer/verifiers/fixtures/.

use hidden::{hash, zero_hashes, TREE_DEPTH};

global N: u32 = 100;

fn main(
    states: [[Field; 4]; N],
    a: [Field; N],
    b: [Field; N],
    c: [Field; N],
    d: [Field; N],
) -> pub ([[Field; 4]; N], [Field; N], [Field; N], [Field; N], [Field; N], [Field; TREE_DEPTH + 1]) {
    let mut perms = [[0; 4]; N];
    let mut h1 = [0; N];
    let mut h2 = [0; N];
    let mut h3 = [0; N];
    let mut h4 = [0; N];
    for i in 0..N {
        perms[i] = std::hash::poseidon2_permutation(states[i]);
        h1[i] = hash([a[i]]);
        h2[i] = hash([a[i], b[i]]);
        h3[i] = hash([a[i], b[i], c[i]]);
        h4[i] = hash([a[i], b[i], c[i], d[i]]);
    }
    (perms, h1, h2, h3, h4, zero_hashes())
}
