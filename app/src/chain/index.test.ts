import { expect, test } from "bun:test";
import { getAddress } from "viem";
import { contracts, stockTokens, robinhood, robinhoodTestnet } from "./index";

test("chain ids match the docs", () => {
  expect(robinhood.id).toBe(4663);
  expect(robinhoodTestnet.id).toBe(46630);
});

test("every address is a valid address", () => {
  const all = [...Object.values(contracts.mainnet), ...Object.values(contracts.testnet), ...Object.values(stockTokens)];
  for (const a of all) if (a) expect(() => getAddress(a)).not.toThrow();
});

import { feeds, v4Pools, poolId, usdg } from "./index";

test("usdg is listed on both networks with 6 decimals", () => {
  expect(usdg.decimals).toBe(6);
  expect(getAddress(usdg.mainnet)).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  expect(usdg.testnet).not.toBeNull();
  expect(usdg.testnet.toLowerCase()).not.toBe(usdg.mainnet.toLowerCase());
});

test("every Stock Token has a feed entry; only QCOM lacks a feed", () => {
  expect(Object.keys(feeds).sort()).toEqual(Object.keys(stockTokens).sort());
  for (const [sym, f] of Object.entries(feeds)) {
    if (sym === "QCOM") { expect(f).toBeNull(); continue; }
    expect(f).not.toBeNull();
    expect(() => getAddress(f!.feed)).not.toThrow();
    expect(f!.decimals).toBe(8);
  }
});

test("equity feeds are marked multiplierEmbedded so the multiplier is applied once", () => {
  for (const f of Object.values(feeds)) if (f) expect(f.multiplierEmbedded).toBe(true);
});

test("every pool id is keccak256 of its PoolKey", () => {
  for (const p of Object.values(v4Pools)) expect(poolId(p.key)).toBe(p.id);
});

test("every pool pairs USDG with its own Stock Token, sorted, hookless", () => {
  for (const [sym, p] of Object.entries(v4Pools)) {
    const pair = [p.key.currency0, p.key.currency1].map((a) => a.toLowerCase());
    expect(pair).toContain(usdg.mainnet.toLowerCase());
    expect(pair).toContain(stockTokens[sym as keyof typeof stockTokens].toLowerCase());
    expect(BigInt(pair[0]!) < BigInt(pair[1]!)).toBe(true);
    expect(BigInt(p.key.hooks)).toBe(0n);
  }
});

test("poolId changes when any key field changes", () => {
  const k = v4Pools.NVDA.key;
  expect(poolId({ ...k, fee: k.fee + 1 })).not.toBe(v4Pools.NVDA.id);
  expect(poolId({ ...k, tickSpacing: k.tickSpacing + 1 })).not.toBe(v4Pools.NVDA.id);
});
