#!/usr/bin/env bash
# Splits one settings file (env.example's format, e.g. the old /etc/plynth/plynth.env) into one file per service, so
# each service's process only ever receives its own settings and secrets (audit, privileged/ops: "every service runs
# as one Unix user with one env file").
#
#   split-env.sh <source.env> <dest-dir>
#   split-env.sh --add-missing <env.example> <dest-dir>
#
# --add-missing (provision.sh runs it on every deploy, after the split): a variable env.example has and no file in
# <dest-dir> has yet (a setting added by a newer release) is appended, with env.example's value, to the files of the
# services that read it. Values already there are never changed, with one exception: a blank
# RELAYER_WITHDRAW_MIN_FEES or RELAYER_CLAIM_MIN_RAW (the relayer refuses to start on mainnet without them) takes
# env.example's value. Each change is printed (key and file, never the value).
#
# Writes <dest-dir>/{common,indexer,keeper,api,eligibility,relayer,mcp,treasury,treasury-ro}.env (mode 0600; provision.sh runs it
# as root and leaves them root-owned: systemd reads them as root). A line is routed by its key:
#   common       RHC_*_RPC_URL, LOCAL_RPC_URL, LOG_LEVEL (no secrets)
#   indexer      INDEXER_*
#   keeper       KEEPER_*, SPLIT_PARTS, PLAID_*
#   api          API_*, ROUNDUPS_*, CORS_ORIGINS, PLAID_*, ELIGIBILITY_* (the API mounts the screening routes),
#                KEEPER_SECRET_KEY (it seals bank-link tokens), MCP_TOKEN_SECRET (it issues MCP tokens)
#   eligibility  ELIGIBILITY_*
#   relayer      RELAYER_*, CORS_ORIGINS
#   mcp          MCP_*, PLINTH_MCP_TOKEN, RPC_URL, DEPLOYMENT_JSON, TREASURY_RPC_URL
#   treasury     TREASURY_*, RISK_*, OLLAMA_HOST, ORDERLY_SECRET, WEBHOOK_ALLOW_PRIVATE (the plynth-treasury-* units
#                that sign or judge: desks, close, risk, receipts, reconciler)
#   treasury-ro  TREASURY_* except signing material (*_KEY, *_KEYSTORE, *_KEYSTORE_PASSWORD, *_KEYSTORE_PASSWORD_FILE),
#                WEBHOOK_ALLOW_PRIVATE: plynth-treasury-webhooks and -marks, which sign nothing and run as their own
#                users (review v2 V2-L23: the webhook dispatcher fetches customer URLs; it must not hold any key).
#                --add-missing writes it from treasury.env on a server split before it existed.
# DATABASE_URL never goes into these files (it stays in db.env). A key no rule knows goes to common.env with a
# warning on stderr. Comments and blank lines are kept in common.env only.
set -euo pipefail

ADD_MISSING=0
if [[ "${1:-}" == --add-missing ]]; then
  ADD_MISSING=1
  shift
fi
[[ $# == 2 ]] || { echo "usage: split-env.sh [--add-missing] <source.env> <dest-dir>" >&2; exit 2; }
SRC="$1"
DEST="$2"
[[ -r "$SRC" ]] || { echo "split-env: cannot read $SRC" >&2; exit 1; }
mkdir -p "$DEST"

FILES=(common indexer keeper api eligibility relayer mcp treasury treasury-ro)

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
    TREASURY_RPC_URL) echo treasury treasury-ro mcp ;;
    TREASURY_*_KEY | TREASURY_*_KEYSTORE | TREASURY_*_KEYSTORE_PASSWORD | TREASURY_*_KEYSTORE_PASSWORD_FILE) echo treasury ;;
    TREASURY_* | WEBHOOK_ALLOW_PRIVATE) echo treasury treasury-ro ;;
    RISK_* | OLLAMA_HOST | ORDERLY_SECRET) echo treasury ;;
    *)
      echo "split-env: no rule for $k: put in common.env" >&2
      echo common
      ;;
  esac
}

umask 077
if [[ "$ADD_MISSING" == 1 ]]; then
  # A server split before treasury-ro existed: derive it from treasury.env (its values, minus the signing material).
  if [[ -f "$DEST/treasury.env" && ! -f "$DEST/treasury-ro.env" ]]; then
    {
      printf '# treasury-ro.env: written by split-env.sh from treasury.env (no signing material). Read by systemd for plynth-treasury-webhooks and -marks.\n'
      while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
        [[ " $(routes "${BASH_REMATCH[1]}" 2>/dev/null) " == *" treasury-ro "* ]] && printf '%s\n' "$line"
      done <"$DEST/treasury.env"
    } >"$DEST/treasury-ro.env.tmp"
    chmod 0600 "$DEST/treasury-ro.env.tmp"
    mv -f "$DEST/treasury-ro.env.tmp" "$DEST/treasury-ro.env"
    echo "split-env: wrote treasury-ro.env from treasury.env (new in this release)"
  fi
  FILL_BLANK="RELAYER_WITHDRAW_MIN_FEES RELAYER_CLAIM_MIN_RAW"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    for f in $(routes "$key" 2>/dev/null); do
      file="$DEST/$f.env"
      [[ -f "$file" ]] || continue
      if ! grep -q "^$key=" "$file"; then
        printf '%s\n' "$line" >>"$file"
        echo "split-env: added $key to $f.env (new in this release)"
      elif [[ -n "$val" && " $FILL_BLANK " == *" $key "* ]] && grep -qx "$key=" "$file"; then
        awk -v k="$key" -v l="$line" '$0 == k "=" { print l; next } { print }' "$file" >"$file.tmp" && cat "$file.tmp" >"$file" && rm -f "$file.tmp"
        echo "split-env: filled the blank $key in $f.env from env.example"
      fi
    done
  done <"$SRC"
  exit 0
fi

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
