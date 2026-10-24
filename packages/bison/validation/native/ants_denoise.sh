#!/usr/bin/env bash
# Diagnostic denoiser: ANTs DenoiseImage in place of mincnlm.
#
# Usage: ants_denoise.sh <ants-bin> <Rician|Gaussian> <in.mnc> <mask.mnc> <out.mnc>
#
# /opt/ANTs DenoiseImage reads MINC through ITK, which takes MINC world coordinates
# as LPS without the RAS->LPS flip, and it cannot write MINC. So convert the image
# and its mask with mnc2nii (correct NIfTI affine), denoise, convert back with
# nii2mnc and check that the grid did not change. Patch radius 1 and search radius 2
# are DenoiseImage's defaults; -p/-r state them explicitly.
set -euo pipefail
ants_bin=$1
model=$2
in=$3
mask=$4
dst=$5
tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/ants_denoise.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mnc2nii -float -nii "$in" "$tmp/in.nii"
mnc2nii -byte -nii "$mask" "$tmp/mask.nii"
ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 "$ants_bin/DenoiseImage" -d 3 -i "$tmp/in.nii" \
  -x "$tmp/mask.nii" -n "$model" -p 1 -r 2 -o "$tmp/out.nii" -v 1
"$ants_bin/DenoiseImage" --version
nii2mnc -clobber -float "$tmp/out.nii" "$dst"

grid() {
  for d in xspace yspace zspace; do
    mincinfo -attval "$d:length" -attval "$d:step" -attval "$d:start" \
      -attval "$d:direction_cosines" "$1"
  done | awk '{for (i = 1; i <= NF; i++) printf "%.4f ", $i} END {print ""}'
}
a=$(grid "$in")
b=$(grid "$dst")
if [[ $a != "$b" ]]; then
  echo "grid changed: $a vs $b" >&2
  exit 1
fi
