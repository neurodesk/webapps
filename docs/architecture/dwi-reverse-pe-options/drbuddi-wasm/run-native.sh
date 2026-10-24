#!/usr/bin/env bash
# Run the native probe (native-build.sh) with a schedule file, one thread.
# Usage: run-native.sh BINARY INPUT_DIR SCHEDULE_JSON OUTPUT_DIR
# Writes up.nii, down.nii, probe.log, time.log (GNU time -v) and receipt.json.
set -euo pipefail
bin=$1 inputs=$2 schedule=$3 out=$4
mkdir -p "$out"
mapfile -t stages < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["stages"]))' "$schedule")
args=()
for s in "${stages[@]}"; do [[ -n $s ]] && args+=(--DRBUDDI_stage "$s"); done
export OMP_NUM_THREADS=1 ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1
/usr/bin/time -v -o "$out/time.log" "$bin" "$inputs/blip_up_b0.nii" "$inputs/blip_down_b0.nii" 1 "$out/out" "${args[@]}" > "$out/probe.log" 2>&1
mv "$out/out-up.nii" "$out/up.nii"
mv "$out/out-down.nii" "$out/down.nii"
python3 - "$bin" "$inputs" "$schedule" "$out" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
bin_, inputs, schedule, out = sys.argv[1:]
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
log = Path(out, "time.log").read_text()
wall = re.search(r"Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (\S+)", log).group(1)
wall_s = sum(float(v) * 60**i for i, v in enumerate(reversed(wall.split(":"))))
rss = int(re.search(r"Maximum resident set size \(kbytes\): (\d+)", log).group(1)) * 1024
sched = json.load(open(schedule))
receipt = {
    "type": "done", "engine": "native x86-64 (clang 20, -O3, one thread)",
    "scheduleName": sched["name"], "schedule": sched["stages"],
    "elapsedMs": wall_s * 1000, "peakRssBytes": rss, "binarySha256": sha(bin_),
    "probeCommit": "9d6ca773f",
    "iterations": sum(1 for line in Path(out, "probe.log").read_text().splitlines() if ", conv:" in line),
    "inputSha256": {n: sha(Path(inputs, n)) for n in ("blip_up_b0.nii", "blip_down_b0.nii")},
    "outputSha256": {n: sha(Path(out, n)) for n in ("up.nii", "down.nii")},
}
Path(out, "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({k: receipt[k] for k in ("scheduleName", "elapsedMs", "peakRssBytes", "iterations")}))
PY
