// Treasury setup before the 48h warp: a factory treasury from the balanced template on the real assets (board =
// anvil #0, controller = anvil #3, 1-day periods), its desks and sleeves (cash, equity, basis, hedge with the
// in-house perp venue, an off-chain venue seen through a PositionMirror), the T2 policy proposed through the 48h
// timelock, and the templates marketplace (author submits, committee lists, a second board deploys from it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, encodeAbiParameters, getAddress, stringToHex, type Address, type Hex } from "viem";
import { compileTemplate, loadTemplate, policyAbiParam, type Compiled } from "@/treasury/policy-compiler";
import { PATHS, ROOT, RPC } from "../lib";
import { abiOf, expect } from "./core";
import { erc20Abi, U, type Ctx } from "./context";
import { deskRows, runOnce, treasuryEnv, type DeskRow } from "./services";
import { devKey } from "../lib";

export const PERIOD_DAYS = 1;
export const FUNDING = 100_000n * U;
export const NAMES = ["TSLA", "AAPL", "NVDA", "SPY", "MSTR"] as const;

/** The fork's balanced template: real USDG, steakUSDG and five deep-pool Stock Tokens, daily periods. */
export function forkTemplate(controller: Address, t2?: { venues: Address[] }) {
  const balanced = loadTemplate(join(ROOT, "app", "templates", "balanced.yaml")) as Record<string, any>;
  const tpl: Record<string, any> = {
    ...balanced,
    name: t2 ? "balanced-fork-t2" : "balanced-fork",
    network: "mainnet",
    periodDays: PERIOD_DAYS,
    controller,
    instruments: [{ asset: "USDG", kind: "cash" }, { asset: "steakUSDG", kind: "cash_vault" }, ...NAMES.map((n) => ({ asset: n, kind: "stock_token" }))],
    desks: { equity: { weights: Object.fromEntries(NAMES.map((n) => [n, 1])) } },
  };
  if (t2) {
    tpl.bands = { ...balanced.bands, basis: [0, 20] };
    tpl.hedge = { netDeltaBps: [-2000, 6000], maxLeverageX10: 30 };
    // Lower lines than T1 so the fork can show the order cap and the board ticket on a $100k treasury.
    tpl.limits = { ...balanced.limits, perVenueBps: 2000, perOrderUsd: 40_000, perDayUsd: 300_000, approvalAboveUsd: 20_000 };
    tpl.venues = t2.venues;
  }
  return tpl;
}

function created(x: Ctx, logs: { data: Hex; topics: readonly Hex[] }[]) {
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: abiOf("TreasuryFactory"), data: l.data, topics: l.topics as never }) as unknown as { eventName: string; args: Record<string, Address> };
      if (ev.eventName === "TreasuryCreated") return ev.args;
    } catch {}
  }
  return undefined;
}

