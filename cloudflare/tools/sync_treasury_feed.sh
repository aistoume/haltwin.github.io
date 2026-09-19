#!/usr/bin/env bash
# STOPGAP / fallback: copy the bot's latest portfolio.json (branch treasury-data of this repo) to the site's data feed.
# Needed only until the treasury bot uploads by itself (sterling-asp treasury/DATA_FEED.md: two env vars on the bot).
#   usage: TOKEN_FILE=~/Develop/sterling-secrets/TREASURY_PUBLISH_TOKEN.txt cloudflare/tools/sync_treasury_feed.sh [hours]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; HOURS="${1:-24}"; END=$(( $(date +%s) + HOURS * 3600 ))
URL="https://sterlingai.net/treasury/portfolio.json"; TOKEN="$(tr -d '\n' < "${TOKEN_FILE:?set TOKEN_FILE}")"
TMP="$(mktemp)"; LAST=""
while [ "$(date +%s)" -lt "$END" ]; do
  if git -C "$REPO" fetch -q origin treasury-data 2>/dev/null && git -C "$REPO" show FETCH_HEAD:portfolio.json > "$TMP" 2>/dev/null; then
    SUM="$(shasum "$TMP" | cut -c1-12)"
    if [ "$SUM" != "$LAST" ]; then
      CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @"$TMP" "$URL")"
      echo "$(date -u +%FT%TZ) upload $SUM -> HTTP $CODE"
      [ "$CODE" = 200 ] || [ "$CODE" = 409 ] && LAST="$SUM"
    fi
  else
    echo "$(date -u +%FT%TZ) fetch failed"
  fi
  sleep 300
done
rm -f "$TMP"; echo "$(date -u +%FT%TZ) sync window (${HOURS}h) ended"
