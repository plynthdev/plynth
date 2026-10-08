// One keeper per chain + deployment. Two keepers on the same key would both sign from the same account: they race
// each other's nonces, and deliver-quiet's "decide from the transaction we stored" rule only holds when one process
// owns the rows it writes. The keeper takes a Postgres SESSION advisory lock at start; a second process on the same
// database, chain and deployment gets a clear error and exits. The lock lives as long as the database session, so
// it is released when the process exits or crashes (the server ends the session when its socket closes), and never
// needs a manual unlock.
import postgres from "postgres";
import { keccak256, stringToBytes, type Address } from "viem";

/** The advisory-lock key for (chain, deployment): the first 8 bytes of a hash, as a signed bigint (Postgres bigint). */
export function keeperLockKey(chainId: number, dep: { crowd: Address; vault: Address }): bigint {
  const h = keccak256(stringToBytes(`plynth-keeper:${chainId}:${dep.crowd.toLowerCase()}:${dep.vault.toLowerCase()}`));
  return BigInt.asIntN(64, BigInt(h.slice(0, 18)));
}

/** pg_locks shows a bigint advisory key as classid = high 32 bits, objid = low 32 bits (both unsigned), objsubid 1. */
export function lockParts(key: bigint): { classid: number; objid: number } {
  const u = BigInt.asUintN(64, key);
  return { classid: Number(u >> 32n), objid: Number(u & 0xffffffffn) };
}

export class KeeperLockHeld extends Error {
  constructor(
    readonly key: bigint,
    readonly holderPid: number | undefined,
    detail: string,
  ) {
    super(`another keeper already runs for this chain and deployment (advisory lock ${key}${holderPid ? `, held by database session pid ${holderPid}` : ""}${detail}); stop it first, or point this one at another deployment`);
    this.name = "KeeperLockHeld";
  }
}

export type KeeperLock = {
  key: bigint;
  /** The database session (backend pid) that holds the lock. */
  pid: () => number;
  /**
   * True while this process still holds the lock. If the session was lost (database restart, dropped socket), the
   * client reconnects and takes the lock again when it is free; false when another keeper took it meanwhile.
   */
  ensure: () => Promise<boolean>;
  release: () => Promise<void>;
};

const client = (url: string) =>
  // One dedicated connection that never idles out or retires: the lock is bound to it.
  postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {}, connection: { application_name: "plynth-keeper" } });

async function tryLock(sql: postgres.Sql, key: bigint): Promise<{ ok: boolean; pid: number }> {
  const [r] = await sql<{ ok: boolean; pid: number }[]>`select pg_try_advisory_lock(${key.toString()}::bigint) as ok, pg_backend_pid() as pid`;
  return { ok: !!r?.ok, pid: Number(r?.pid) };
}

async function holder(sql: postgres.Sql, key: bigint): Promise<{ pid?: number; detail: string }> {
  const { classid, objid } = lockParts(key);
  const [r] = await sql<{ pid: number; application_name: string | null; backend_start: Date | null }[]>`
    select l.pid, a.application_name, a.backend_start from pg_locks l left join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database())
      and l.classid::bigint = ${classid}::bigint and l.objid::bigint = ${objid}::bigint and l.objsubid = 1
    limit 1`;
  if (!r) return { detail: "" };
  return { pid: Number(r.pid), detail: `${r.application_name ? `, ${r.application_name}` : ""}${r.backend_start ? ` since ${new Date(r.backend_start).toISOString()}` : ""}` };
}

/** Takes the keeper lock or throws KeeperLockHeld. Never waits: a second keeper must not queue behind the first. */
export async function acquireKeeperLock(url: string, key: bigint): Promise<KeeperLock> {
  const sql = client(url);
  let pid: number;
  try {
    const r = await tryLock(sql, key);
    if (!r.ok) {
      const h = await holder(sql, key);
      throw new KeeperLockHeld(key, h.pid, h.detail);
    }
    pid = r.pid;
  } catch (err) {
    await sql.end({ timeout: 5 });
    throw err;
  }
  const { classid, objid } = lockParts(key);
  return {
    key,
    pid: () => pid,
    ensure: async () => {
      const [r] = await sql<{ held: boolean; pid: number }[]>`
        select exists(select 1 from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()
          and classid::bigint = ${classid}::bigint and objid::bigint = ${objid}::bigint and objsubid = 1) as held, pg_backend_pid() as pid`;
      if (r?.held) return true;
      const again = await tryLock(sql, key);
      if (again.ok) pid = again.pid;
      return again.ok;
    },
    release: async () => {
      await sql`select pg_advisory_unlock(${key.toString()}::bigint)`.catch(() => {});
      await sql.end({ timeout: 5 });
    },
  };
}
