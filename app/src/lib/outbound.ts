// Outbound HTTP targets (webhooks) must be public hosts (audit, privileged/ops). A webhook URL is chosen by whoever
// runs the operator CLI or sets RISK_WEBHOOK_URLS / TREASURY_WEBHOOK_URLS; without this a URL like
// http://127.0.0.1:5432/ or http://169.254.169.254/ (cloud metadata) would make the treasury services send signed
// requests into the server itself or its private network.
//   - registration / startup: https only, and the host may not be localhost, *.localhost, *.local, *.internal or a
//     literal private, loopback, link-local, CGNAT, multicast or documentation address;
//   - every send: the host's DNS answers are checked the same way (a public name pointing inside is refused) and
//     redirects are not followed.
// `allowPrivate` (tests, local development) permits loopback / private targets, http included.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class OutboundBlocked extends Error {}

const v4 = (ip: string) => ip.split(".").map(Number) as [number, number, number, number];
const inV4 = (ip: string, base: string, bits: number) => {
  const toInt = (a: string) => v4(a).reduce((x, o) => ((x << 8) | o) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
};
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Expands an IPv6 address to 8 numeric groups (handles :: and an embedded IPv4 tail). */
function v6Groups(ip: string): number[] {
  let a = ip.toLowerCase().split("%")[0]!;
  const tail = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [p, q, r, s] = v4(tail[1]!);
    a = `${a.slice(0, -tail[1]!.length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const [l, r] = a.includes("::") ? (a.split("::") as [string, string]) : [a, undefined];
  const left = l ? l.split(":") : [];
  const right = r === undefined ? [] : r ? r.split(":") : [];
  const fill = r === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g || "0", 16));
}

/** True for any address a server must not send webhooks to (private, loopback, link-local, reserved, ...). */
export function isInternalIp(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  const a = ip.replace(/^\[|\]$/g, "");
  if (kind === 4) return V4_BLOCKED.some(([b, n]) => inV4(a, b, n)) || a === "255.255.255.255";
  if (kind !== 6) return true; // not an address at all: refuse
  const g = v6Groups(a);
  const embedded = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isInternalIp(embedded()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isInternalIp(embedded()); // NAT64
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (deprecated compatible)
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  return false;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Registration-time check of a webhook URL. Throws OutboundBlocked with the reason. */
export function assertPublicUrl(url: string, opts: { allowPrivate?: boolean | undefined } = {}): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OutboundBlocked(`bad webhook url ${url}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host) !== 0;
  const internal = literal ? isInternalIp(host) : LOCAL_NAME.test(host) || !host.includes(".");
  if (opts.allowPrivate) {
    if (u.protocol === "https:" || (u.protocol === "http:" && (internal || host === "localhost"))) return u;
    throw new OutboundBlocked("webhook url must be https (http only for localhost)");
  }
  if (u.protocol !== "https:") throw new OutboundBlocked("webhook url must be https");
  if (u.username || u.password) throw new OutboundBlocked("webhook url must not carry credentials");
  if (internal) throw new OutboundBlocked(`webhook host ${host} is local or internal: refused`);
  return u;
}

export type Resolver = (host: string) => Promise<string[]>;
const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Send-time check: the URL passes assertPublicUrl and every address its host resolves to is public. */
export async function assertPublicDestination(url: string, opts: { allowPrivate?: boolean | undefined; resolve?: Resolver } = {}): Promise<void> {
  const u = assertPublicUrl(url, opts);
  if (opts.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await (opts.resolve ?? dnsResolver)(host);
  if (addrs.length === 0) throw new OutboundBlocked(`webhook host ${host} does not resolve`);
  const bad = addrs.find(isInternalIp);
  if (bad) throw new OutboundBlocked(`webhook host ${host} resolves to internal address ${bad}: refused`);
}

/**
 * fetch for webhooks: checks the destination first (unless allowPrivate), never follows a redirect (a 3xx is
 * returned as is, so a public URL cannot bounce the request inside).
 */
export async function outboundFetch(url: string, init: RequestInit, opts: { allowPrivate?: boolean | undefined; resolve?: Resolver; fetchImpl?: typeof fetch } = {}): Promise<Response> {
  await assertPublicDestination(url, opts);
  return (opts.fetchImpl ?? fetch)(url, { ...init, redirect: "manual" });
}
