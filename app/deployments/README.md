# Deployments

`<chainid>.json` files written by `contracts/script/TestnetKit.s.sol` and `TestnetConsumer.s.sol` (all addresses
and v4 pool ids). `<chainid>-perps.json` (TestnetPerpKit), `<chainid>-token.json` (TestnetTokenKit: PLTH, its
v4 pool, staking, fee router, insurance pool) and `<chainid>-treasury.json` (TreasuryFactory) are written after
it and read `<chainid>.json`. The services read this folder by default (`*_DEPLOYMENTS_DIR` overrides it).

Everything here except this file and the Robinhood Chain testnet files `46630.json` / `46630-treasury.json`
(`contracts/script/TestnetStack.s.sol`, rewritten by `app/scripts/testnet/setup.ts` with the L2 `deployBlock`) is
gitignored: local and fork runs write the same chain ids. Published
addresses go into the repository README instead. The folder is tracked (through this file) because the forge
scripts may only write into a directory that already exists (`fs_permissions` in `contracts/foundry.toml`).
