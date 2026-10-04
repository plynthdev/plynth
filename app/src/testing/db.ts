import { configValue } from "@/config";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";

/** Fresh, migrated database on the DATABASE_URL server, named <prefix><label>_... where prefix is
 *  PLYNTH_TEST_DB_PREFIX (default plynth_test_) so parallel lanes can keep to their own namespace. Call drop() after. */
export async function createTestDb(label = "run") {
  const prefix = configValue("PLYNTH_TEST_DB_PREFIX");
  const name = `${prefix}${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const url = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(url);
  await runMigrations(url);
  const conn = connect(url);
  return {
    url,
    name,
    ...conn,
    drop: async () => {
      await conn.close();
      await dropDatabase(url);
    },
  };
}
