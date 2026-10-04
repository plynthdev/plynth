import { defineConfig } from "drizzle-kit";
import { configValue } from "./src/config";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: configValue("DATABASE_URL") },
});
