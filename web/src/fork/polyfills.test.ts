// The Buffer polyfill is installed by an explicit call: with "sideEffects": false a bare import was tree-shaken out of
// production builds, and the Hidden Vault (keys, notes, statements, proofs) failed with "Buffer is not defined".
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installBuffer } from "./polyfills";

const g = globalThis as { Buffer?: unknown };
const saved = g.Buffer;
afterEach(() => {
  g.Buffer = saved;
});

describe("Buffer polyfill", () => {
  it("installBuffer() puts Buffer on globalThis when the browser has none, and keeps an existing one", () => {
    delete g.Buffer;
    installBuffer();
    expect(typeof (g.Buffer as { from?: unknown }).from).toBe("function");
    const mine = { from: () => 1 };
    g.Buffer = mine;
    installBuffer();
    expect(g.Buffer).toBe(mine);
  });

  it("every loader of the SDK's Buffer-using modules calls it (a bare import would be dropped)", () => {
    const src = readFileSync(resolve(__dirname, "actions.ts"), "utf8");
    expect(src).not.toMatch(/await import\("\.\/polyfills"\);/);
    expect(src.match(/\(await import\("\.\/polyfills"\)\)\.installBuffer\(\)/g)?.length).toBeGreaterThanOrEqual(1);
  });
});
