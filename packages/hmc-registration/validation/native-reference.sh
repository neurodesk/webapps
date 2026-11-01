#!/usr/bin/env bash
# Writes the native ANTs outputs that test/expected.mjs pins, from test/data, with native ANTs
# built at 52bc0ab (SuperBuild, Release, static) with the kernel's float64 accumulation in the Mattes
# metric: the deriv64 build of validation/sdc-gate/native/build.sh.
#
#   bash packages/hmc-registration/validation/native-reference.sh <ants-bin-dir> <out-dir>
#
# <ants-bin-dir> must hold antsRegistration, antsApplyTransforms, AverageImages and
# AverageAffineTransform; for hmc-native, wrappers that run `hmc-native "$@"` and
# `hmc-native <program> "$@"`. Every program runs with one ITK thread. The stock build writes the
# goldens of the kernel before #462's Mattes change.
set -euo pipefail
bin=${1:?Pass the directory that holds the native ANTs programs}
out=${2:?Pass an output directory}
data=$(cd "$(dirname "$0")/../test/data" && pwd)
mkdir -p "$out"
cd "$out"
cp "$data/fixed.nii" "$data/moving.nii" .
export ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1
# Two rigid registrations with test/expected.mjs ARGV, which differ only in the seed.
for seed in 1234 4321; do
  "$bin/antsRegistration" --dimensionality 3 --float 1 --random-seed "$seed" \
    --transform 'Rigid[0.1]' --metric 'Mattes[fixed.nii,moving.nii,1,32,Regular,0.25]' \
    --convergence '[100x50,1e-6,10]' --shrink-factors 2x1 --smoothing-sigmas 1x0vox \
    --output "[seed$seed]" > /dev/null
done
# The SHORELine template step: average the transforms, then resample through the inverse.
"$bin/AverageAffineTransform" 3 average.mat seed12340GenericAffine.mat seed43210GenericAffine.mat > /dev/null
for interpolation in Linear NearestNeighbor BSpline 'BSpline[5]' HammingWindowedSinc LanczosWindowedSinc; do
  name=$(echo "$interpolation" | tr -d '[]')
  # Double precision (the antsApplyTransforms default) and --float 1, both written as float32.
  "$bin/antsApplyTransforms" -d 3 -i moving.nii -r fixed.nii -o "apply-$name.nii" -n "$interpolation" \
    -t seed12340GenericAffine.mat -u float > /dev/null
  "$bin/antsApplyTransforms" -d 3 --float 1 -i moving.nii -r fixed.nii -o "apply-float-$name.nii" -n "$interpolation" \
    -t seed12340GenericAffine.mat -u float > /dev/null
done
"$bin/antsApplyTransforms" -d 3 -i moving.nii -r fixed.nii -o apply-inverse-HammingWindowedSinc.nii \
  -n HammingWindowedSinc -t '[average.mat,1]' -u float > /dev/null
# AverageImages of the fixed image and the registered moving image, without and with normalization.
for normalize in 0 1; do
  "$bin/AverageImages" 3 "average-$normalize.nii" "$normalize" fixed.nii apply-Linear.nii > /dev/null
done
sha256sum ./*.mat ./*.nii
