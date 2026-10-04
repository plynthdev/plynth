// GET /health for a long-running service on its own port (config.ts DEFAULT_PORTS). Loop services that have no
// HTTP API of their own (the treasury services) use this so a supervisor can probe them the same way.
export function serveHealth(service: string, port: number, status: () => Record<string, unknown> = () => ({})) {
  return Bun.serve({
    port,
    fetch: (req) =>
      new URL(req.url).pathname === "/health" ? Response.json({ ok: true, service, ...status() }) : new Response("not found", { status: 404 }),
  });
}
