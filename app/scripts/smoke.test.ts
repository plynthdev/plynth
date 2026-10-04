// The smoke script's verdicts, against stand-in servers: structured answers pass, a 5xx or a non-JSON body fails.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { REST } from "@/api/app";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

// Async spawn: the stand-in server runs in this process, so a blocking spawnSync would deadlock it.
const smoke = async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "smoke.ts"), `http://127.0.0.1:${server!.port}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
};
const notFound = () => Response.json({ error: { code: "NOT_FOUND", message: "no such account" } }, { status: 404 });
const badRequest = () => Response.json({ error: { code: "BAD_REQUEST", message: "bad input" } }, { status: 400 });

test("every route answered with a JSON object or a structured 4xx: exit 0, one line per route", async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (req.method === "POST" ? badRequest() : new URL(req.url).pathname === "/v1/meta/health" ? Response.json({ ok: true }) : notFound()),
  });
  const r = await smoke();
  expect(r.code).toBe(0);
  expect(r.out).toContain(`smoke: ${REST.length}/${REST.length} routes ok`);
  for (const p of REST) expect(r.out).toContain(`${p.method} ${p.path}`);
}, 30_000);

test("a 5xx or a non-JSON body on any route fails the run and names the route", async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/crowd/books") return Response.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "internal error" } }, { status: 500 });
      if (path === "/v1/meta/eligibility") return new Response("<html>", { status: 200 });
      return req.method === "POST" ? badRequest() : notFound();
    },
  });
  const r = await smoke();
  expect(r.code).toBe(1);
  expect(r.out).toContain("FAIL 500 GET /v1/crowd/books");
  expect(r.out).toContain("FAIL 200 GET /v1/meta/eligibility");
}, 30_000);
