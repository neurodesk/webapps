#!/usr/bin/env bash
# All field comparisons of the #505 parity check, on ds005134 sub-01,
# including the port gate against the pinned #471 DR-BUDDI field.
# Usage: parity.sh BASE   (BASE as for sweep.sh); writes BASE/parity.json
set -euo pipefail
base=$(cd "$1" && pwd)
source "$base/rpe-scripts/common.sh"
run=$base/../reverse-pe/runs/ds005134-sub-01
cmp_() {  # name A_dir B_dir A_eval B_eval
  echo "\"$1\": $(py "$base/scripts/compare_fields.py" "$base/rpe-scripts" "$run" "$2" "$3" \
    "$base/eval/$4/runs/ds005134-sub-01/drbuddi/field_hz.nii.gz" \
    "$base/eval/$5/runs/ds005134-sub-01/drbuddi/field_hz.nii.gz")"
}
{
  echo "{"
  for s in c10-20-20 m50-100-100 f4-100 m100-300-300 default; do
    cmp_ "wasm_chromium_vs_native_2mm_$s" "$base/runs/chromium/$s/ds005134-sub-01" \
      "$base/runs/native/$s/ds005134-sub-01" "chromium-$s" "native-$s"
    echo ","
  done
  cmp_ "native_probe_vs_qsiprep_quad_c10-20-20" "$base/runs/nativequad/c10-20-20/ds005134-sub-01" \
    "$base/runs/qsiprep/c10-20-20/ds005134-sub-01" "nativequad-c10-20-20" "qsiprep-c10-20-20"
  echo ","
  cmp_ "probe_2mm_vs_qsiprep_quad_c10-20-20" "$base/runs/native/c10-20-20/ds005134-sub-01" \
    "$base/runs/qsiprep/c10-20-20/ds005134-sub-01" "native-c10-20-20" "qsiprep-c10-20-20"
  # The port gate: the final probe field against the pinned #471 DR-BUDDI field
  # (full method, QSIPrep default). That run has no up and down fields.
  for s in default m100-300-300 c10-20-20; do
    echo ","
    echo "\"probe_2mm_vs_pinned_471_drbuddi_$s\": $(py "$base/scripts/compare_fields.py" \
      "$base/rpe-scripts" "$run" - - \
      "$base/eval/native-$s/runs/ds005134-sub-01/drbuddi/field_hz.nii.gz" \
      "$run/drbuddi/field_hz.nii.gz")"
  done
  echo "}"
} > "$base/parity.json"
python3 -m json.tool "$base/parity.json" > /dev/null
