#!/usr/bin/env bash
# Runs the SamSrf Octave reference harness: the Python GIFTI dump, then reference.m in
# the gnuoctave/octave:9.2.0 container. Reruns overwrite every output.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
example=${SAMSRF_EXAMPLE_DIR:-/storage/scratch/samsrf-work/dl/X001}
out=${SAMSRF_REFERENCE_DIR:-/storage/scratch/samsrf-work/reference}
samsrf=${SAMSRF_SOURCE_DIR:-/storage/scratch/samsrf-work/src/samsrf}
image=${SAMSRF_OCTAVE_IMAGE:-gnuoctave/octave:9.2.0}
start=$(date +%s)

mkdir -p "$out/gifti" "$out/apertures"
python3 -I "$here/dump_gifti.py" --out "$out/gifti" --samples "$out/gifti_run.json" "$example"/func/lh_uBars{1..6}.gii
python3 -I "$here/select_vertices.py" --label "$example/prf/V123.label" --gifti-json "$out/gifti/lh_uBars1.gii.json" --extra 512 --out "$out/preprocess_vertices.json"
cp "$example/prf/aps_Bars.mat" "$out/apertures/aps_Bars.mat"
rm -f "$out/apertures/aps_Bars_vec" "$out/apertures/aps_Bars_vec.mat"

# SamSrf folders first, then the shims, so the shims are in front of the path.
octave_path="addpath('/samsrf/Fitting', '/samsrf/pRF', '/samsrf/Hrf', '/samsrf/Surfs', '/samsrf/Utils', '/samsrf/Various');"
octave_path+=" addpath('/harness/shims');"
octave_path+=" addpath('/harness');"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$samsrf:/samsrf:ro" \
  -v "$here:/harness:ro" \
  -v "$example:/example:ro" \
  -v "$out:/out" \
  -w /out \
  "$image" \
  octave --no-gui --no-history --eval "$octave_path reference('/example', '/out', '/samsrf');"

seconds=$(( $(date +%s) - start ))
echo "wall time: ${seconds} s" | tee "$out/wall_time.txt"
