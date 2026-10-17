// Closed-beta checks (MainnetBeta.s.sol deployed in fork mode, FORK_STACK=beta): every admin role sits with
// OWNER and the deployer keeps none, no caps (Hidden Vault caps at uint256 max; perp open interest is capped at 20% per side, audit PERP-4),
// large deposits go through, and OWNER's emergency levers still work: pause/unpause Hidden deposits, lower a cap
// at once, raise it back only through the 48h timelock. Runs last: it moves chain time by 48h.
import { initVault, approveTx, depositTx, deriveVaultKeys, destroyProver, VAULT_KEY_MESSAGE } from "@plynth/sdk/vault";
import { decodeFunctionData, getAddress, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { giveUsdg } from "../fund";
import { abiOf, expect } from "./core";
import { events, HOUR, U, usdgOf, type Ctx } from "./context";

const ownedAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
const committeeAbi = parseAbi(["function committee() view returns (address)"]);

/** Contracts whose owner() must be OWNER after the deploy (two-step ones once OWNER accepted). */
export function ownedContracts(dep: Record<string, unknown>): [string, Address][] {
  const keys = ["stockTokenRegistry", "stockRouter", "eligibilityRegistry", "jitterBeacon", "savingsVault", "crowdBuy", "shieldedPool", "shieldedTrade", "perpPool"];
  if (typeof dep.feeRouter === "string") keys.push("feeRouter");
  const out: [string, Address][] = keys.map((k) => [k, getAddress(dep[k] as string)]);
  for (const [sym, m] of Object.entries((dep.perpMarkets ?? {}) as Record<string, string>)) out.push([`perpMarket ${sym}`, getAddress(m)]);
  return out;
}

export async function beta(x: Ctx) {
  const { r, A, dep } = x;
  if (!dep.beta) {
    x.notes.push("beta area skipped: this fork runs ForkMainnet.s.sol (FORK_STACK=beta deploys MainnetBeta.s.sol)");
    return;
  }
  const owner = getAddress(dep.owner as string);
  const deployer = getAddress(dep.deployer as string);
  const pool = x.addr("shieldedPool");
  const usdg = x.addr("usdg");
  const P = abiOf("ShieldedPool");

  await r.check("the placeholder OWNER is the exercise's owner account (dev account 0)", () => {
    expect(owner === A.deployer.address, `OWNER ${owner} is not dev account 0`);
    expect(deployer !== owner, "deployer == OWNER");
    return `OWNER ${owner}, deployer ${deployer}`;
  });
  await r.check("OWNER owns every contract, nothing is pending, the deployer owns nothing", async () => {
    const list = ownedContracts(dep);
    for (const [name, a] of list) {
      const o = getAddress(await r.read<Address>(a, ownedAbi, "owner"));
      expect(o === owner, `${name} owner ${o}`);
      let p: Address | undefined;
      try {
        p = await r.read<Address>(a, ownedAbi, "pendingOwner");
      } catch {} // one-step Ownable has no pendingOwner
      if (p !== undefined) expect(BigInt(p) === 0n, `${name} pendingOwner ${p}`);
    }
    return `${list.length} contracts owned by OWNER`;
  });
  await r.check("committees are OWNER (template review; insurance when the token is deployed)", async () => {
    const t = getAddress(await r.read<Address>(x.addr("templateRegistry"), committeeAbi, "committee"));
    expect(t === owner, `template committee ${t}`);
    if (typeof dep.insurancePool === "string") {
      const i = getAddress(await r.read<Address>(x.addr("insurancePool"), committeeAbi, "committee"));
      expect(i === owner, `insurance committee ${i}`);
    }
    return "committee() = OWNER";
  });
  if (typeof dep.plth === "string") {
    await r.check("the deployer holds no PLTH (everything not in the pool went to OWNER)", async () => {
      const b = await r.read<bigint>(x.addr("plth"), abiOf("PLTH"), "balanceOf", [deployer]);
      expect(b === 0n, `deployer PLTH ${b}`);
      return "balanceOf(deployer) = 0";
    });
  }

  // ---- no caps
  const assets = [usdg, x.addr("steakUsdg"), ...Object.values(dep.stocks).map((s) => getAddress(s.token))];
  for (const a of assets) {
    const c = await r.read<bigint>(pool, P, "cap", [a]);
    if (c !== maxUint256) await r.send(`apply the unlimited Hidden Vault cap for ${r.who(a)}`, A.outsider, { address: pool, abi: P, functionName: "applyCap", args: [a] });
  }
  await r.check("every Hidden Vault cap is uint256 max (no caps)", async () => {
    for (const a of assets) {
      const c = await r.read<bigint>(pool, P, "cap", [a]);
      expect(c === maxUint256, `cap(${r.who(a)}) = ${c}`);
    }
    return `${assets.length} assets uncapped`;
  });
  // v2 (audit PERP-4): open interest per side is a conservative 20% of pool liquidity (MainnetBeta.PERP_OI_CAP_BPS).
  await r.check("every perp market's open-interest cap is 20% of pool liquidity per side", async () => {
    const out: string[] = [];
    for (const [sym, m] of Object.entries((dep.perpMarkets ?? {}) as Record<string, string>)) {
      const b = await r.read<bigint>(getAddress(m), abiOf("PerpMarket"), "oiCapBps", []);
      expect(b === 2_000n, `${sym} oiCapBps ${b}`);
      out.push(sym);
    }
    return `oiCapBps = 2000 for ${out.join(", ")}`;
  });

  // ---- large deposits succeed
  const big = 5_000_000n * U;
  await giveUsdg(A.open.address, 1_000_000n * U);
  await r.send("Open saver approves the SavingsVault for 1,000,000 USDG", A.open, { address: usdg, abi: parseAbi(["function approve(address, uint256) returns (bool)"]), functionName: "approve", args: [x.addr("savingsVault"), 1_000_000n * U] });
  await r.send("Open saver deposits 1,000,000 USDG into the SavingsVault (no cap)", A.open, { address: x.addr("savingsVault"), abi: abiOf("SavingsVault"), functionName: "deposit", args: [1_000_000n * U] });
  await giveUsdg(A.shielder.address, big + 10n * U);
  await initVault();
  try {
    const ks = deriveVaultKeys(await r.wallet(A.shielder).signMessage({ message: VAULT_KEY_MESSAGE }));
    const approve = approveTx(usdg, pool, maxUint256);
    await r.sendRaw("shielder approves the pool for USDG", A.shielder, { to: approve.to, data: approve.data });
    const deposit = async (step: string, raw: bigint) => {
      const d = depositTx(pool, usdg, raw, ks);
      let id: bigint | undefined;
      await r.sendRaw(step, A.shielder, { to: d.to, data: d.data }, async (rc) => {
        const e = (await events(x, pool, "ShieldedPool", "DepositQueued", rc.blockNumber, { origin: A.shielder.address }))[0];
        expect(!!e, "no DepositQueued");
        id = BigInt(e!.args.pendingId);
        return `pending #${id}, shielded USDG now ${await r.read<bigint>(pool, P, "shielded", [usdg])}`;
      });
      return id;
    };
    const refund = async (id: bigint | undefined, what: string) => {
      if (id === undefined) return;
      await r.send(`shielder refunds the ${what} deposit`, A.shielder, { address: pool, abi: P, functionName: "refundPending", args: [id] });
    };
    const bigId = await deposit("shielder deposits 5,000,000 USDG into the Hidden Vault (5x the old fork cap)", big);
    await refund(bigId, "5,000,000 USDG");

    // ---- emergency levers
    await r.reverts("a non-owner cannot pause Hidden deposits", A.keeper, { address: pool, abi: P, functionName: "setDepositsPaused", args: [true] }, "OwnableUnauthorizedAccount");
    await r.send("OWNER pauses Hidden deposits", A.deployer, { address: pool, abi: P, functionName: "setDepositsPaused", args: [true] }, async () => {
      expect(await r.read<boolean>(pool, P, "depositsPaused"), "not paused");
      return "depositsPaused = true";
    });
    const asCall = (data: Hex) => {
      const d = decodeFunctionData({ abi: P, data });
      return { address: pool, abi: P, functionName: d.functionName, args: d.args as unknown[] };
    };
    await r.reverts("a Hidden deposit while paused reverts Paused", A.shielder, asCall(depositTx(pool, usdg, 1n * U, ks).data), "Paused");
    await r.send("OWNER unpauses Hidden deposits", A.deployer, { address: pool, abi: P, functionName: "setDepositsPaused", args: [false] });
    const smallId = await deposit("shielder deposits 1 USDG after the unpause", 1n * U);
    await refund(smallId, "1 USDG");

    const held = await r.read<bigint>(pool, P, "shielded", [usdg]);
    await r.send("OWNER lowers the USDG cap to what the vault holds (applies at once)", A.deployer, { address: pool, abi: P, functionName: "proposeCap", args: [usdg, held] }, async () => {
      const c = await r.read<bigint>(pool, P, "cap", [usdg]);
      expect(c === held, `cap ${c} != ${held}`);
      return `cap(USDG) = ${c}`;
    });
    await r.reverts("a deposit above the lowered cap reverts CapExceeded", A.shielder, asCall(depositTx(pool, usdg, 1n * U, ks).data), "CapExceeded");
    await r.send("OWNER proposes the unlimited cap again", A.deployer, { address: pool, abi: P, functionName: "proposeCap", args: [usdg, maxUint256] });
    await r.reverts("raising a cap waits for the 48h timelock", A.outsider, { address: pool, abi: P, functionName: "applyCap", args: [usdg] }, "TooEarly");
    await r.check("warp 48h", async () => {
      await r.warp(48n * HOUR + 60n);
      return `chain time ${await r.now()}`;
    });
    await r.send("anyone applies the unlimited cap after 48h", A.outsider, { address: pool, abi: P, functionName: "applyCap", args: [usdg] }, async () => {
      const c = await r.read<bigint>(pool, P, "cap", [usdg]);
      expect(c === maxUint256, `cap ${c}`);
      return "cap(USDG) = uint256 max";
    });
    const againId = await deposit("shielder deposits 1 USDG again", 1n * U);
    await refund(againId, "last 1 USDG");
    await r.check("the shielder got every refunded USDG back", async () => `shielder USDG ${await usdgOf(x, A.shielder.address)}`);
  } finally {
    await destroyProver();
  }
}
