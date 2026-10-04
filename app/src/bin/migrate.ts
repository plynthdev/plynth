import { databaseName, databaseUrl, runMigrations } from "@/db";

const url = databaseUrl();
await runMigrations(url);
console.log(`db:migrate ${databaseName(url)}: up to date`);
