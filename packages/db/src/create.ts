import { createDatabaseIfMissing, databaseName, databaseUrl } from "./index";

const url = databaseUrl();
const created = await createDatabaseIfMissing(url);
console.log(`db:create ${databaseName(url)}: ${created ? "created" : "already exists"}`);
