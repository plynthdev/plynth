# Deployments

`<chainid>.json` files written by `contracts/script/TestnetKit.s.sol` and `TestnetConsumer.s.sol` (all addresses
and v4 pool ids). `<chainid>-perps.json` (TestnetPerpKit), `<chainid>-token.json` (TestnetTokenKit: PLTH, its
v4 pool, staking, fee router, insurance pool) and `<chainid>-treasury.json` (TreasuryFactory) are written after
it and read `<chainid>.json`. The services read this folder by default (`*_DEPLOYMENTS_DIR` overrides it).

Everything here is gitignored (local and fork runs write the same chain ids) except this file and the public
deployments: Robinhood Chain testnet `46630.json` / `46630-treasury.json` (`contracts/script/TestnetStack.s.sol`,
rewritten by `app/scripts/testnet/setup.ts` with the L2 `deployBlock`) and mainnet `4663.json` / `4663-treasury.json`
(`contracts/script/MainnetBeta.s.sol`, rewritten by `app/scripts/mainnet/up.sh`). The README's deployment section is
generated from these files (`python3 .github/scripts/readme-deployments.py`, checked in CI), and
`bun run verify:deployment` (in `app/`) checks the mainnet file against the chain. The folder is tracked (through
this file) because the forge scripts may only write into a directory that already exists (`fs_permissions` in
`contracts/foundry.toml`).
