// Stealth delivery with ERC-5564 / ERC-6538, the way any app can pay a Plynth Quiet user (or anyone with a
// registered meta-address) without naming them on-chain.
//   bun packages/sdk/examples/send-to-stealth.ts
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicInfra } from "@plynth/sdk";
import {
  KEY_DERIVATION_MESSAGE,
  SCHEME_ID,
  announcementEvent,
  announcerAbi,
  computeStealthAddress,
  decodeAnnouncementLog,
  encodeMetadata,
  generateKeys,
  keyForHit,
  metaAddress,
  registerTx,
  registryAbi,
  scan,
} from "@plynth/sdk/stealth";
import { check, runExample } from "./_local";

const U = 1_000_000n;
const mint = parseAbi(["function mint(address to, uint256 amount)"]);

await runExample("send-to-stealth", async ({ dep, pub, wallet, chain, accounts, rpc, rpcCall, send, call, read }) => {
  // The canonical singletons have the same address on anvil (etched), testnet and mainnet.
  const { erc5564Announcer: announcer, erc6538Registry: registry } = publicInfra("testnet");
  const [deployer, , recipient, sender] = accounts as [Address, Address, Address, Address];
  const usdg = dep.usdg as Address;

  // 1. Recipient: keys from one wallet signature, meta-address registered once in ERC-6538.
  const keys = generateKeys(await wallet.signMessage({ account: recipient, message: KEY_DERIVATION_MESSAGE }));
  await send(recipient, registerTx(metaAddress(keys), registry));

  // 2. Sender: looks the meta-address up, derives a one-time stealth address, pays and announces.
  const meta = (await read(registry, registryAbi, "stealthMetaAddressOf", [recipient, SCHEME_ID])) as Hex;
  const s = computeStealthAddress(meta);
  const amount = 25n * U;
  await call(deployer, usdg, mint, "mint", [sender, amount]);
  await call(sender, usdg, erc20Abi, "transfer", [s.stealthAddress, amount]);
  await send(sender, {
    to: announcer,
    data: encodeFunctionData({ abi: announcerAbi, functionName: "announce", args: [SCHEME_ID, s.stealthAddress, s.ephemeralPublicKey, encodeMetadata(s.viewTag, usdg, amount)] }),
  });
  console.log(`paid ${amount} mUSDG to a fresh stealth address; the recipient's address appears nowhere in either tx`);

  // 3. Recipient: scans announcements with the viewing key (a watch-only device can do this part).
  const logs = await pub.getLogs({ address: announcer, event: announcementEvent, fromBlock: 0n, toBlock: "latest" });
  const hits = scan(logs.map((l) => decodeAnnouncementLog(l as any)), keys.viewingPrivateKey, keys.spendingPublicKey);
  check(hits.length === 1 && hits[0]!.stealthAddress === s.stealthAddress, "scan finds exactly the payment");
  check(hits[0]!.token === usdg && hits[0]!.amount === amount, "metadata carries token and amount");

  // 4. Recipient: derives the stealth key and moves the funds to a fresh address. The stealth address needs gas;
  //    funding it from the main wallet would link the two, so on a real chain use a relayer or a paymaster.
  //    Here anvil simply sets its balance.
  const stealth = privateKeyToAccount(keyForHit(hits[0]!, keys));
  check(stealth.address === s.stealthAddress, "derived key controls the stealth address");
  await rpcCall("anvil_setBalance", [stealth.address, "0x2386F26FC10000"]); // 0.01 ETH
  const fresh = computeStealthAddress(metaAddress(keys)).stealthAddress; // another one-time address of the recipient
  const w = createWalletClient({ account: stealth, chain, transport: http(rpc) });
  const hash = await w.writeContract({ address: usdg, abi: erc20Abi, functionName: "transfer", args: [fresh, amount] });
  check((await pub.waitForTransactionReceipt({ hash })).status === "success", "stealth transfer succeeded");
  check((await read(usdg, erc20Abi, "balanceOf", [fresh])) === amount, "funds arrived at the fresh address");
  check((await read(usdg, erc20Abi, "balanceOf", [recipient])) === 0n, "the recipient's main address never received anything");
});

