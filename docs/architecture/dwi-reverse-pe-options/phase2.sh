#!/usr/bin/env bash
# Phase 2: ds004146 sub-0001 to sub-0005, every method, one run at a time.
# Usage: phase2.sh [subject-number...]   (default 0001 to 0005)
set -uo pipefail
source "$(dirname "$0")/common.sh"
methods="topup topup-single ants pyhysco pyhysco-gpu qwarp drbuddi fdnet fdnet-pa-first"
for s in ${@:-0001 0002 0003 0004 0005}; do
  sub=ds004146-sub-$s
  b=$ROOT/bids/ds004146/sub-$s/ses-01
  "$SCRIPTS/prep.sh" $sub \
    $b/dwi/sub-${s}_ses-01_dir-AP_run-01_dwi.nii.gz $b/dwi/sub-${s}_ses-01_dir-AP_run-01_dwi.bval \
    $b/dwi/sub-${s}_ses-01_dir-PA_run-01_dwi.nii.gz $b/dwi/sub-${s}_ses-01_dir-PA_run-01_dwi.bval \
    $b/anat/sub-${s}_ses-01_UNIT1_denoised.nii.gz || { echo "FAILED prep $sub"; continue; }
  for m in $methods; do
    "$SCRIPTS/methods.sh" $sub $m || echo "FAILED $m $sub"
  done
  "$SCRIPTS/post.sh" $sub $methods || echo "FAILED post $sub"
done
echo phase2-done
