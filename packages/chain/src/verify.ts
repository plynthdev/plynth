import { contracts, stockTokens, stockTokenAbi, client, type Network } from "./index";

let failed = 0;
const fail = (msg: string) => { failed++; console.log(`FAIL ${msg}`); };

for (const network of ["mainnet", "testnet"] as Network[]) {
  const c = client(network);
  const id = await c.getChainId();
  if (id !== c.chain.id) fail(`${network}: rpc chainId ${id} != ${c.chain.id}`);
  else console.log(`ok   ${network}: chainId ${id}`);

  for (const [name, addr] of Object.entries(contracts[network])) {
    const code = addr ? await c.getCode({ address: addr }) : undefined;
    const present = !!code && code !== "0x";
    if (present !== (addr !== null)) fail(`${network}.${name} expected ${addr ? "code" : "absent"}`);
    else console.log(`ok   ${network}.${name} ${addr ?? "(absent)"}`);
  }
}

const main = client("mainnet");
for (const [sym, address] of Object.entries(stockTokens)) {
  const [onchainSym, mult] = await Promise.all([
    main.readContract({ address, abi: stockTokenAbi, functionName: "symbol" }),
    main.readContract({ address, abi: stockTokenAbi, functionName: "uiMultiplier" }),
  ]);
  if (onchainSym !== sym) fail(`${sym}: on-chain symbol is ${onchainSym}`);
  else console.log(`ok   ${sym} uiMultiplier=${Number(mult) / 1e18}`);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall chain facts verified");
