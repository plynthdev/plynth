// Desk runner config: a JSON file (TREASURY_CONFIG) naming the treasury's contracts, plus the board's policy
// template (YAML) for the instrument proofs and the desk metadata. Keys are never in this file (see keys.ts).
//
// {
//   "rpcUrl": "http://127.0.0.1:8545",            // TREASURY_RPC_URL overrides
//   "account": "0x…", "cashSleeve": "0x…", "equitySleeve": "0x…", "vault": "0x…", "beacon": "0x…",
//   "cashDeskId": "cash", "equityDeskId": "equity",   // bytes32 strings the board registered
//   "policyTemplate": "app/templates/balanced.yaml",       // relative to the config file
//   "network": "mainnet" | "testnet",                  // for symbol resolution in the template
//   "cash":   { "reserveBps": 200, "sweepMinBps": 50 },
//   "equity": { "targetBps": 4500, "weights": { "0x…": 2 }, "driftBps": 100, "slippageBps": 100 }
// }
//
// Policy metadata: a template may carry a `desks:` block (`desks.equity.targetBps`, `desks.equity.weights`
// keyed by symbol or address). The compiler ignores it; the desks read it. The config file's values win.
import { compileTemplate, loadTemplate, type Template } from "@/treasury/policy-compiler";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import type { EquityConfig } from "./plan";

export type CashConfig = { reserveBps: number; sweepMinBps: number };

export type DeskConfig = {
  rpcUrl?: string | undefined;
  account: Address;
  cashSleeve: Address;
  equitySleeve: Address;
  vault: Address;
  beacon: Address;
  cashDeskId: string;
  equityDeskId: string;
  /** asset (checksummed) -> Merkle proof against the policy's instrumentAllowRoot */
  proofs: Record<string, Hex[]>;
  /** root the proofs were built for; the runner refuses to trade if the on-chain policy has another one */
  allowRoot: Hex;
  cash: CashConfig;
  equity: EquityConfig;
};

type RawConfig = {
  rpcUrl?: string | undefined;
  account: string;
  cashSleeve: string;
  equitySleeve: string;
  vault: string;
  beacon: string;
  cashDeskId?: string;
  equityDeskId?: string;
  policyTemplate: string;
  network?: "mainnet" | "testnet";
  cash?: Partial<CashConfig>;
  equity?: EquityConfig;
};

type DeskMeta = { equity?: { targetBps?: number; weights?: Record<string, number> } };

export function parseConfig(raw: RawConfig, baseDir: string): DeskConfig {
  for (const k of ["account", "cashSleeve", "equitySleeve", "vault", "beacon", "policyTemplate"] as const) {
    if (!raw[k]) throw new Error(`desk config: ${k} is required`);
  }
  const tplPath = isAbsolute(raw.policyTemplate) ? raw.policyTemplate : resolve(baseDir, raw.policyTemplate);
  const tpl = loadTemplate(tplPath) as Template & { desks?: DeskMeta };
  const network = raw.network ?? tpl.network ?? "mainnet";
  // The controller does not change the allow tree; any address compiles.
  const compiled = compileTemplate(tpl, { controller: tpl.controller ?? getAddress(raw.account), network });
  const proofs: Record<string, Hex[]> = {};
  for (const i of compiled.instruments) proofs[getAddress(i.asset)] = i.proof;

  const meta = tpl.desks?.equity ?? {};
  let weights = raw.equity?.weights ?? meta.weights;
  if (weights) {
    // Symbols in the template resolve through the same instrument list the board signed.
    const bySymbol = Object.fromEntries(compiled.instruments.map((i) => [i.label, getAddress(i.asset)]));
    weights = Object.fromEntries(
      Object.entries(weights).map(([k, v]) => {
        const addr = k.startsWith("0x") ? getAddress(k) : bySymbol[k];
        if (!addr) throw new Error(`desk config: weight for unknown instrument ${k}`);
        return [addr, v];
      }),
    );
  }
  return {
    rpcUrl: raw.rpcUrl,
    account: getAddress(raw.account),
    cashSleeve: getAddress(raw.cashSleeve),
    equitySleeve: getAddress(raw.equitySleeve),
    vault: getAddress(raw.vault),
    beacon: getAddress(raw.beacon),
    cashDeskId: raw.cashDeskId ?? "cash",
    equityDeskId: raw.equityDeskId ?? "equity",
    proofs,
    allowRoot: compiled.policy.instrumentAllowRoot,
    cash: { reserveBps: raw.cash?.reserveBps ?? 200, sweepMinBps: raw.cash?.sweepMinBps ?? 50 },
    equity: { targetBps: raw.equity?.targetBps ?? meta.targetBps, weights, driftBps: raw.equity?.driftBps, slippageBps: raw.equity?.slippageBps },
  };
}

export function loadConfig(path: string): DeskConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")) as RawConfig, dirname(resolve(path)));
}
