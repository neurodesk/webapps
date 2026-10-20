#!/usr/bin/env bash
# The GRE field map of ds005134 sub-01 as a second reference, on the AP b0 grid.
# Usage: gre.sh <subject> <magnitude1.nii.gz> <phasediff.nii.gz>
# Needs post.sh to have made mask/topup_corrected_mean. The delta TE comes from
# the phasediff sidecar (EchoTime2 - EchoTime1).
set -euo pipefail
source "$(dirname "$0")/common.sh"
sub=$1
mag=$(realpath "$2") phase=$(realpath "$3")
run=$ROOT/runs/$sub
mkdir -p "$run/gre"
cd "$run/gre"
dte_ms=$(py -c "import json; j = json.load(open('${phase%.nii.gz}.json')); print(round((j['EchoTime2'] - j['EchoTime1']) * 1000, 4))")

cp "$mag" magnitude1.nii.gz
mindgrab_mask magnitude1.nii.gz mag_mask.nii.gz
fsl fslmaths magnitude1 -mas mag_mask -ero mag_brain
fsl fsl_prepare_fieldmap SIEMENS "$phase" mag_brain gre_rads "$dte_ms"
fsl fslmaths gre_rads -div 6.283185307 gre_hz
fsl fslmaths mag_brain -bin gre_mask

# Rigid: GRE magnitude onto topup's corrected mean b0 (both undistorted).
ants antsRegistration -d 3 --float 1 -v 0 -o "[mag_to_b0_]" \
  -r "[../mask/topup_corrected_mean.nii.gz,magnitude1.nii.gz,1]" \
  -t "Rigid[0.1]" -m "MI[../mask/topup_corrected_mean.nii.gz,magnitude1.nii.gz,1,32,Regular,0.25]" \
  -c "[200x100x50,1e-6,10]" -f 4x2x1 -s 2x1x0vox
ants antsApplyTransforms -d 3 -i gre_hz.nii.gz -r ../prep/ap_mean.nii.gz \
  -t mag_to_b0_0GenericAffine.mat -n Linear -o gre_hz_on_ap.nii.gz
ants antsApplyTransforms -d 3 -i gre_mask.nii.gz -r ../prep/ap_mean.nii.gz \
  -t mag_to_b0_0GenericAffine.mat -n NearestNeighbor -o gre_mask_on_ap.nii.gz
echo "delta TE $dte_ms ms" > gre.txt
