// The SDK's vault module (Hidden Vault notes and proofs) uses Node's Buffer; browsers do not have it.
// Called explicitly: package.json says "sideEffects": false, so a bare `import "./polyfills"` had its assignment
// tree-shaken out of production builds (Buffer was never installed and Hidden Vault actions failed there).
import { Buffer } from "buffer";

export function installBuffer(): void {
  const g = globalThis as { Buffer?: typeof Buffer };
  g.Buffer ??= Buffer;
}
