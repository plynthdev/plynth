// bun run smoke [API_URL]   (default http://127.0.0.1:8789)
//
// Hits every GET route of a running API (src/api/app.ts) and checks the response shape: a JSON object, never a
// 5xx. Routes that need an account or a row are called with an address that has none, so a structured 4xx
// ({ error: { code, message } }) is a pass too. POST routes build transactions or verify proofs and are covered
// by the test suite; here they are only checked to reject an empty body with a structured 4xx.
import { REST as REST_ROUTES } from "@/api/app";

const base = (process.argv[2] ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const NOBODY = "0x000000000000000000000000000000000000dEaD";
const params: Record<string, string> = { address: NOBODY, account: NOBODY, hour: "0", actionId: "0", id: "0", index: "0", periodEnd: "0" };
const query: Record<string, string> = { "/v1/proofs/nonce": `?verifier=${NOBODY}&requestId=0x${"00".repeat(32)}` };

type Result = { route: string; status: number; ok: boolean; why?: string };
const results: Result[] = [];

for (const r of REST_ROUTES) {
  const path = r.path.replace(/:(\w+)/g, (_m, k: string) => params[k] ?? "0") + (query[r.path] ?? "");
  const route = `${r.method} ${r.path}`;
  try {
    const res = await fetch(`${base}${path}`, r.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {});
    const body = (await res.json().catch(() => undefined)) as unknown;
    const isObject = typeof body === "object" && body !== null;
    const structuredError = isObject && typeof (body as { error?: { code?: unknown } }).error?.code === "string";
    let ok = isObject && res.status < 500;
    if (r.method === "POST") ok = ok && res.status >= 400 && structuredError;
    else if (res.status >= 400) ok = ok && structuredError;
    if (r.path === "/v1/meta/health") ok = isObject && (res.status === 200 || res.status === 503);
    results.push({ route, status: res.status, ok, ...(ok ? {} : { why: JSON.stringify(body)?.slice(0, 200) ?? "no JSON body" }) });
  } catch (e) {
    results.push({ route, status: 0, ok: false, why: e instanceof Error ? e.message : String(e) });
  }
}

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.status} ${r.route}${r.why ? ` ${r.why}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`smoke: ${results.length - failed}/${results.length} routes ok against ${base}`);
process.exit(failed ? 1 : 0);
