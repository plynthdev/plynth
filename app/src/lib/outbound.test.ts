// Audit (privileged / ops): webhook targets were not blocked from internal hosts, so a subscription or
// RISK_WEBHOOK_URLS entry could make the treasury services send signed requests to the server itself, its
// database, its private network or the cloud metadata address.
import { describe, expect, test } from "bun:test";
import { validateSubscription } from "@/treasury/webhooks/dispatcher";
import { Webhooks } from "@/treasury/risk/webhooks";
import { assertPublicDestination, assertPublicUrl, isInternalIp, OutboundBlocked, outboundFetch } from "./outbound";

const INTERNAL = [
  "http://127.0.0.1:5432/",
  "https://127.0.0.1/",
  "https://localhost/hook",
  "https://api.localhost/x",
  "https://db.internal/x",
  "https://printer.local/x",
  "https://postgres/x",
  "https://10.0.0.5/x",
  "https://172.20.1.1/x",
  "https://192.168.1.1/x",
  "https://169.254.169.254/latest/meta-data/",
  "https://100.64.0.1/x",
  "https://0.0.0.0/x",
  "https://[::1]/x",
  "https://[fd00::1]/x",
  "https://[fe80::1]/x",
  "https://[::ffff:127.0.0.1]/x",
  "https://[::ffff:a9fe:a9fe]/x", // 169.254.169.254, IPv4-mapped in hex
  "https://[64:ff9b::a00:1]/x", // NAT64 of 10.0.0.1
  "https://2130706433/x", // 127.0.0.1 as one number (URL normalises it)
  "https://0x7f.1/x",
];

describe("outbound webhook targets", () => {
  test("internal and local targets are refused at registration (subscriptions and env URL lists)", () => {
    for (const u of INTERNAL) {
      expect(() => assertPublicUrl(u), u).toThrow(OutboundBlocked);
      expect(() => validateSubscription(u, "0123456789abcdef", ["guard.denied"]), u).toThrow();
      expect(() => new Webhooks({ urls: [u] }), u).toThrow();
    }
    expect(() => assertPublicUrl("http://hooks.example.com/x")).toThrow(/https/);
    expect(() => assertPublicUrl("https://user:pw@hooks.example.com/x")).toThrow(/credentials/);
    expect(assertPublicUrl("https://hooks.example.com/x").hostname).toBe("hooks.example.com");
    expect(assertPublicUrl("https://[2606:4700::1111]/x").hostname).toBe("[2606:4700::1111]");
  });

  test("a public name that resolves inside is refused at send time; redirects are not followed", async () => {
    await expect(assertPublicDestination("https://evil.example/x", { resolve: async () => ["93.184.216.34", "10.1.2.3"] })).rejects.toThrow(/internal address 10.1.2.3/);
    await expect(assertPublicDestination("https://evil.example/x", { resolve: async () => ["::1"] })).rejects.toThrow(/internal/);
    await expect(assertPublicDestination("https://ok.example/x", { resolve: async () => ["93.184.216.34"] })).resolves.toEqual(["93.184.216.34"]); // the checked addresses, to connect to (I-4)
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => ((seen = init), new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }))) as unknown as typeof fetch;
    const r = await outboundFetch("https://ok.example/x", { method: "POST" }, { resolve: async () => ["93.184.216.34"], fetchImpl });
    expect(r.status).toBe(302);
    expect(seen?.redirect).toBe("manual");
  });

  test("a delivery to a rebinding host fails without the request ever being made", async () => {
    let called = 0;
    const wh = new Webhooks({ urls: ["https://rebind.example/x"], retries: 0, resolve: async () => ["127.0.0.1"], fetchImpl: (async () => (called++, new Response("ok"))) as unknown as typeof fetch });
    const [d] = await wh.emit({ type: "risk.alert", data: {} });
    expect(d!.ok).toBe(false);
    expect(d!.error).toMatch(/internal address 127.0.0.1/);
    expect(called).toBe(0);
  });

  test("allowPrivate (tests and local development) lets loopback through; isInternalIp", () => {
    expect(assertPublicUrl("http://127.0.0.1:9/x", { allowPrivate: true }).port).toBe("9");
    for (const ip of ["127.0.0.1", "10.0.0.1", "::1", "fc00::1", "::ffff:192.168.0.1", "255.255.255.255", "224.0.0.1", "2001:db8::1"]) expect(isInternalIp(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isInternalIp(ip), ip).toBe(false);
  });
});
