#!/usr/bin/env bash
# Send gas ETH from the deployer to wallets in mainnet-addresses.json.
# Usage: fund-bots.sh <addresses.json> <name> <eth> [<name> <eth> ...]
set -euo pipefail
C="${CAST:-$HOME/.foundry/bin/cast}"
R="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
A="$1"; shift
[[ "$("$C" chain-id --rpc-url "$R")" == 4663 ]] || { echo "not mainnet 4663"; exit 1; }
while [[ $# -ge 2 ]]; do
  name="$1"; eth="$2"; shift 2
  to="$(jq -r ".$name" "$A")"
  [[ "$to" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "no address for $name"; exit 1; }
  out="$("$C" send "$to" --value "${eth}ether" --account plynth-main-deployer \
    --password-file "$HOME/.plynth-mainnet/deployer.password" --rpc-url "$R" --chain 4663 --json)"
  echo "$name $eth ETH -> $(jq -r '.transactionHash + " status " + .status' <<<"$out")"
done
