// Beacon secrets at rest: AES-256-GCM under KEEPER_SECRET_KEY, bound to the job key as associated data
// (a ciphertext copied onto another row does not decrypt). Format: v1.<iv b64>.<ciphertext+tag b64>.
import { hexToBytes, isHex, type Hex } from "viem";

const VERSION = "v1";

function b64(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}
function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** KEEPER_SECRET_KEY: 32 bytes as 0x-hex or base64. Anything else is refused (no silent weak key). */
export function parseSecretKey(raw: string | undefined): Uint8Array {
  if (!raw) throw new Error("KEEPER_SECRET_KEY is not set (32 bytes, 0x-hex or base64)");
  const s = raw.trim();
  const bytes = isHex(s) ? hexToBytes(s as Hex) : unb64(s);
  if (bytes.length !== 32) throw new Error(`KEEPER_SECRET_KEY must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

export class Sealer {
  private constructor(private readonly key: CryptoKey) {}

  static async create(rawKey: Uint8Array): Promise<Sealer> {
    if (rawKey.length !== 32) throw new Error("sealing key must be 32 bytes");
    const key = await crypto.subtle.importKey("raw", new Uint8Array(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return new Sealer(key);
  }

  async seal(plain: Uint8Array, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, this.key, new Uint8Array(plain));
    return `${VERSION}.${b64(iv)}.${b64(new Uint8Array(ct))}`;
  }

  /** Throws on a wrong key, a wrong aad or any tampering (GCM tag check). */
  async open(sealed: string, aad: string): Promise<Uint8Array> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== VERSION || !iv || !ct) throw new Error("unknown sealed secret format");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(unb64(iv)), additionalData: new TextEncoder().encode(aad) }, this.key, new Uint8Array(unb64(ct)));
    return new Uint8Array(pt);
  }
}

/** A fresh 32-byte beacon secret from the platform CSPRNG. */
export function newSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
