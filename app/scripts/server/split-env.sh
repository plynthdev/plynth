#!/usr/bin/env bash
# Splits one settings file (env.example's format, e.g. the old /etc/plynth/plynth.env) into one file per service, so
# each service's process only ever receives its own settings and secrets (audit, privileged/ops: "every service runs
# as one Unix user with one env file").
#
#   split-env.sh <source.env> <dest-dir>
#
# Writes <dest-dir>/{common,indexer,keeper,api,eligibility,relayer,mcp,treasury}.env (mode 0600; provision.sh runs it
# as root and leaves them root-owned: systemd reads them as root). A line is routed by its key:
#   common       RHC_*_RPC_URL, LOCAL_RPC_URL, LOG_LEVEL (no secrets)
#   indexer      INDEXER_*
#   keeper       KEEPER_*, SPLIT_PARTS, PLAID_*
#   api          API_*, ROUNDUPS_*, CORS_ORIGINS, PLAID_*, ELIGIBILITY_* (the API mounts the screening routes),
#                KEEPER_SECRET_KEY (it seals bank-link tokens), MCP_TOKEN_SECRET (it issues MCP tokens)
#   eligibility  ELIGIBILITY_*
#   relayer      RELAYER_*, CORS_ORIGINS
#   mcp          MCP_*, PLINTH_MCP_TOKEN, RPC_URL, DEPLOYMENT_JSON, TREASURY_RPC_URL
#   treasury     TREASURY_*, RISK_*, OLLAMA_HOST, ORDERLY_SECRET, WEBHOOK_ALLOW_PRIVATE (all plynth-treasury-* units)
# DATABASE_URL never goes into these files (it stays in db.env). A key no rule knows goes to common.env with a
# warning on stderr. Comments and blank lines are kept in common.env only.
set -euo pipefail

[[ $# == 2 ]] || { echo "usage: split-env.sh <source.env> <dest-dir>" >&2; exit 2; }
SRC="$1"
DEST="$2"
[[ -r "$SRC" ]] || { echo "split-env: cannot read $SRC" >&2; exit 1; }
mkdir -p "$DEST"

FILES=(common indexer keeper api eligibility relayer mcp treasury)

routes() {
  local k="$1"
  case "$k" in
    DATABASE_URL) ;;
    RHC_MAINNET_RPC_URL | RHC_TESTNET_RPC_URL | LOCAL_RPC_URL | LOG_LEVEL) echo common ;;
    INDEXER_*) echo indexer ;;
    KEEPER_SECRET_KEY) echo keeper api ;;
    KEEPER_* | SPLIT_PARTS) echo keeper ;;
    PLAID_*) echo keeper api ;;
    API_* | ROUNDUPS_*) echo api ;;
    CORS_ORIGINS) echo api relayer ;;
    ELIGIBILITY_*) echo eligibility api ;;
    RELAYER_*) echo relayer ;;
    MCP_TOKEN_SECRET) echo mcp api ;;
    MCP_* | PLINTH_MCP_TOKEN | RPC_URL | DEPLOYMENT_JSON) echo mcp ;;
    TREASURY_RPC_URL) echo treasury mcp ;;
    TREASURY_* | RISK_* | OLLAMA_HOST | ORDERLY_SECRET | WEBHOOK_ALLOW_PRIVATE) echo treasury ;;
    *)
      echo "split-env: no rule for $k: put in common.env" >&2
      echo common
      ;;
  esac
}

umask 077
tmp="$(mktemp -d "$DEST/.split.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
for f in "${FILES[@]}"; do
  printf '# %s.env: written by split-env.sh from %s. Read by systemd (as root) for the units of this service only.\n' "$f" "$(basename "$SRC")" >"$tmp/$f.env"
done

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then
    printf '%s\n' "$line" >>"$tmp/common.env"
    continue
  fi
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
    echo "split-env: skipped a line that is not KEY=value" >&2
    continue
  fi
  key="${BASH_REMATCH[1]}"
  for f in $(routes "$key"); do printf '%s\n' "$line" >>"$tmp/$f.env"; done
done <"$SRC"

for f in "${FILES[@]}"; do
  chmod 0600 "$tmp/$f.env"
  mv -f "$tmp/$f.env" "$DEST/$f.env"
done
