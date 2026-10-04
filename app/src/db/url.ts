import { configValue, DEFAULT_DATABASE_URL } from "@/config";

export { DEFAULT_DATABASE_URL };

export function databaseUrl(): string {
  return configValue("DATABASE_URL");
}

/** Same server, different database name (used to reach the `postgres` maintenance db or a test db). */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}
