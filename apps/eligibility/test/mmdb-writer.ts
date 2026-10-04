// Minimal MaxMind DB (MMDB v2) writer for test fixtures: an IPv6 tree (IPv4 under ::/96), 24-bit records,
// country records shaped like db-ip / GeoLite2 ({country: {iso_code}}). Enough for mmdb-lib to read.

type Val = string | number | bigint | Val[] | { [k: string]: Val };

function ctrl(type: number, size: number, body: Buffer): Buffer {
  const ext = type > 7;
  const typeBits = ext ? 0 : type;
  const head: number[] = [];
  let sizeBits: number;
  const extra: number[] = [];
  if (size < 29) sizeBits = size;
  else if (size < 29 + 256) (sizeBits = 29), extra.push(size - 29);
  else if (size < 285 + 65536) (sizeBits = 30), extra.push((size - 285) >> 8, (size - 285) & 0xff);
  else throw new Error("too big");
  head.push((typeBits << 5) | sizeBits);
  if (ext) head.push(type - 7);
  return Buffer.concat([Buffer.from(head), Buffer.from(extra), body]);
}

function uintBytes(n: bigint): Buffer {
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.from(out);
}

export function encode(v: Val, uintType: "u16" | "u32" | "u64" = "u32"): Buffer {
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return ctrl(2, b.length, b);
  }
  if (typeof v === "number" || typeof v === "bigint") {
    const b = uintBytes(BigInt(v));
    return ctrl(uintType === "u16" ? 5 : uintType === "u32" ? 6 : 9, b.length, b);
  }
  if (Array.isArray(v)) return ctrl(11, v.length, Buffer.concat(v.map((x) => encode(x))));
  const keys = Object.keys(v);
  return ctrl(7, keys.length, Buffer.concat(keys.flatMap((k) => [encode(k), encode(v[k]!)])));
}

function ipv4Bits(cidr: string): number[] {
  const [ip, len] = cidr.split("/");
  const n = ip!.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
  const bits: number[] = Array(96).fill(0);
  for (let i = 31; i >= 0; i--) bits.push(Number((n >> BigInt(i)) & 1n));
  return bits.slice(0, 96 + Number(len));
}

type Node = { kids: [Node | number | null, Node | number | null] };

/** networks: IPv4 CIDR -> ISO country code. Returns the .mmdb bytes. */
export function buildCountryMmdb(networks: Record<string, string>): Buffer {
  const datas: Buffer[] = [];
  const dataOffset: number[] = [];
  let off = 0;
  const root: Node = { kids: [null, null] };
  for (const [cidr, iso] of Object.entries(networks)) {
    const d = encode({ country: { iso_code: iso } });
    dataOffset.push(off);
    datas.push(d);
    off += d.length;
    const bits = ipv4Bits(cidr);
    let n = root;
    for (let i = 0; i < bits.length - 1; i++) {
      const b = bits[i]!;
      const k = n.kids[b];
      if (k === null || typeof k === "number") n.kids[b] = { kids: [k, k] }; // split an existing leaf
      n = n.kids[b] as Node;
    }
    n.kids[bits[bits.length - 1]!] = -(dataOffset.length); // leaf marker (1-based, negative)
  }
  // number nodes breadth-first
  const nodes: Node[] = [];
  const q: Node[] = [root];
  while (q.length) {
    const n = q.shift()!;
    nodes.push(n);
    for (const k of n.kids) if (k && typeof k === "object") q.push(k);
  }
  const index = new Map(nodes.map((n, i) => [n, i]));
  const count = nodes.length;
  const rec = (k: Node | number | null): number => {
    if (k === null) return count;
    if (typeof k === "number") return count + 16 + dataOffset[-k - 1]!;
    return index.get(k)!;
  };
  const tree = Buffer.alloc(count * 6);
  nodes.forEach((n, i) => {
    tree.writeUIntBE(rec(n.kids[0]), i * 6, 3);
    tree.writeUIntBE(rec(n.kids[1]), i * 6 + 3, 3);
  });
  const meta = Buffer.concat([
    ctrl(7, 9, Buffer.alloc(0)),
    encode("node_count"), encode(count, "u32"),
    encode("record_size"), encode(24, "u16"),
    encode("ip_version"), encode(6, "u16"),
    encode("database_type"), encode("DBIP-Country-Lite"),
    encode("languages"), encode(["en"]),
    encode("binary_format_major_version"), encode(2, "u16"),
    encode("binary_format_minor_version"), encode(0, "u16"),
    encode("build_epoch"), encode(1_790_000_000n, "u64"),
    encode("description"), encode({ en: "test fixture" }),
  ]);
  return Buffer.concat([tree, Buffer.alloc(16), ...datas, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com"), meta]);
}
