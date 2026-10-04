// Network defaults come from @plynth/chain and are only defaults: every module takes addresses as arguments.
import { describe, expect, test } from "bun:test";
import { contracts } from "@plynth/chain";
import { CHAIN_IDS, parseDeployment, publicInfra } from "../src/defaults";
import { ERC5564_ANNOUNCER, ERC6538_REGISTRY, registerTx } from "../src/stealth";

describe("defaults", () => {
  test("publicInfra mirrors @plynth/chain for both networks", () => {
    for (const n of ["mainnet", "testnet"] as const) {
      const p = publicInfra(n);
      expect(p.chainId).toBe(n === "mainnet" ? 4663 : 46630);
      expect(p.usdg).toBe(contracts[n].usdg);
      expect(p.erc5564Announcer).toBe(contracts[n].erc5564Announcer);
      expect(p.erc6538Registry).toBe(contracts[n].erc6538Registry);
      expect(p.multicall3).toBe(contracts[n].multicall3);
      expect(p.permit2).toBe(contracts[n].permit2);
    }
    expect(CHAIN_IDS).toEqual({ mainnet: 4663, testnet: 46630 });
    expect(publicInfra("mainnet").usdg).not.toBe(publicInfra("testnet").usdg);
  });

  test("stealth defaults come from @plynth/chain; an explicit address overrides them", () => {
    expect(ERC5564_ANNOUNCER).toBe(contracts.mainnet.erc5564Announcer);
    expect(ERC6538_REGISTRY).toBe(contracts.mainnet.erc6538Registry);
    const real = "st:eth:0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817980279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // not-a-key (secp256k1 generator point, twice)
    expect(registerTx(real).to).toBe(ERC6538_REGISTRY);
    expect(registerTx(real, "0x0000000000000000000000000000000000000abc").to).toBe("0x0000000000000000000000000000000000000abc");
  });

  test("parseDeployment reads deploy-script JSON, ignores unknown keys, rejects bad values", () => {
    const d = parseDeployment({ chainId: 31337, deployBlock: 12, crowdBuy: "0x00000000000000000000000000000000000000c0", stocks: {}, genesis: 1 });
    expect(d).toEqual({ chainId: 31337, deployBlock: 12n, crowdBuy: "0x00000000000000000000000000000000000000c0" });
    expect(() => parseDeployment({ chainId: 0 })).toThrow(/chainId/);
    expect(() => parseDeployment({ chainId: 1, shieldedPool: "0x12" })).toThrow(/shieldedPool/);
  });
});
