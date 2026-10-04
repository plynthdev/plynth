// Viewing-key statements. The server never sees a viewing key: statements.list says which monthly statements
// exist for an address (block ranges the client feeds to the SDK's statement()), and statements.verify
// checks a scoped-disclosure bundle against the chain. Both read public chain data only and keep no state.
import { monthlyPeriods, verifyDisclosure, type DisclosureVerdict } from "@plynth/sdk/statements";
import type { AbiEvent, Address } from "viem";
import { vaultAbi } from "./abi";
import { iso } from "./format";
import type { Deps } from "./service";

export const STATEMENT_TITLE = "Viewing-key statement";
const ZERO = `0x${"0".repeat(64)}`;

export class StatementsUnavailable extends Error {}

function poolOf(d: Deps): Address {
  if (!d.dep.shieldedPool) throw new StatementsUnavailable("no Hidden Vault on this deployment");
  return d.dep.shieldedPool;
}

/** Monthly statements (newest first) from the month the address registered Hidden keys. */
export async function listStatements(d: Deps, user: Address, max = 24) {
  const pool = poolOf(d);
  const keys = await d.pub.readContract({ address: d.dep.vault, abi: vaultAbi, functionName: "hiddenKeysOf", args: [user] });
  const base = { address: user, chainId: d.chainId, pool, deployBlock: d.dep.deployBlock.toString() };
  if (keys.ownerPk === ZERO) return { ...base, hidden: false, ownerPk: null, statements: [] };
  const head = await d.pub.getBlockNumber({ cacheTime: 0 });
  const event = vaultAbi.find((x) => x.type === "event" && x.name === "HiddenKeysSet") as AbiEvent;
  const logs = await d.pub.getLogs({ address: d.dep.vault, event, args: { user }, fromBlock: d.dep.deployBlock, toBlock: head } as any);
  const since = logs.length ? logs[0]!.blockNumber! : d.dep.deployBlock;
  const months = await monthlyPeriods(d.pub, { sinceBlock: since, headBlock: head, max });
  return {
    ...base,
    hidden: true,
    ownerPk: keys.ownerPk,
    statements: months.map((m) => ({
      id: m.id,
      title: STATEMENT_TITLE,
      status: m.complete ? "Ready" : "In progress",
      // Dashboard activity row text, e.g. "Viewing-key statement · Ready".
      label: `${STATEMENT_TITLE} · ${m.complete ? "Ready" : "In progress"}`,
      period: { start: iso(m.start), end: iso(m.end), fromBlock: m.fromBlock.toString(), toBlock: m.toBlock.toString() },
    })),
  };
}

/** Stateless: checks a disclosure bundle against this deployment's pool. */
export async function verifyStatementBundle(d: Deps, bundle: unknown): Promise<DisclosureVerdict> {
  return verifyDisclosure(d.pub, bundle, { pool: poolOf(d), deployBlock: d.dep.deployBlock });
}
