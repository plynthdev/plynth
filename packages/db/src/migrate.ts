import { databaseName, databaseUrl, runMigrations } from "./index";

const url = databaseUrl();
await runMigrations(url);
console.log(`db:migrate ${databaseName(url)}: up to date`);
