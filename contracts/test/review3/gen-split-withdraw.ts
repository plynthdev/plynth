// review3 PoC fixture: real withdraw proofs that share one nullifier per note (the controller holds the spending
// secret). For each of the three PrivateSleeve fixture notes: proof A pays 1 wei to the sleeve and keeps the rest as
// a change note for the same key; proof B pays the whole note to the sleeve (zero change).
//   (cd circuits/withdraw && nargo compile) && bun contracts/test/review3/gen-split-withdraw.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "../../../circuits/node_modules/viem";
import { P, buildTree, commitment, initNote, nullifier, ownerPk } from "../../../circuits/scripts/note";
import { prove } from "../../../circuits/scripts/prove";
import { AAPL, NVDA, SLEEVE } from "../../../circuits/scripts/treasury-close-fixtures";

const E18 = 10n ** 18n;
const SECRET = 0x7a11n;
const SHIELDS = [
  { asset: AAPL, raw: 250n * E18, blinding: 0x51n },
  { asset: AAPL, raw: 200n * E18, blinding: 0x52n },
  { asset: NVDA, raw: 300n * E18, blinding: 0x53n },
];
const s = (x: bigint) => "0x" + x.toString(16);
const d = (x: bigint) => x.toString();

await initNote();
const pk = ownerPk(SECRET);
const leaves = SHIELDS.map((n) => commitment(n.asset, n.raw, pk, n.blinding));
const tree = buildTree(leaves);
const ext = BigInt(keccak256("0x")) % P;
const out: any[] = [];
for (let i = 0; i < 3; i++) {
  const n = SHIELDS[i]!;
  const nf = nullifier(leaves[i]!, SECRET, BigInt(i));
  const mk = (amount: bigint, changeBlinding: bigint) => {
    const change = n.raw - amount;
    const cc = change === 0n ? 0n : commitment(n.asset, change, pk, changeBlinding);
    return {
      inputs: {
        root: s(tree.root), nullifier_hash: s(nf), change_commitment: s(cc), asset_id: s(n.asset), amount: s(amount),
        recipient: s(SLEEVE), relayer_fee: s(0n), ext_hash: s(ext), in_amount: s(n.raw), in_secret: s(SECRET),
        in_blinding: s(n.blinding), in_index: s(BigInt(i)), in_path: tree.path(i).map(s), change_amount: s(change),
        change_owner_pk: s(pk), change_blinding: s(changeBlinding),
      },
      cc, amount,
    };
  };
  const a = mk(1n, 0x900n + BigInt(i));
  const b = mk(n.raw, 0x1n);
  const pa = await prove("withdraw", a.inputs);
  const pb = await prove("withdraw", b.inputs);
  out.push({
    asset: "0x" + n.asset.toString(16).padStart(40, "0"), nullifier: d(nf),
    a: { proofHex: pa.proof.slice(2), amount: d(a.amount), changeCommitment: d(a.cc) },
    b: { proofHex: pb.proof.slice(2), amount: d(b.amount), changeCommitment: d(b.cc) },
  });
  console.log(`note ${i}: proofs A (1 wei) and B (full) ok`);
}
const f = join(import.meta.dir, "fixtures/split_withdraw.json");
writeFileSync(f, JSON.stringify({ root: d(tree.root), notes: out }, null, 2) + "\n");
console.log(`wrote ${f}`);
