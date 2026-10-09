#!/usr/bin/env bash
# Regenerates test/fixtures/upstream-reference/ with upstream MuscleMap (PyTorch), independent of
# this app's ONNX export and JavaScript pipeline.
#
#   MUSCLEMAP_UPSTREAM=<clone of https://github.com/MuscleMap/MuscleMap at the revision in model-sources/release.json> \
#   MUSCLEMAP_PYTHON=<python with upstream requirements.txt installed> \
#   bash scripts/make_upstream_reference.sh
#
# Use upstream's pinned torch 2.4.1 and monai 1.3.2: torch 2.11.0 with monai 1.5.2 changes 721 of
# the slab's 384 000 voxels. mm_segment.py downloads the whole-body v1.4 checkpoint from Zenodo
# record 21929873 into the clone. Overlap 0 and a 5-slice chunk match what the browser test selects.
# After regenerating, update the fixture SHA-256 and counts in test/upstream-reference.mjs and the
# versions in the fixture README.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname "$script_dir")"
: "${MUSCLEMAP_UPSTREAM:?clone of MuscleMap/MuscleMap}"
python="${MUSCLEMAP_PYTHON:-python3}"
work="$(mktemp -d "${TMPDIR:-/tmp}/musclemap-upstream-reference.XXXXXX")"
name="body_mri_s0175_slab"

node "$script_dir/write_body_slab.mjs" "$work/$name.nii" ${MUSCLEMAP_BODY_SOURCE:+"$MUSCLEMAP_BODY_SOURCE"}
(
  cd "$MUSCLEMAP_UPSTREAM/scripts"
  "$python" mm_segment.py -i "$work/$name.nii" -r wholebody --model_version 1.4 -o "$work/out" -g N -s 0 -c 5
)
"$python" "$script_dir/pack_upstream_reference.py" "$work/out/${name}_dseg.nii.gz" \
  "$app_dir/test/fixtures/upstream-reference/${name}_musclemap-wholebody-v1.4_dseg.nii.gz"
shasum -a 256 "$app_dir/test/fixtures/upstream-reference/${name}_musclemap-wholebody-v1.4_dseg.nii.gz"
