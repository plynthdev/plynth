import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createDatabaseIfMissing, databaseName, DEFAULT_DATABASE_URL, dropDatabase, runMigrations, withDatabase } from "../src";
import { createTestDb } from "../src/testing";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb("db");
});
afterAll(async () => {
  await t.drop();
});

const cols = async (table: string) =>
  (await t.sql`select column_name from information_schema.columns where table_name = ${table} order by ordinal_position`).map((r) => r.column_name);

describe("packages/db", () => {
  test("default DATABASE_URL is plynth_dev on localhost", () => {
    expect(databaseName(DEFAULT_DATABASE_URL)).toBe("plynth_dev");
    expect(withDatabase(DEFAULT_DATABASE_URL, "x")).toBe("postgres://localhost:5432/x");
  });

  test("migrate creates ev_cursors and ev_logs with the specified columns and created_at", async () => {
    expect(await cols("ev_cursors")).toEqual(expect.arrayContaining(["stream", "contract", "last_block", "last_block_hash", "created_at"]));
    expect(await cols("ev_logs")).toEqual(
      expect.arrayContaining(["chain_id", "block_number", "block_hash", "tx_hash", "log_index", "address", "topic0", "data_json", "created_at"]),
    );
  });

  test("ev_logs primary key is (chain_id, tx_hash, log_index); ev_cursors pk is stream", async () => {
    const pk = async (table: string) =>
      (
        await t.sql`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = ${table}::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`
      ).map((r) => r.attname);
    expect(await pk("ev_logs")).toEqual(["chain_id", "tx_hash", "log_index"]);
    expect(await pk("ev_cursors")).toEqual(["stream"]);
  });

  test("indexer, keeper and treasury tables exist; every table is owner-prefixed (ev_, keeper_, treasury_, eligibility_, roundup_) or a named treasury table", async () => {
    const tables = (await t.sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`).map((r) => r.table_name);
    // Treasury-lane tables that predate the owner-prefix rule (OWNER: treasury in src/schema).
    const treasuryTables = ["desk_actions", "closes", "jury_verdicts", "exceptions", "venue_fills"];
    expect(tables).toEqual(expect.arrayContaining(["eligibility_decisions", "ev_cursors", "ev_logs", "keeper_hidden_deliveries", "keeper_jobs", "keeper_roundups", "roundup_events", "roundup_sources", "treasury_webhooks", "treasury_webhook_deliveries", "treasury_webhook_cursors", ...treasuryTables]));
    for (const name of tables) if (!treasuryTables.includes(name)) expect(name).toMatch(/^(ev|keeper|treasury|eligibility|roundup)_/);
  });

  test("migrate is idempotent", async () => {
    await runMigrations(t.url);
    const n = await t.sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(n[0]!.n).toBe(readdirSync(join(import.meta.dir, "..", "migrations")).filter((f) => f.endsWith(".sql")).length);
  });

  test("db:create is idempotent and refuses unsafe names", async () => {
    expect(await createDatabaseIfMissing(t.url)).toBe(false);
    await expect(createDatabaseIfMissing(withDatabase(t.url, 'x"; drop database y; --'))).rejects.toThrow(/unsafe/);
    await expect(dropDatabase(withDatabase(t.url, "Bad-Name"))).rejects.toThrow(/unsafe/);
  });

  test("every schema file names its owner at the top", () => {
    const dir = join(import.meta.dir, "..", "src", "schema");
    for (const f of readdirSync(dir).filter((f) => f !== "index.ts")) {
      expect(readFileSync(join(dir, f), "utf8").split("\n")[0]).toMatch(/^\/\/ OWNER: /);
    }
  });

  test("test database is really dropped", async () => {
    const tmp = await createTestDb("drop");
    await tmp.drop();
    const admin = postgres(withDatabase(t.url, "postgres"), { max: 1 });
    const rows = await admin`select 1 from pg_database where datname = ${tmp.name}`;
    await admin.end();
    expect(rows.length).toBe(0);
  });
});
