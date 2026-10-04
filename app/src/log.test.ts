import { expect, test } from "bun:test";
import { createLogger, safeErrorSummary, stringifySafe } from "./log";

test("safeErrorSummary strips URLs, 32-byte hex values and secret=value pairs", () => {
  const e = new Error(`fetch https://rpc.example/v2/abc failed; key 0x${"cd".repeat(32)}; secret=hunter2, token: t0k`);
  const s = safeErrorSummary(e);
  expect(s.name).toBe("Error");
  expect(s.message).not.toContain("rpc.example");
  expect(s.message).not.toContain("cd".repeat(32));
  expect(s.message).not.toContain("hunter2");
  expect(s.message).not.toContain("t0k");
});

test("stringifySafe writes bigints as decimal strings", () => {
  expect(stringifySafe({ a: 10n ** 30n })).toBe('{"a":"1000000000000000000000000000000"}');
});

test("createLogger prefixes the service and respects the level", () => {
  const out: string[] = [];
  const orig = console.log;
  console.log = (m: string) => void out.push(m);
  try {
    createLogger("keeper", "warn").info("hidden");
    createLogger("keeper", "info").info("shown", { n: 1n });
  } finally {
    console.log = orig;
  }
  expect(out).toEqual(['[keeper] shown {"n":"1"}']);
});
