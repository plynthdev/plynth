// Review I-4 (open in v3 and v4): DNS rebinding in the webhook senders. outboundFetch checked the host's DNS answers,
// then fetch() resolved the name again for the connection, so a rebinding DNS server could answer a public address to
// the check and 127.0.0.1 / 169.254.169.254 to the connection. Now the name is resolved once, every answer is checked,
// and the request connects to the checked address (TLS SNI and the certificate check still use the hostname).
// A local TLS server with a throwaway certificate for hook.example.com stands in for the public host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundBlocked, outboundFetch } from "./outbound";

const PUBLIC = "93.184.216.34"; // what the "public" answer says; dialled as the local server below
let ca = "";
let server: ReturnType<typeof Bun.serve>;
const seen: { host: string | null; body: string; path: string }[] = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "plynth-pinned-"));
  const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k"), "-out", join(dir, "c"), "-days", "1", "-subj", "/CN=hook.example.com", "-addext", "subjectAltName=DNS:hook.example.com"], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  ca = readFileSync(join(dir, "c"), "utf8");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key: readFileSync(join(dir, "k"), "utf8"), cert: ca },
    fetch: async (req) => {
      const u = new URL(req.url);
      seen.push({ host: req.headers.get("host"), body: await req.text(), path: u.pathname });
      if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response("ok", { status: 200 });
    },
  });
});
afterAll(() => server?.stop(true));

const local = () => "127.0.0.1"; // dial: the checked public address is served by the local stand-in
const url = (path = "/hook") => `https://hook.example.com:${server.port}${path}`;

describe("I-4: one resolution, checked, then a connection to that address", () => {
  test("a hostname resolving to 127.0.0.1, 169.254.169.254, an IPv4-mapped loopback or a mix with a private address is refused before any connection", async () => {
    for (const answer of [["127.0.0.1"], ["169.254.169.254"], ["::ffff:127.0.0.1"], ["::1"], ["fe80::1"], [PUBLIC, "10.0.0.7"]]) {
      let dialled = false;
      const err = await outboundFetch(url(), { method: "POST", body: "x" }, { resolve: async () => answer, ca, dial: () => ((dialled = true), "127.0.0.1") }).catch((e) => e);
      expect(err, answer.join(",")).toBeInstanceOf(OutboundBlocked);
      expect(dialled).toBe(false);
    }
  });

  test("a rebind between check and connect cannot reach a private address: the name is resolved once and the checked address is dialled", async () => {
    let lookups = 0;
    const rebinding = async () => (lookups++ === 0 ? [PUBLIC] : ["127.0.0.1"]); // public to the check, private after
    const dialled: string[] = [];
    seen.length = 0;
    const r = await outboundFetch(url(), { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' }, { resolve: rebinding, ca, dial: (ip) => (dialled.push(ip), local()) });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(lookups).toBe(1); // no second resolution for the connection
    expect(dialled).toEqual([PUBLIC]); // the connection went to the address that was checked
    expect(seen).toEqual([{ host: `hook.example.com:${server.port}`, body: '{"a":1}', path: "/hook" }]);
  });

  test("the certificate is checked against the hostname (SNI), not the pinned address", async () => {
    const err = await outboundFetch(`https://other.example.com:${server.port}/hook`, { method: "POST", body: "x" }, { resolve: async () => [PUBLIC], ca, dial: local }).catch((e) => e);
    expect(String(err)).toMatch(/altnames|certificate|hostname/i);
    // and without the test CA, the self-signed certificate is not trusted at all
    const untrusted = await outboundFetch(url(), { method: "POST", body: "x" }, { resolve: async () => [PUBLIC], dial: local }).catch((e) => e);
    expect(untrusted).toBeInstanceOf(Error);
  });

  test("no redirects: a 302 to the metadata address comes back as is and is not followed", async () => {
    seen.length = 0;
    const r = await outboundFetch(url("/redirect"), { method: "POST", body: "x" }, { resolve: async () => [PUBLIC], ca, dial: local });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("169.254.169.254");
    expect(seen.map((s) => s.path)).toEqual(["/redirect"]);
  });
});
