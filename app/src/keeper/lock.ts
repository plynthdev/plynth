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
   * lock is taken again on a fresh connection when it is free; false when another keeper took it meanwhile. Throws
   * when the database cannot be reached (the caller skips the pass and asks again next time). Never hangs: every
   * query has a deadline.
   */
  ensure: () => Promise<boolean>;
  release: () => Promise<void>;
};

export type KeeperLockOptions = {
  /** Deadline for each lock query (ms). postgres.js can leave a query unanswered forever after its socket dropped. */
  queryTimeoutMs?: number;
  /** How long a re-take waits for our own dropped session to leave the server before giving up for this pass (ms). */
  retakeWaitMs?: number;
  /** Opens the dedicated connection (tests wrap it). */
  connect?: (url: string) => postgres.Sql;
};

const client = (url: string) =>
  // One dedicated connection that never idles out or retires: the lock is bound to it.
  postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {}, connection: { application_name: "plynth-keeper" } });

class LockQueryTimeout extends Error {
  constructor(ms: number) {
    super(`keeper lock query got no answer within ${ms} ms`);
    this.name = "LockQueryTimeout";
  }
}

/** The query or a timeout, whichever first. The losing query is settled later by ending its client. */
async function within<T>(ms: number, q: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(q), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LockQueryTimeout(ms)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drops a client without waiting on it: a stuck connection is destroyed, its pending queries rejected. */
function discard(sql: postgres.Sql) {
  sql.end({ timeout: 0 }).catch(() => {});
}

async function tryLock(sql: postgres.Sql, key: bigint, ms: number): Promise<{ ok: boolean; pid: number }> {
  const [r] = await within(ms, sql<{ ok: boolean; pid: number }[]>`select pg_try_advisory_lock(${key.toString()}::bigint) as ok, pg_backend_pid() as pid`);
  return { ok: !!r?.ok, pid: Number(r?.pid) };
}

async function holder(sql: postgres.Sql, key: bigint, ms: number): Promise<{ pid?: number; detail: string }> {
  const { classid, objid } = lockParts(key);
  const [r] = await within(
    ms,
    sql<{ pid: number; application_name: string | null; backend_start: Date | null }[]>`
    select l.pid, a.application_name, a.backend_start from pg_locks l left join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database())
      and l.classid::bigint = ${classid}::bigint and l.objid::bigint = ${objid}::bigint and l.objsubid = 1
    limit 1`,
  );
  if (!r) return { detail: "" };
  return { pid: Number(r.pid), detail: `${r.application_name ? `, ${r.application_name}` : ""}${r.backend_start ? ` since ${new Date(r.backend_start).toISOString()}` : ""}` };
}

/** Takes the keeper lock or throws KeeperLockHeld. Never waits: a second keeper must not queue behind the first. */
export async function acquireKeeperLock(url: string, key: bigint, opts: KeeperLockOptions = {}): Promise<KeeperLock> {
  const ms = opts.queryTimeoutMs ?? 15_000;
  const retakeWaitMs = opts.retakeWaitMs ?? 10_000;
  const open = opts.connect ?? client;
  let sql = open(url);
  let pid: number;
  try {
    const r = await tryLock(sql, key, ms);
    if (!r.ok) {
      const h = await holder(sql, key, ms);
      throw new KeeperLockHeld(key, h.pid, h.detail);
    }
    pid = r.pid;
  } catch (err) {
    discard(sql);
    throw err;
  }
  const { classid, objid } = lockParts(key);

  /** Still held on the current connection? Throws when the connection is broken or does not answer. */
  const check = async () => {
    const [r] = await within(
      ms,
      sql<{ held: boolean }[]>`
        select exists(select 1 from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()
          and classid::bigint = ${classid}::bigint and objid::bigint = ${objid}::bigint and objsubid = 1) as held`,
    );
    return !!r?.held;
  };

  /**
   * Take the lock again, on a fresh connection when the current one is broken. While the holder is still our old
   * session (killed, or its socket closed, but the server has not removed it yet) wait for it to leave; any other
   * holder is another keeper.
   */
  const retake = async (fresh: boolean): Promise<boolean> => {
    const old = pid;
    if (fresh) {
      discard(sql);
      sql = open(url);
    }
    const deadline = Date.now() + retakeWaitMs;
    for (;;) {
      const r = await tryLock(sql, key, ms);
      if (r.ok) {
        pid = r.pid;
        return true;
      }
      const h = await holder(sql, key, ms);
      if (h.pid !== undefined && h.pid !== old) return false;
      if (Date.now() >= deadline) throw new Error(`keeper lock ${key} is still held by our previous database session pid ${old} after ${retakeWaitMs} ms`);
      await Bun.sleep(100);
    }
  };

  let broken = false;
  return {
    key,
    pid: () => pid,
    ensure: async () => {
      try {
        let held: boolean | undefined;
        if (!broken) {
          try {
            held = await check();
          } catch {
            // dropped socket or no answer: a fresh connection below
          }
          if (held) return true;
        }
        // held === false: the connection works but this session lost the lock (postgres.js reconnected after the
        // old session dropped, or someone unlocked it): take it again on this connection.
        const ok = await retake(held === undefined);
        broken = false;
        return ok;
      } catch (err) {
        broken = true; // next time: straight to a fresh connection
        throw err;
      }
    },
    release: async () => {
      await within(ms, sql`select pg_advisory_unlock(${key.toString()}::bigint)`).catch(() => {});
      await within(ms, sql.end({ timeout: 5 })).catch(() => discard(sql));
    },
  };
}
