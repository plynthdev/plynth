# Deployments

`<chainid>.json` files written by `contracts/script/TestnetKit.s.sol` (all addresses and v4 pool ids).
`<chainid>-perps.json` (TestnetPerpKit) and `<chainid>-token.json` (TestnetTokenKit: PLTH, its v4 pool,
staking, fee router, insurance pool) run after it and read `<chainid>.json`.
Only commit a file for a real network deployment; runs against a local anvil fork write the same
chain id and must not be committed.
