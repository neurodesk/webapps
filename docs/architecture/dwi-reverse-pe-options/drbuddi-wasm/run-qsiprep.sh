#!/usr/bin/env bash
# Run the QSIPrep 26.1.1 TORTOISE DRBUDDI binary (the #471 native reference)
# with a schedule file and one thread. Unlike the probe, this binary always
# runs its initial rigid down-to-up registration first; at 1ffb8f3 the
# --DRBUDDI_disable_initial_rigid option has no effect (its use is commented out).
# Usage: run-qsiprep.sh QSIPREP_SIF INPUT_DIR SCHEDULE_JSON OUTPUT_DIR
set -euo pipefail
sif=$1 inputs=$(cd "$2" && pwd) schedule=$3 out=$4
mkdir -p "$out"
out=$(cd "$out" && pwd)
cp "$inputs"/blip_up_b0.nii "$inputs"/blip_down_b0.nii "$inputs"/blip_up_b0.bmtxt "$inputs"/blip_down_b0.bmtxt "$inputs"/blip_up.json "$out/"
mapfile -t stages < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["stages"]))' "$schedule")
args=()
for s in "${stages[@]}"; do [[ -n $s ]] && args+=(--DRBUDDI_stage "$s"); done
/usr/bin/time -v -o "$out/time.log" apptainer exec --cleanenv \
  --env OMP_NUM_THREADS=1,ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 -B "$out" "$sif" \
  DRBUDDI -u "$out/blip_up_b0.nii" -d "$out/blip_down_b0.nii" --up_json "$out/blip_up.json" \
  --ncores 1 --disable_itk_threads "${args[@]}" > "$out/drbuddi.log" 2>&1
gzip -dc "$out/deformation_FINV.nii.gz" > "$out/up.nii"
gzip -dc "$out/deformation_MINV.nii.gz" > "$out/down.nii"
