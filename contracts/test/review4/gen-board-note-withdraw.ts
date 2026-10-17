// review4 PoC fixture (R4-TREAS-1): a real withdraw proof for a note the BOARD deposited straight into the
// ShieldedPool (not through the PrivateSleeve), paying the whole note to the sleeve. The tree is the PrivateSleeve
// fixture's three shields (leaves 0-2) plus the board's note (leaf 3).
//   (cd circuits/withdraw && nargo compile) && bun contracts/test/review4/gen-board-note-withdraw.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "../../../circuits/node_modules/viem";
import { P, buildTree, commitment, initNote, nullifier, ownerPk } from "../../../circuits/scripts/note";
import { prove } from "../../../circuits/scripts/prove";
import { AAPL, NVDA, SLEEVE } from "../../../circuits/scripts/treasury-close-fixtures";

const E18 = 10n ** 18n;
const SLEEVE_SECRET = 0x7a11n;
const BOARD_SECRET = 0xb0a4dn;
const SHIELDS = [
  { asset: AAPL, raw: 250n * E18, blinding: 0x51n },
  { asset: AAPL, raw: 200n * E18, blinding: 0x52n },
  { asset: NVDA, raw: 300n * E18, blinding: 0x53n },
];
const BOARD_NOTE = { asset: AAPL, raw: 600n * E18, blinding: 0x61n };
const s = (x: bigint) => "0x" + x.toString(16);
const d = (x: bigint) => x.toString();

await initNote();
const spk = ownerPk(SLEEVE_SECRET);
const bpk = ownerPk(BOARD_SECRET);
const leaves = SHIELDS.map((n) => commitment(n.asset, n.raw, spk, n.blinding));
leaves.push(commitment(BOARD_NOTE.asset, BOARD_NOTE.raw, bpk, BOARD_NOTE.blinding));
const tree = buildTree(leaves);
const ext = BigInt(keccak256("0x")) % P;
const nf = nullifier(leaves[3]!, BOARD_SECRET, 3n);
const inputs = {
  root: s(tree.root), nullifier_hash: s(nf), change_commitment: s(0n), asset_id: s(BOARD_NOTE.asset),
  amount: s(BOARD_NOTE.raw), recipient: s(SLEEVE), relayer_fee: s(0n), ext_hash: s(ext), in_amount: s(BOARD_NOTE.raw),
  in_secret: s(BOARD_SECRET), in_blinding: s(BOARD_NOTE.blinding), in_index: s(3n), in_path: tree.path(3).map(s),
  change_amount: s(0n), change_owner_pk: s(bpk), change_blinding: s(0x1n),
};
const p = await prove("withdraw", inputs);
const f = join(import.meta.dir, "fixtures/board_note_withdraw.json");
writeFileSync(f, JSON.stringify({ root: d(tree.root), boardPk: d(bpk), nullifier: d(nf), amount: d(BOARD_NOTE.raw), blinding: d(BOARD_NOTE.blinding), proofHex: p.proof.slice(2) }, null, 2) + "\n");
console.log(`wrote ${f}`);
