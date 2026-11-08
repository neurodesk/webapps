#!/usr/bin/env bash
# Runs the Node conformance suites of the remote compute protocol against
# this server: test/remote-compute-protocol.test.mjs against a per-pairing
# simulate server, and test/remote-compute-hpc.test.mjs against a
# single-owner simulate server with a data root (and the per-pairing one for
# its pairing-mode checks). Usage: scripts/conformance.sh [path/to/neurodesk-compute]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
binary="${1:-$here/target/debug/neurodesk-compute}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nd-compute-conformance.XXXXXX")"
pids=()

cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

free_port() {
  node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });"
}

wait_for() {
  local url="$1" log="$2"
  for _ in $(seq 1 100); do
    if curl -sf "$url/api/v1/info" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "server at $url did not start:" >&2
  cat "$log" >&2
  return 1
}

pairing_port="$(free_port)"
pairing_url="http://127.0.0.1:$pairing_port"
pairing_token="conformance-pairing"
mkdir -p "$work/pairing"
"$binary" serve --runner simulate --insecure-http --listen "127.0.0.1:$pairing_port" \
  --data-dir "$work/pairing" --token "$pairing_token" >"$work/pairing.log" 2>&1 &
pids+=("$!")

hpc_port="$(free_port)"
hpc_url="http://127.0.0.1:$hpc_port"
hpc_token="conformance-single-owner"
mkdir -p "$work/hpc" "$work/root"
NEURODESK_COMPUTE_TOKEN="$hpc_token" "$binary" serve --runner simulate --single-owner --insecure-http \
  --listen "127.0.0.1:$hpc_port" --data-dir "$work/hpc" --data-root "facility=$work/root" \
  --max-download-bytes 65536 >"$work/hpc.log" 2>&1 &
pids+=("$!")

wait_for "$pairing_url" "$work/pairing.log"
wait_for "$hpc_url" "$work/hpc.log"

cd "$repo"
status=0
echo "== protocol v1 (per-pairing, simulate)"
COMPUTE_SERVER_URL="$pairing_url" COMPUTE_SERVER_TOKEN="$pairing_token" \
  node --test test/remote-compute-protocol.test.mjs || status=1
echo "== HPC features (single-owner, simulate)"
COMPUTE_SERVER_HPC_URL="$hpc_url" COMPUTE_SERVER_HPC_TOKEN="$hpc_token" COMPUTE_SERVER_HPC_ROOT="$work/root" \
  COMPUTE_SERVER_HPC_DATA_DIR="$work/hpc" \
  COMPUTE_SERVER_URL="$pairing_url" COMPUTE_SERVER_TOKEN="$pairing_token" \
  node --test test/remote-compute-hpc.test.mjs || status=1
if [ "$status" -ne 0 ]; then
  echo "== server logs" >&2
  tail -n 50 "$work/pairing.log" "$work/hpc.log" >&2
fi
exit "$status"
