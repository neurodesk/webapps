#!/usr/bin/env bash
# ANTs N4 schedules on a subject's native denoised T1 and linear mask, for comparison with N3.
#
#   n4_schedule.sh <run dir, e.g. ~/scratch/bison/runs/ref-final> <subject> <out dir>
#
# Writes T1_NLM, T1_Mask and T1_N3 as NIfTI and one ants_<schedule>.nii.gz per schedule. Needs the
# MINC toolkit (ConvertImage, N4BiasFieldCorrection). Score them with n4_compare.py.
set -euo pipefail
run=$1
id=$2
out=$3
p=$run/$id/preproc
mkdir -p "$out"
for f in T1_NLM T1_Mask T1_N3; do
  ConvertImage 3 "$p/${id}_$f.mnc" "$out/$f.nii.gz" 0
done
n4() {
  local name=$1
  shift
  N4BiasFieldCorrection -d 3 -i "$out/T1_NLM.nii.gz" -w "$out/T1_Mask.nii.gz" -t '[0.15,0.01,200]' "$@" -o "$out/ants_$name.nii.gz"
}
# The direct translation of nu_correct -iter 200 -distance 50 -stop 0.001.
n4 direct -s 4 -c '[200,0.001]' -b '[50]'
n4 direct_noconv -s 4 -c '[200,0]' -b '[50]'
n4 direct_shrink1 -s 1 -c '[200,0.001]' -b '[50]'
n4 knots25 -s 4 -c '[200,0.001]' -b '[25]'
# BISON's schedule (src/preprocess.js N4_OPTIONS).
n4 four_level -s 4 -c '[50x50x50x50,0]' -b '[200]'
