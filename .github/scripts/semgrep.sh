#!/usr/bin/env bash
# Semgrep over the contracts, services, SDK and circuit scripts (CI and local). Free registry rulesets, no login.
# Fails on any WARNING or ERROR finding; INFO (gas style) is not gated.
#
# Excluded rules, each reviewed:
#   solidity.security.arbitrary-send-erc20  SavingsVault.pullFixedTopUp: a keeper-only Permit2 pull of the amount
#       the saver chose, credited to the saver's own account, at most once per 7 days. Slither runs the same
#       detector per function with a reviewed triage (contracts/slither.triage.json), so new cases still fail CI.
#   typescript.react.security.react-insecure-request  A fork-exercise script probing a local model server on
#       127.0.0.1 (no React, no remote host).
set -euo pipefail
cd "$(dirname "$0")/../.."

semgrep scan --metrics=off --disable-version-check --error \
  --severity WARNING --severity ERROR \
  --config p/smart-contracts --config p/typescript --config p/javascript --config p/secrets \
  --exclude-rule solidity.security.arbitrary-send-erc20.arbitrary-send-erc20 \
  --exclude-rule typescript.react.security.react-insecure-request.react-insecure-request \
  contracts/src app/src app/scripts sdk/src circuits/scripts
