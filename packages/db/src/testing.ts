import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "./index";

/** Fresh, migrated plynth_test_* database on the DATABASE_URL server. Call drop() after. */
export async function createTestDb(label = "run") {
  const name = `plynth_test_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
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
