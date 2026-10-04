import { expect, test } from "bun:test";
import { serveHealth } from "./health";

test("serveHealth answers GET /health with the service name and its status, 404 elsewhere", async () => {
  let passes = 0;
  const s = serveHealth("treasury-marks", 0, () => ({ passes }));
  try {
    passes = 3;
    const r = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: "treasury-marks", passes: 3 });
    expect((await fetch(`http://127.0.0.1:${s.port}/other`)).status).toBe(404);
  } finally {
    s.stop(true);
  }
});
