#!/usr/bin/env bash
# Prepare one subject: b0 volumes, the mean AP and PA b0 pair, and the T1w.
# Usage: prep.sh <subject> <ap.nii.gz> <ap.bval|-> <pa.nii.gz> <pa.bval|-> <t1w.nii.gz>
# Each image's JSON sidecar sits beside it.
set -euo pipefail
source "$(dirname "$0")/common.sh"
sub=$1
abs() { [[ $1 == - ]] && echo - || realpath "$1"; }
ap=$(abs "$2") ap_bval=$(abs "$3") pa=$(abs "$4") pa_bval=$(abs "$5") t1=$(abs "$6")
out=$ROOT/runs/$sub/prep
mkdir -p "$out"
cd "$out"

py "$SCRIPTS/prep.py" . "$ap" "${ap%.nii.gz}.json" "$ap_bval" "$pa" "${pa%.nii.gz}.json" "$pa_bval"

# Mean b0 of each direction, aligned to its first volume. The first AP b0 is
# topup's reference frame, so every field lives on that grid.
for d in ap pa; do
  if [[ $(fsl fslnvols ${d}_b0s) -gt 1 ]]; then
    fsl mcflirt -in ${d}_b0s -refvol 0 -out ${d}_b0s_mc
    fsl fslmaths ${d}_b0s_mc -Tmean ${d}_mean
  else
    fsl imcp ${d}_b0s ${d}_mean
  fi
done

# The PA mean, rigidly aligned to the AP mean (the sdcflows PEPOLAR setup).
# Every method except topup takes this pair.
ants antsRegistration -d 3 --float 1 -v 0 \
  -o "[pa_to_ap_,pa_mean_reg.nii.gz]" \
  -r "[ap_mean.nii.gz,pa_mean.nii.gz,1]" \
  -t "Rigid[0.1]" -m "MI[ap_mean.nii.gz,pa_mean.nii.gz,1,32,Regular,0.25]" \
  -c "[200x100x50,1e-6,10]" -f 4x2x1 -s 2x1x0vox

# T1w: MindGrab brain, then FSL FAST white matter for the BBR cost.
cp "$t1" t1w.nii.gz
mindgrab_mask t1w.nii.gz t1w_mask.nii.gz
fsl fslmaths t1w -mas t1w_mask t1w_brain
fsl fast -t 1 -o t1w_fast t1w_brain
fsl fslmaths t1w_fast_pve_2 -thr 0.5 -bin t1w_wmseg
