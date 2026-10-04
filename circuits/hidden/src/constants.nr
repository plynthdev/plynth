// Shared Hidden Vault constants. Source of truth: circuits/constants.json.
// contracts/src/consumer/verifiers/HiddenConstants.sol carries the same values;
// circuits/scripts/hidden.test.ts fails if either file drifts from the JSON.

/// Depth of the note commitment tree (2^20 leaves).
pub global TREE_DEPTH: u32 = 20;

/// Value of an empty leaf: keccak256("plynth.hidden.zero-leaf") mod p.
pub global ZERO_LEAF: Field = 0x2bb8861f5aa825a765f7e78956503f1d46263f070a07b3dd7cf96e2773ff850e; // not-a-key
