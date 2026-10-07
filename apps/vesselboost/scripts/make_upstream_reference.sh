#!/usr/bin/env bash
# Regenerates test/fixtures/upstream-reference/ with upstream VesselBoost (PyTorch), independent of
# this app's ONNX export and JavaScript pipeline.
#
#   VESSELBOOST_UPSTREAM=<clone of https://github.com/KMarshallX/VesselBoost> \
#   VESSELBOOST_WEIGHTS=<manual_0429 checkpoint> \
#   VESSELBOOST_PYTHON=<python with upstream requirements.txt installed> \
#   bash scripts/make_upstream_reference.sh
#
# manual_0429 is /opt/VesselBoost/saved_models/manual_0429 in the vnmd/vesselboost_2.0.0 container
# (OSF project abk4p, osfstorage/pretrained_models/manual_0429), the checkpoint the app's
# vesselboost.onnx was converted from. After regenerating, update the fixture SHA-256 and voxel
# count in e2e/automation.spec.js and the versions in the fixture README.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname "$script_dir")"
: "${VESSELBOOST_UPSTREAM:?clone of KMarshallX/VesselBoost}"
: "${VESSELBOOST_WEIGHTS:?path to the manual_0429 checkpoint}"
python="${VESSELBOOST_PYTHON:-python3}"
work="$(mktemp -d "${TMPDIR:-/tmp}/vesselboost-upstream-reference.XXXXXX")"
name="lausanne-tof-crop-192x192x64"
mkdir -p "$work/in" "$work/out"

node "$script_dir/write_tof_crop.mjs" "$work/in/$name.nii" ${VESSELBOOST_TOF_SOURCE:+"$VESSELBOOST_TOF_SOURCE"}
weights="$(cd "$(dirname "$VESSELBOOST_WEIGHTS")" && pwd)/$(basename "$VESSELBOOST_WEIGHTS")"
(
  cd "$VESSELBOOST_UPSTREAM"
  # Upstream defaults: unet3d, threshold 0.1, connected components under 10 voxels removed, no blending.
  "$python" prediction.py --image_path "$work/in/" --output_path "$work/out/" --pretrained "$weights" --prep_mode 4
)
"$python" "$script_dir/pack_upstream_reference.py" "$work/out/$name.nii" \
  "$app_dir/test/fixtures/upstream-reference/${name}_vesselboost-manual_0429.nii.gz"
shasum -a 256 "$app_dir/test/fixtures/upstream-reference/${name}_vesselboost-manual_0429.nii.gz"
