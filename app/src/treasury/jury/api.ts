// Read-only board API for jury verdicts, as a plain fetch handler (Request -> Response) that the treasury API
// (todo 14) can mount under /jury. Every bundle is re-hashed before it is served; a row whose JSON does not
// hash to its stored hash (or to the ticket's on-chain juryVerdictCid) is refused with 409.
import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { approvalsAbi } from "@/abi/treasury-jury";
import type { JuryRow, JuryStore } from "./store";
import { cidMatches } from "./verdict";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function present(row: JuryRow) {
  return {
    id: row.id,
    chainId: row.chainId,
    approvals: row.approvals,
    account: row.account,
    desk: row.desk,
    opHash: row.opHash,
    ticket: row.ticket,
    status: row.status,
    mode: row.mode,
    recommendation: row.recommendation,
    ruleRecommendation: row.ruleRecommendation,
    bundleHash: row.bundleHash,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
  };
}

export function juryApi(store: JuryStore, opts: { pub?: PublicClient; prefix?: string } = {}) {
  const prefix = opts.prefix ?? "/jury";
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return json(404, { error: "not found" });
    const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "verdicts") {
      const account = url.searchParams.get("account") ?? undefined;
      if (account && !isAddress(account)) return json(400, { error: "bad account" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
      return json(200, { verdicts: (await store.recent(limit, account)).map(present) });
    }

    let row: JuryRow | undefined;
    const [kind, chainIdS, approvals, key] = parts;
    if (parts.length !== 4 || !chainIdS || !approvals || !key || !/^\d+$/.test(chainIdS) || !isAddress(approvals)) return json(404, { error: "not found" });
    const chainId = Number(chainIdS);
    if (kind === "tickets") {
      if (!/^\d+$/.test(key)) return json(400, { error: "ticket must be a decimal id" });
      const ticket = `0x${BigInt(key).toString(16).padStart(64, "0")}` as Hex;
      row = await store.byTicket(chainId, approvals, ticket);
      if (row && opts.pub) {
        const cid = (await opts.pub.readContract({ address: approvals as Address, abi: approvalsAbi, functionName: "juryVerdictCidOf", args: [ticket] })) as Hex;
        if (!cidMatches(row.bundleJson, cid)) return json(409, { error: "stored bundle does not match the ticket's on-chain juryVerdictCid", ticket: key });
      }
    } else if (kind === "verdicts") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return json(400, { error: "bad bundle hash" });
      row = await store.byHash(chainId, approvals, key);
    } else return json(404, { error: "not found" });

    if (!row) return json(404, { error: "no verdict" });
    if (!cidMatches(row.bundleJson, row.bundleHash as Hex)) return json(409, { error: "stored bundle does not hash to its bundle_hash" });
    return json(200, { ...present(row), verified: true, bundle: JSON.parse(row.bundleJson) });
  };
}
