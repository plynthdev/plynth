// Declaration-build stand-in for @plynth/chain (the app's verified address table, app/src/chain). scripts/build.ts
// inlines the real module into dist; tsc only needs the fields the SDK reads. The app's typecheck and
// test/defaults.test.ts check the SDK against the real table.
type Address = `0x${string}`;
type Network = { usdg: Address; erc5564Announcer: Address; erc6538Registry: Address; multicall3: Address; permit2: Address };
export declare const contracts: { readonly mainnet: Network; readonly testnet: Network };
