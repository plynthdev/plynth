// The SDK's vault module (Hidden Vault notes and proofs) uses Node's Buffer; browsers do not have it.
import { Buffer } from "buffer";

const g = globalThis as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
