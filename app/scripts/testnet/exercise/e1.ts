// E1 on testnet (fixed in the keeper): a Quiet plan exists, our deliver failed, the user claimed openly; the keeper
// must then release nothing from the pool every Quiet user shares.
//
// Reproduced with the real keeper code on the real chain: the running keeper is stopped, the Open saver becomes a
// Quiet saver for its (executed, unclaimed) mSPY allocation, and ONE keeper pass runs in this process with the
// keeper's own key and job code. Its Sender gets a gas estimate for the open saver's crowd.deliver that is too low,
// so that deliver mines and reverts (out of gas) after the plan row and the signed transaction were stored. The
// saver then claims openly, the running keeper is started again, and its next pass must mark the plan skipped
// ("claimed openly") and credit none of the plan's stealth addresses.
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { crowdAbi } from "@/abi/keeper";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { getJob } from "@/keeper/jobstore";
import { runDeliverQuiet, type Plan } from "@/keeper/jobs/quiet";
import { Sender, viemSenderIO, type SenderIO } from "@/keeper/sender";
import { APP, PATHS, PORTS, TESTNET_CHAIN_ID, TESTNET_DIR } from "../lib";
import { db } from "./services";
import type { TCtx } from "./ctx";

const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as const;
const nodeInterfaceAbi = parseAbi(["function gasEstimateComponents(address to, bool contractCreation, bytes data) returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);

const pidFile = join(PATHS.pids, "keeper.pid");
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops the running keeper service (the way down.sh does). Returns its old pid, or undefined if none ran. */
export async function stopKeeper(): Promise<number | undefined> {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid || !alive(pid)) {
    rmSync(pidFile, { force: true });
    return undefined;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 60 && alive(pid); i++) await Bun.sleep(500);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(pidFile, { force: true });
  return pid;
}

export type ServiceStart = { dir: string; envFile: string; entry: string; log: string; pidFile: string; healthUrl: string };

/** The shell line that starts one service the way up.sh does: its env file only, detached, log appended. */
export function serviceStartScript(o: Pick<ServiceStart, "dir" | "envFile" | "entry" | "log">): string {
  // Only the nohup'd process goes to the background (`;`, not `&&`: an `a && b &` chain backgrounds a subshell that
  // keeps the caller's pipe open), with stdin/stdout/stderr off that pipe.
  return `cd "${o.dir}" || exit 1; set -a; . "${o.envFile}"; set +a; nohup bun "${o.entry}" >>"${o.log}" 2>&1 </dev/null & echo $!`;
}

/** A login's basic variables only (never app/.env): Postgres takes the user from USER when DATABASE_URL names none. */
export function serviceEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG"]) if (env[k]) out[k] = env[k]!;
  return out;
}

/** Starts a service (serviceStartScript), records its pid and waits for its health URL. Returns the pid. */
export async function startService(o: ServiceStart, timeoutMs = 120_000): Promise<number> {
  const p = Bun.spawn(["bash", "-c", serviceStartScript(o)], { stdout: "pipe", stderr: "pipe", env: serviceEnv() });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  const pid = Number(out);
  if (!pid) throw new Error(`service did not start: ${out}`);
  writeFileSync(o.pidFile, String(pid));
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(o.healthUrl);
      if (r.ok) return pid;
    } catch {}
    if (!alive(pid)) throw new Error(`service exited at start; see ${o.log}`);
    await Bun.sleep(500);
  }
  throw new Error(`service not healthy within ${timeoutMs / 1000} s`);
}

/** Starts the keeper service again the way up.sh does (no-op when it already runs). */
export async function startKeeper(): Promise<number> {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (pid && alive(pid)) return pid;
  }
  return startService({ dir: TESTNET_DIR, envFile: join(PATHS.env, "keeper.env"), entry: join(APP, "src/bin/keeper.ts"), log: join(PATHS.logs, "keeper.log"), pidFile, healthUrl: `http://127.0.0.1:${PORTS.keeper}/health` });
}

