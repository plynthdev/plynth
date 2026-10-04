export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/plynth_dev";

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
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
