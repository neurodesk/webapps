#!/usr/bin/env bash
# End-to-end run on the 1.2 mm grid (#462): the pinned sdc_driver.py through e2e_driver.py, from
# the kept EPI reference, with the epi2anat affine and SyN in the same precision.
#
#   bash e2e.sh SDC_REFERENCE OUT SEED [--float]
#
# SDC_REFERENCE comes from exes/dwi/sdc/validation/fetch_reference.py (subset registration-gate).
# DENOISE_IMAGE is required: a native DenoiseImage of ANTs 52bc0ab (native/build.sh builds one);
# its output is the same in float and double runs. ANTS_REGISTRATION, ANTS_TOOLS, SDC_PYTHON and
# the kernel variables are as in replay.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
reference=$(cd "$1" && pwd); out=$2; seed=$3; shift 3
python=${SDC_PYTHON:-python3}
cli="node $here/ants-cli.mjs"
registration=${ANTS_REGISTRATION:-$cli}
tools=${ANTS_TOOLS:-$cli}
denoise=${DENOISE_IMAGE:?Set DENOISE_IMAGE to a native DenoiseImage of ANTs 52bc0ab}
rm -rf "$out"
mkdir -p "$out/wrap" "$out/tmp"
out=$(cd "$out" && pwd)
printf '#!/usr/bin/env bash\nexec "%s/timed.sh" antsRegistration %s -- "$@"\n' "$here" "$registration" > "$out/wrap/antsRegistration"
printf '#!/usr/bin/env bash\nexec "%s/timed.sh" DenoiseImage %s -- "$@"\n' "$here" "$denoise" > "$out/wrap/DenoiseImage"
for tool in antsApplyTransforms ImageMath; do
  printf '#!/usr/bin/env bash\nexec "%s/timed.sh" %s %s %s -- "$@"\n' "$here" "$tool" "$tools" "$tool" > "$out/wrap/$tool"
done
chmod +x "$out/wrap/"*
export PATH="$out/wrap:$PATH" SDC_TIMELOG="$out/ants-calls.jsonl" HMC_WASM_RECORD="$out/wasm-calls.jsonl" TMPDIR="$out/tmp"
epi_ref=runs/full-2mm-s1234-double-affine/work/sdc_ref/syn_preprocessing_wf/epi_reference_wf/clip_bg_noise/mapflow/_clip_bg_noise0/clipped.nii.gz
"$python" -I "$here/e2e_driver.py" --zoom 1.2 --epi-ref "$reference/$epi_ref" "$reference/scripts/sdc_driver.py" \
  --anat "$reference/input/sub-01_run-001_T1w.nii.gz" --anat-mask "$reference/mask/sub-01_run-001_desc-mindgrab_mask.nii.gz" \
  --grid 2mm --seed "$seed" --prior affine --epi "$reference/mask/sub-01_dir-AP_run-001_desc-meanb0_dwiref.nii" \
  --epi-mask "$reference/mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz" --meta "$reference/input/sub-01_dir-AP_run-001_dwi.json" \
  --std2anat "$reference/std2anat/affine/std2anat_affine.mat" "$@" --workdir "$out/work" > "$out/driver.log" 2>&1
echo "$out"
