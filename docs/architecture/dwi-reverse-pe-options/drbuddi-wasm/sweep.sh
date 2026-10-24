#!/usr/bin/env bash
# Native sweep on a 32-core host: every schedule x subject, one thread per probe run,
# JOBS runs at a time; each run is scored by evaluate-run.sh when it ends.
# Usage: sweep.sh BASE JOBS SCHEDULE... -- SUBJECT...
#   BASE holds scripts/ (this folder), rpe-scripts/ (upstream/main),
#   inputs/<subject>/, build-native/native/drbuddi-probe and ../reverse-pe/runs.
set -euo pipefail
base=$(cd "$1" && pwd) jobs=$2
shift 2
schedules=()
while [[ $1 != -- ]]; do schedules+=("$1"); shift; done
shift
one() {
  local base=$1 sched=$2 sub=$3
  local out=$base/runs/native/$sched/$sub
  if [[ ! -f $out/receipt.json ]]; then
    bash "$base/scripts/run-native.sh" "$base/build-native/native/drbuddi-probe" \
      "$base/inputs/$sub" "$base/scripts/schedules/$sched.json" "$out"
  fi
  bash "$base/scripts/evaluate-run.sh" "$base/rpe-scripts" "$base/../reverse-pe/runs" \
    "$base/eval/native-$sched" "$sub" "$out" > "$out/evaluate.log" 2>&1
  echo "done $sched $sub"
}
export -f one
for s in "${schedules[@]}"; do for sub in "$@"; do echo "$s $sub"; done; done |
  xargs -P "$jobs" -L 1 bash -c 'one "$0" "$1" "$2"' "$base"
