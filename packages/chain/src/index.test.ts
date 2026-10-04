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
