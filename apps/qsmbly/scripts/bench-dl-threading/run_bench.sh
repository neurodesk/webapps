#!/bin/bash
# Drive the bench page in headless Chrome and print what it reported.
#
#   ./serve.py 8099 &
#   ./run_bench.sh '[{"threads":14},{"threads":5}]' [max_wait_s] [port]
#
# CHROME overrides the browser binary (default `google-chrome-stable`), e.g. a Chrome for Testing
# download: CHROME=~/.cache/chrome-for-testing/.../chrome ./run_bench.sh '[...]'
#
# The plan is a JSON array of configuration overrides; see DEFAULTS in index.html for the fields.
# Firefox cannot run this: it hangs in initThreadPool inside a nested module worker, which is how
# QSMbly's pipeline worker calls it. Do not add --virtual-time-budget, it distorts timers.
set -eo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLAN_JSON="${1:?usage: run_bench.sh '<json plan>' [max_wait_s] [port]}"
MAXW="${2:-3600}"
PORT="${3:-8099}"
PROFILE="$(mktemp -d)"
CHROME="${CHROME:-google-chrome-stable}"

rm -f "$HERE/results.jsonl"
PLAN=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PLAN_JSON")
URL="http://localhost:$PORT/scripts/bench-dl-threading/index.html?auto=1&plan=$PLAN"

# Chrome unlinks its profile lazily, so an `rm -rf` right after `pkill` can lose the race and
# fail with "Directory not empty". A leftover temp dir is harmless; a non-zero status out of an
# EXIT trap is not — bash hands it back as this script's status, which fails callers that run
# under `set -e` even though the bench itself finished.
cleanup() {
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT

(setsid "$CHROME" --headless=new --user-data-dir="$PROFILE" \
  --disable-background-timer-throttling --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check \
  "$URL" > "$HERE/chrome.log" 2>&1 &)

waited=0
until grep -q all_done "$HERE/results.jsonl" 2>/dev/null || [ "$waited" -ge "$MAXW" ]; do
  sleep 5
  waited=$((waited + 5))
done
[ "$waited" -ge "$MAXW" ] && echo "WARNING: gave up after ${MAXW}s; partial results below" >&2

python3 - "$HERE/results.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    o = json.loads(line)
    if o.get("type") == "line":
        print(o["s"])
PY
