#!/usr/bin/env bash
# Score one probe result with the pinned #471 scripts and the archived shared
# BBR start, without writing to the archived run directory.
# Usage: evaluate-run.sh RPE_SCRIPTS ARCHIVED_RUNS EVAL_ROOT SUBJECT RESULT_DIR
#   RPE_SCRIPTS    docs/architecture/dwi-reverse-pe-options at upstream/main
#   ARCHIVED_RUNS  the #471 runs/ directory (prep, mask, topup, gre, calibration)
#   EVAL_ROOT      a new ROOT for post.sh; runs/<subject>/ is made in it
#   RESULT_DIR     up.nii and down.nii from the probe (time.log optional)
# post.sh then runs fields.py, evaluate.py and FSL flirt BBR from
# mask/b0_to_t1w_init.mat for topup (a copy) and for the probe ("drbuddi").
set -euo pipefail
scripts=$(cd "$1" && pwd) archived=$(cd "$2" && pwd) root=$3 sub=$4 result=$(cd "$5" && pwd)
run=$root/runs/$sub
mkdir -p "$run"
ln -sfn "$archived/$sub/prep" "$run/prep"
[[ -d $archived/$sub/gre ]] && ln -sfn "$archived/$sub/gre" "$run/gre"
[[ -e $run/calibration.json ]] || cp "$archived/$sub/calibration.json" "$run/"
[[ -d $run/mask ]] || cp -r "$archived/$sub/mask" "$run/mask"
[[ -d $run/topup ]] || cp -r "$archived/$sub/topup" "$run/topup"
rm -rf "$run/drbuddi"
mkdir -p "$run/drbuddi"
gzip -nc "$result/up.nii" > "$run/drbuddi/deformation_FINV.nii.gz"
gzip -nc "$result/down.nii" > "$run/drbuddi/deformation_MINV.nii.gz"
[[ -f $result/time.log ]] && cp "$result/time.log" "$run/drbuddi/time.log"
ROOT=$(cd "$root" && pwd) SCRIPTS=$scripts bash "$scripts/post.sh" "$sub" drbuddi
