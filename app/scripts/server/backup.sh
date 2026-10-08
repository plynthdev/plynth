#!/usr/bin/env bash
# Nightly backup of the Plynth database: one pg_dump (custom format) per run in /var/backups/plynth, dumps older than
# 14 days deleted. Installed as /usr/local/sbin/plynth-backup by provision.sh and deploy.sh and run as root by
# plynth-backup.timer. Restore into an empty database with:
#   runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=plynth -d plynth_mainnet <file>.dump
#
# Env (optional): DB_NAME (default from /etc/plynth/provision.conf, else plynth_mainnet), BACKUP_DIR
# (default /var/backups/plynth), KEEP_DAYS (default 14).
# The dumps stay on this server's disk: copy them somewhere else too (README.md, "Backups").
set -euo pipefail

if [[ -r /etc/plynth/provision.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/plynth/provision.conf
fi
DB_NAME="${DB_NAME:-plynth_mainnet}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/plynth}"
KEEP_DAYS="${KEEP_DAYS:-14}"

[[ "$(id -u)" == 0 ]] || { echo "backup: run as root" >&2; exit 1; }
[[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_DAYS" -ge 1 ]] || { echo "backup: KEEP_DAYS must be a whole number >= 1" >&2; exit 1; }

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cd /

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/${DB_NAME}-${stamp}.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

runuser -u postgres -- pg_dump --format=custom --compress=6 --no-password "$DB_NAME" >"$tmp"
# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$tmp" >/dev/null
mv "$tmp" "$out"
trap - EXIT

# Keep KEEP_DAYS nightly dumps: delete the ones at least KEEP_DAYS days old, and any leftover partial file.
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump" -mtime +"$((KEEP_DAYS - 1))" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump.partial" -mtime +0 -print -delete

count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump" | wc -l | tr -d ' ')"
echo "backup: $out ($(du -h "$out" | cut -f1)), $count dump(s) kept in $BACKUP_DIR"
