#!/usr/bin/env bash
# SyN-only replay on the 1.2 mm grid (#462): the pinned sdcflows driver replay_syn.py runs
# init_syn_sdc_wf on the kept inputs of the pinned 1.2 mm double seed-1234 run, with the ANTs
# programs that the environment names.
#
#   bash replay.sh SDC_REFERENCE SDC_GRID OUT SEED [--float]
#
# SDC_REFERENCE and SDC_GRID come from exes/dwi/sdc/validation/fetch_reference.py (subset
# registration-gate, and --folder grid replay-1.2mm). The pinned Python environment
# (sdc/reference/env/uv-pip-freeze.txt) must be the first python3 on PATH, or SDC_PYTHON.
#
# ANTS_REGISTRATION  command for antsRegistration (default: ants-cli.mjs, the WebAssembly kernel)
# ANTS_TOOLS         command prefix for antsApplyTransforms and ImageMath (default: ants-cli.mjs)
# HMC_WASM_DIR, HMC_WASM_HEAP_TRACE  as ants-cli.mjs reads them
#
# OUT gets the nipype work folder (work/sdc_ref/syn_sdc_wf/...), driver.log, ants-calls.jsonl
# (each ANTs call's argv, wall time and peak RSS) and wasm-calls.jsonl (each kernel call).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
reference=$(cd "$1" && pwd); grid=$(cd "$2" && pwd); out=$3; seed=$4; shift 4
python=${SDC_PYTHON:-python3}
cli="node $here/ants-cli.mjs"
registration=${ANTS_REGISTRATION:-$cli}
tools=${ANTS_TOOLS:-$cli}
rm -rf "$out"
mkdir -p "$out/wrap" "$out/tmp"
out=$(cd "$out" && pwd)
python3 "$here/stage_replay.py" "$reference" "$grid" "$out/source" > /dev/null
printf '#!/usr/bin/env bash\nexec "%s/timed.sh" antsRegistration %s -- "$@"\n' "$here" "$registration" > "$out/wrap/antsRegistration"
for tool in antsApplyTransforms ImageMath; do
  printf '#!/usr/bin/env bash\nexec "%s/timed.sh" %s %s %s -- "$@"\n' "$here" "$tool" "$tools" "$tool" > "$out/wrap/$tool"
done
chmod +x "$out/wrap/"*
export PATH="$out/wrap:$PATH" SDC_TIMELOG="$out/ants-calls.jsonl" HMC_WASM_RECORD="$out/wasm-calls.jsonl" TMPDIR="$out/tmp"
"$python" -I "$reference/scripts/replay_syn.py" "$out/source" "$reference/input/sub-01_dir-AP_run-001_dwi.json" \
  --seed "$seed" "$@" --workdir "$out/work" > "$out/driver.log" 2>&1
echo "$out"
