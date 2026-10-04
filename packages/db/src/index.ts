import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { join } from "node:path";
import * as schema from "./schema";
import { databaseName, databaseUrl, withDatabase } from "./url";

export * from "./schema";
export { databaseUrl, databaseName, withDatabase, DEFAULT_DATABASE_URL } from "./url";
export { schema };

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export function connect(url = databaseUrl(), opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { sql, db, close: () => sql.end({ timeout: 5 }) };
}
export type Db = ReturnType<typeof connect>["db"];

const SAFE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** createdb if missing. Returns true if it created the database. */
export async function createDatabaseIfMissing(url = databaseUrl()): Promise<boolean> {
  const name = databaseName(url);
  if (!SAFE_NAME.test(name)) throw new Error(`refusing unsafe database name: ${name}`);
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length) return false;
    await admin.unsafe(`create database "${name}"`);
    return true;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export async function dropDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  if (!SAFE_NAME.test(name)) throw new Error(`refusing unsafe database name: ${name}`);
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export async function runMigrations(url = databaseUrl()): Promise<void> {
  const { db, close } = connect(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await close();
  }
}