export async function treasurySetup(x: Ctx) {
  const { r, A } = x;
  const board = A.deployer;
  const factory = x.addr("treasuryFactory");
  const F = abiOf("TreasuryFactory");
  const usdg = x.addr("usdg");
  const tpl = forkTemplate(A.controller.address);
  const compiled = compileTemplate(tpl as never, { controller: A.controller.address, network: "mainnet" });
  x.state.t1 = compiled;
  const [pAccount] = await r.read<[Address, Address, Address, Address]>(factory, F, "predict", [board.address]);
  const t: Record<string, Address> = {};
  await r.send("board deploys a treasury from the balanced template (TreasuryFactory)", board, { address: factory, abi: F, functionName: "deploy", args: [encodeAbiParameters([policyAbiParam], [compiled.policy]), board.address] }, async (rc) => {
    const ev = created(x, rc.logs as never);
    expect(!!ev, "no TreasuryCreated");
    Object.assign(t, { account: ev!.account, policy: ev!.policy, close: ev!.close, approvals: ev!.approvals });
    expect(getAddress(ev!.account!) === getAddress(pAccount), "predict() did not match");
    const [, hash] = await r.read<[unknown, Hex, number]>(t.policy!, abiOf("TreasuryPolicy"), "current");
    expect(hash === compiled.hash, "policy hash differs from the compiled one");
    return `account ${ev!.account} (as predicted), policy v1 hash ${hash.slice(0, 10)}…`;
  });
  if (!t.account) throw new Error("no treasury: the rest of the treasury setup depends on it");
  for (const [k, v] of Object.entries(t)) r.names.set(v.toLowerCase(), `treasury ${k}`);
  x.state.treasury = t;
  x.state.policy = t.policy;

  const beacon = await r.deploy("equity desk JitterBeacon (keeper = equity desk key)", board, "JitterBeacon", [A.equityDesk.address, board.address]);
  const ACC = abiOf("TreasuryAccount");
  await r.send("board registers the cash desk (CashSleeve over USDG + steakUSDG)", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("cash", { size: 32 }), A.cashDesk.address, [x.addr("cashSleeve")]] });
  await r.send("board registers the equity desk (EquitySleeve over the real Stock Tokens)", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("equity", { size: 32 }), A.equityDesk.address, [x.addr("equitySleeve")]] });
  await r.send("board funds the treasury with 100,000 real USDG", board, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [t.account, FUNDING] }, async () => {
    const [nav] = await r.read<[bigint, boolean]>(t.account!, ACC, "navUsd");
    expect(nav === FUNDING * 10n ** 12n, `NAV ${nav}`);
    return "navUsd = $100,000";
  });

  // T2: basis sleeve + hedge sleeve on the in-house TSLA perp market, and an off-chain venue through a mirror.
  const pool = x.addr("perpPool");
  const tslaMarket = getAddress(x.dep.perpMarkets.TSLA!);
  const basis = await r.deploy("BasisSleeve for the treasury", board, "BasisSleeve", [t.account, usdg, x.addr("valuer")]);
  const basisVenue = basis && (await r.deploy("in-house perp venue for the basis sleeve (TSLA market)", board, "InHousePerpVenue", [basis, pool, [tslaMarket]]));
  const perp = await r.deploy("PerpSleeve (hedge) for the treasury", board, "PerpSleeve", [t.account, usdg, 0]);
  const hedgeVenue = perp && (await r.deploy("in-house perp venue for the hedge sleeve (TSLA market)", board, "InHousePerpVenue", [perp, pool, [tslaMarket]]));
  const mirror = await r.deploy("PositionMirror for off-chain venues (controller-signed snapshots)", board, "PositionMirror", [t.policy]);
  const mirrorVenue = perp && mirror && (await r.deploy("MirroredPerpVenue (an off-chain venue seen through the mirror)", board, "MirroredPerpVenue", [perp, usdg, mirror, A.trader2.address]));
  if (!basis || !basisVenue || !perp || !hedgeVenue || !mirror || !mirrorVenue) throw new Error("T2 contracts missing");
  await r.send("board adds the in-house venue to the basis sleeve", board, { address: basis, abi: abiOf("BasisSleeve"), functionName: "addVenue", args: [basisVenue] });
  await r.send("board adds the in-house venue to the hedge sleeve", board, { address: perp, abi: abiOf("PerpSleeve"), functionName: "addVenue", args: [hedgeVenue] });
  await r.send("board adds the mirrored venue to the hedge sleeve", board, { address: perp, abi: abiOf("PerpSleeve"), functionName: "addVenue", args: [mirrorVenue] });
  await r.send("board registers the basis desk", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("basis", { size: 32 }), A.basisDesk.address, [basis]] });
  await r.send("board registers the hedge desk", board, { address: t.account, abi: ACC, functionName: "registerDesk", args: [stringToHex("hedge", { size: 32 }), A.hedgeDesk.address, [perp]] });
  Object.assign(t, { beacon: beacon!, basis, basisVenue, perp, hedgeVenue, mirror, mirrorVenue });
  for (const [k, v] of Object.entries({ basis, basisVenue, perp, hedgeVenue, mirror, mirrorVenue })) r.names.set(v.toLowerCase(), k);

  const t2 = compileTemplate(forkTemplate(A.controller.address, { venues: [basisVenue, hedgeVenue, mirrorVenue] }) as never, { controller: A.controller.address, network: "mainnet" });
  x.state.t2 = t2;
  const P = abiOf("TreasuryPolicy");
  await r.reverts("only the board may propose a policy", A.cashDesk, { address: t.policy!, abi: P, functionName: "propose", args: [t2.policy] }, "NotBoard");
  await r.send("board proposes the T2 policy (basis band 0-20%, venues, leverage 3x): 48h timelock", board, { address: t.policy!, abi: P, functionName: "propose", args: [t2.policy] }, async () => {
    const [, hash, eta] = await r.read<[unknown, Hex, bigint]>(t.policy!, P, "pending");
    expect(hash === t2.hash, "pending hash differs");
    return `pending ${hash.slice(0, 10)}…, eta ${eta}`;
  });

  // Desk runner config for treasury-desks (and services.json, so up.sh can run the per-treasury loops later).
  mkdirSync(PATHS.treasury, { recursive: true });
  writeFileSync(join(PATHS.treasury, "policy.yaml"), JSON.stringify(tpl, null, 2));
  const desksConfig = join(PATHS.treasury, "desks.json");
  writeFileSync(desksConfig, JSON.stringify({ rpcUrl: RPC, account: t.account, cashSleeve: x.addr("cashSleeve"), equitySleeve: x.addr("equitySleeve"), vault: x.addr("steakUsdg"), beacon, cashDeskId: "cash", equityDeskId: "equity", policyTemplate: "policy.yaml", network: "mainnet" }, null, 2));
  x.state.desksConfig = desksConfig;
  writeFileSync(join(PATHS.treasury, "services.json"), JSON.stringify({ desksConfig, account: t.account, periodClose: t.close, mirror }, null, 2));

  // Desk passes (treasury-desks --once): recorded as one step per desk action the pass logged.
  let lastRow = 0;
  x.state.deskPass = async (label: string): Promise<DeskRow[]> => {
    const run = await runOnce("src/bin/treasury-desks.ts", ["--once"], treasuryEnv({ TREASURY_CONFIG: desksConfig, TREASURY_CASH_DESK_KEY: devKey(4), TREASURY_EQUITY_DESK_KEY: devKey(5), TREASURY_JURY: "on" }));
    const rows = await deskRows(t.account!, lastRow);
    if (rows.length) lastRow = rows[rows.length - 1]!.id;
    await r.check(`treasury-desks --once (${label}) exits cleanly`, async () => {
      expect(run.code === 0, `exit ${run.code}: ${run.out.slice(-600)}`);
      return `${rows.length} desk actions logged`;
    }, "desk runner");
    for (const row of rows) {
      await r.external(`desk runner (${label}): ${row.desk} ${row.action}${row.asset ? ` ${r.who(row.asset as Address)}` : ""} -> ${row.status}${row.reason ? ` (${row.reason})` : ""}`, `${row.desk} desk`, async () => {
        expect(row.status !== "reverted", `reverted: ${row.reason}`);
        return { tx: (row.tx_hash ?? undefined) as Hex | undefined, assertion: `desk_actions row ${row.id}: ${row.status}${row.notional_usd ? `, notional $${(Number(BigInt(row.notional_usd) / 10n ** 12n) / 1e6).toFixed(2)}` : ""}` };
      });
    }
    return rows;
  };

  // Templates marketplace: the author submits, the committee lists, a second board deploys from it.
  const T = abiOf("TemplateRegistry");
  const reg = x.addr("templateRegistry");
  const hash = await r.read<Hex>(factory, F, "templateHash", [compiled.policy]);
  let id: bigint | undefined;
  await r.send("author submits the balanced-fork template to the marketplace", A.staker, { address: reg, abi: T, functionName: "submit", args: [hash, "ipfs://bafy-plynth-fork-balanced"] }, async () => {
    id = await r.read<bigint>(reg, T, "count"); // ids start at 1
    return `template id ${id}, hash ${hash.slice(0, 10)}…`;
  });
  if (id === undefined) return;
  await r.reverts("an unlisted template cannot be deployed", A.board2, { address: factory, abi: F, functionName: "deployFromTemplate", args: [encodeAbiParameters([policyAbiParam], [compiled.policy]), A.board2.address, id] }, "TemplateNotListed");
  await r.reverts("only the committee can list", A.staker, { address: reg, abi: T, functionName: "list", args: [id] }, "NotCommittee");
  await r.send("committee lists the template", A.committee, { address: reg, abi: T, functionName: "list", args: [id] }, async () => {
    expect(await r.read<boolean>(reg, T, "isListed", [id]), "not listed");
    return "isListed = true";
  });
  const other = { ...compiled.policy, perOrderCapUsd: compiled.policy.perOrderCapUsd + 1n };
  await r.reverts("a policy that differs from the template is refused", A.board2, { address: factory, abi: F, functionName: "deployFromTemplate", args: [encodeAbiParameters([policyAbiParam], [other]), A.board2.address, id] }, "TemplateMismatch");
  const t2b: Record<string, Address> = {};
  await r.send("second board deploys a treasury from the listed template", A.board2, { address: factory, abi: F, functionName: "deployFromTemplate", args: [encodeAbiParameters([policyAbiParam], [compiled.policy]), A.board2.address, id] }, async (rc) => {
    const ev = created(x, rc.logs as never);
    expect(!!ev, "no TreasuryCreated");
    Object.assign(t2b, { account: ev!.account, policy: ev!.policy, close: ev!.close });
    expect((await r.read<bigint>(factory, F, "templateOf", [ev!.account])) === id, "templateOf not recorded");
    return `account ${ev!.account}, templateOf = ${id}`;
  });
  if (t2b.account) {
    r.names.set(t2b.account.toLowerCase(), "marketplace treasury");
    r.names.set(t2b.close!.toLowerCase(), "marketplace PeriodClose");
    await r.send("second board funds its treasury with 50,000 USDG", A.board2, { address: usdg, abi: erc20Abi, functionName: "transfer", args: [t2b.account, 50_000n * U] });
    x.state.market = { ...t2b, templateId: id };
  }
}
