// The bytecode comparison masks only immutables and library slots: any other byte difference is a mismatch.
import { describe, expect, test } from "bun:test";
import { masked, SOURCES } from "./verify-explorer";

describe("verify-explorer", () => {
  test("masking zeroes exactly the given ranges", () => {
    expect(masked("0x11223344556677", [{ start: 1, length: 2 }])).toBe("11000044556677");
    expect(masked("0xaabb", [])).toBe("aabb");
  });

  test("an immutable difference is ignored, a code difference is not", () => {
    const refs = [{ start: 2, length: 2 }];
    expect(masked("0x6080beef00", refs)).toBe(masked("0x6080000000", refs));
    expect(masked("0x6081beef00", refs)).not.toBe(masked("0x6080000000", refs));
  });

  test("every source id names a contract file under src/", () => {
    for (const id of Object.values(SOURCES)) expect(id).toMatch(/^src\/[\w/]+\.sol:\w+$/);
  });
});
