// Tally and the verdict bundle. The bundle's canonical JSON is what Postgres stores and what the board reads;
// keccak256 of those exact bytes goes on-chain as BoardApprovals' juryVerdictCid.
import { hexToBytes, type Hex } from "viem";
import { bundleHashOf, canonicalJson } from "@/treasury/close/bundle";
import { JURY_SCHEMA, type ExceptionRequest, type JurorResult, type JuryBundle, type RuleOpinion, type Verdict } from "./types";

/** Majority of the non-abstaining jurors. A tie, two or more abstentions, or no jurors = no recommendation. */
export function tally(jurors: JurorResult[]): Verdict {
  const approve = jurors.filter((j) => j.status === "vote" && j.recommend === "approve").length;
  const reject = jurors.filter((j) => j.status === "vote" && j.recommend === "reject").length;
  const abstain = jurors.length - approve - reject;
  let recommend: Verdict["recommend"] = "none";
  let why: string;
  if (jurors.length === 0) why = "no model jurors ran (Ollama unavailable): rule juror only";
  else if (abstain >= 2) why = `${abstain} of ${jurors.length} jurors abstained`;
  else if (approve === reject) why = `tie ${approve}-${reject}`;
  else {
    recommend = approve > reject ? "approve" : "reject";
    why = `majority ${Math.max(approve, reject)}-${Math.min(approve, reject)} of ${approve + reject} voting`;
  }
  return { recommend, approve, reject, abstain, why };
}

export function buildBundle(a: { request: ExceptionRequest; models: string[]; jurors: JurorResult[]; rules: RuleOpinion; up: boolean; createdAt: Date }): JuryBundle {
  return {
    schema: JURY_SCHEMA,
    mode: a.up ? "models+rules" : "rules-only",
    createdAt: a.createdAt.toISOString(),
    request: a.request,
    models: a.models,
    jurors: a.up ? a.jurors : [],
    verdict: tally(a.up ? a.jurors : []),
    rules: a.rules,
    note: "Advice only. The jury never approves anything on-chain; only the board can approve a BoardApprovals ticket.",
  };
}

export function encodeBundle(b: JuryBundle): { json: string; hash: Hex; cid: Hex } {
  const json = canonicalJson(b);
  const hash = bundleHashOf(json);
  return { json, hash, cid: hash };
}

/** True if `cid` (bytes from BoardApprovals) is the keccak256 of this exact JSON. */
export function cidMatches(json: string, cid: Hex): boolean {
  if (hexToBytes(cid).length !== 32) return false;
  return bundleHashOf(json).toLowerCase() === cid.toLowerCase();
}