export const planKey = (asset: Address, bookId: bigint | string, user: Address) => `${asset.toLowerCase()}:${String(bookId)}:${user.toLowerCase()}`;

export async function planRow(key: string) {
  return getJob({ db: db().db, chainId: TESTNET_CHAIN_ID }, "quiet-plan", key);
}

/**
 * One deliver-quiet pass with the keeper's key and code, in this process. Every call goes out unchanged except the
 * gas estimate for crowd.deliver(asset, bookId, user, ...): it is set so the signed gas limit covers the L1 data
 * part and intrinsic gas but not the deliver's execution, which then reverts on chain (out of gas).
 */
export type DeliverTarget = { asset: Address; bookId: bigint; user: Address };

/** Execution gas the failing deliver gets beyond its L1 data part: intrinsic + calldata + a few k, never a deliver. */
export const FAIL_EXEC_GAS = 40_000n;

/**
 * A SenderIO identical to `base` except for the gas estimate of crowd.deliver(target): that one is set so the
 * Sender's signed limit (estimate + 20%) is the call's L1 data gas plus FAIL_EXEC_GAS, which covers submission but
 * not the deliver's execution (out of gas on chain). Every other call, including other users' delivers, is unchanged.
 */
export function failingDeliverIO(base: SenderIO, crowd: Address, target: DeliverTarget, l1GasOf: (to: Address, data: Hex) => Promise<bigint>, seen: { limit?: bigint } = {}): SenderIO {
  return {
    ...base,
    estimateGas: async (a) => {
      const est = await base.estimateGas(a);
      if (getAddress(a.to) !== getAddress(crowd)) return est;
      let call: { functionName: string; args?: readonly unknown[] };
      try {
        call = decodeFunctionData({ abi: crowdAbi, data: a.data }) as never;
      } catch {
        return est;
      }
      if (call.functionName !== "deliver") return est;
      const [asset, bookId, user] = (call.args ?? []) as [Address, bigint, Address];
      if (getAddress(asset) !== getAddress(target.asset) || bookId !== target.bookId || getAddress(user) !== getAddress(target.user)) return est;
      const limit = (await l1GasOf(a.to, a.data)) + FAIL_EXEC_GAS;
      seen.limit = limit;
      return (limit * 10_000n) / 12_000n; // the Sender adds 20%
    },
  };
}

/**
 * One deliver-quiet pass with the keeper's key and code, in this process, whose deliver for `target` fails on
 * chain (failingDeliverIO). Everything else it does is the keeper's normal work.
 */
export async function failingDeliverPass(x: TCtx, target: DeliverTarget) {
  const keeper = x.A.keeper;
  const pub = x.r.pub;
  const seen: { limit?: bigint } = {};
  const l1GasOf = async (to: Address, data: Hex) => {
    const { result } = await pub.simulateContract({ account: keeper.address, address: NODE_INTERFACE, abi: nodeInterfaceAbi, functionName: "gasEstimateComponents", args: [to, false, data] });
    return BigInt(result[1]);
  };
  const io = failingDeliverIO(viemSenderIO(pub, keeper, TESTNET_CHAIN_ID), x.addr("crowdBuy"), target, l1GasOf, seen);
  const sender = new Sender(io, keeper.address, { pollMs: 1_000, waitMs: 120_000 });
  const notes: string[] = [];
  const ctx: Ctx = {
    chainId: TESTNET_CHAIN_ID,
    db: db().db,
    pub,
    account: keeper.address,
    sender,
    sealer: undefined as never, // deliver-quiet never seals
    dep: keeperDeployment(x.dep as never, TESTNET_CHAIN_ID),
    lookahead: 2,
    log: (m) => notes.push(m),
  };
  let error: string | undefined;
  let res;
  try {
    res = await runDeliverQuiet(ctx);
  } catch (e) {
    error = (e as Error).message.split("\n")[0];
  }
  return { res, error, limit: seen.limit, notes };
}

export type { Plan, Hex };
