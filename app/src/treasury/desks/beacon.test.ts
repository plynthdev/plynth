import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beaconKey, beaconSteps, commitmentOf, dayStart, DAY, secretFor, type BeaconState } from "./beacon";

const ACC = "0x00000000000000000000000000000000000000a1" as const;
const GRACE = 3600n;
const empty: BeaconState = { windowStart: 0n, windowEnd: 0n, executeAt: 0n, commitment: zeroHash };

describe("one commit/reveal per period day", () => {
  test("dayStart floors to UTC midnight", () => {
    expect(dayStart(1_800_000_123n)).toBe(1_799_971_200n);
    expect(dayStart(1_799_971_200n)).toBe(1_799_971_200n);
  });

  test("keys differ per day and per account", () => {
    expect(beaconKey(ACC, 0n)).not.toBe(beaconKey(ACC, DAY));
    expect(beaconKey(ACC, 0n)).not.toBe(beaconKey("0x00000000000000000000000000000000000000a2", 0n));
  });

  test("commitment matches JitterBeacon: keccak256(abi.encode(secret, key))", () => {
    const s = keccak256("0x01");
    const k = keccak256("0x02");
    expect(commitmentOf(s, k)).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [s, k])));
  });

  test("the secret is re-derivable from the desk key and differs per key", async () => {
    const a = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // test-key (anvil #1)
    const sign = (k: Hex) => a.signMessage({ message: { raw: k } });
    const k1 = beaconKey(ACC, 0n);
    expect(await secretFor(sign, k1)).toBe(await secretFor(sign, k1));
    expect(await secretFor(sign, k1)).not.toBe(await secretFor(sign, beaconKey(ACC, DAY)));
  });

  test("commits tomorrow's window when it is not committed yet", () => {
    const now = 1_800_000_000n;
    const steps = beaconSteps(now, GRACE, { key: "0x01", b: empty }, { key: "0x02", b: empty });
    expect(steps).toEqual([{ kind: "commit", key: "0x02", windowStart: dayStart(now) + DAY, windowEnd: dayStart(now) + 2n * DAY }]);
  });

  test("reveals today's window once open and before windowEnd - GRACE; never twice", () => {
    const start = 1_799_971_200n;
    const today: BeaconState = { windowStart: start, windowEnd: start + DAY, executeAt: 0n, commitment: keccak256("0x01") };
    const tomorrow: BeaconState = { ...today, windowStart: start + DAY, windowEnd: start + 2n * DAY };
    expect(beaconSteps(start + 60n, GRACE, { key: "0x01", b: today }, { key: "0x02", b: tomorrow })).toEqual([{ kind: "reveal", key: "0x01" }]);
    expect(beaconSteps(start + DAY - GRACE, GRACE, { key: "0x01", b: today }, { key: "0x02", b: tomorrow })).toEqual([]);
    expect(beaconSteps(start + 60n, GRACE, { key: "0x01", b: { ...today, executeAt: start + 99n } }, { key: "0x02", b: tomorrow })).toEqual([]);
  });

  test("S5: waits for the execution time before revealing (an early reveal would publish it)", () => {
    const start = 1_799_971_200n;
    const today: BeaconState = { windowStart: start, windowEnd: start + DAY, executeAt: 0n, commitment: keccak256("0x01") };
    const tomorrow: BeaconState = { ...today, windowStart: start + DAY, windowEnd: start + 2n * DAY };
    const revealAt = start + 5000n;
    expect(beaconSteps(revealAt - 1n, GRACE, { key: "0x01", b: today, revealAt }, { key: "0x02", b: tomorrow })).toEqual([]);
    expect(beaconSteps(revealAt, GRACE, { key: "0x01", b: today, revealAt }, { key: "0x02", b: tomorrow })).toEqual([{ kind: "reveal", key: "0x01" }]);
  });
});
