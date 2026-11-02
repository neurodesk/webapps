#!/usr/bin/env bash
# Runs the SamSrf Octave reference harness in the gnuoctave/octave:9.2.0 container.
#   run.sh [all]       reference.m, then analyses.m
#   run.sh reference   the Python GIFTI dump and reference.m only
#   run.sh analyses    analyses.m only (dumps the GIFTI runs first if they are missing)
# Reruns overwrite every output.
set -euo pipefail

mode=${1:-all}
case "$mode" in
  all|reference|analyses) ;;
  *) echo "usage: $0 [all|reference|analyses]" >&2; exit 2 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
example=${SAMSRF_EXAMPLE_DIR:-/storage/scratch/samsrf-work/dl/X001}
labels=${SAMSRF_LABEL_DIR:-/storage/scratch/samsrf-work/example}
out=${SAMSRF_REFERENCE_DIR:-/storage/scratch/samsrf-work/reference}
samsrf=${SAMSRF_SOURCE_DIR:-/storage/scratch/samsrf-work/src/samsrf}
image=${SAMSRF_OCTAVE_IMAGE:-gnuoctave/octave:9.2.0}

# SamSrf folders first, then the shims, so the shims are in front of the path.
octave_path="addpath('/samsrf/Fitting', '/samsrf/pRF', '/samsrf/Hrf', '/samsrf/Surfs', '/samsrf/Utils', '/samsrf/Various');"
octave_path+=" addpath('/harness/shims');"
octave_path+=" addpath('/harness');"

octave() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e SAMSRF_ANALYSES="${SAMSRF_ANALYSES:-}" \
    -v "$samsrf:/samsrf:ro" \
    -v "$here:/harness:ro" \
    -v "$example:/example:ro" \
    -v "$out:/out" \
    -w /out \
    "$image" \
    octave --no-gui --no-history --eval "$1"
}

dump_runs() {
  mkdir -p "$out/gifti"
  python3 -I "$here/dump_gifti.py" --out "$out/gifti" --samples "$out/gifti_run.json" "$example"/func/lh_uBars{1..6}.gii
}

if [ "$mode" != analyses ]; then
  start=$(date +%s)
  mkdir -p "$out/apertures"
  dump_runs
  python3 -I "$here/select_vertices.py" --label "$example/prf/V123.label" --gifti-json "$out/gifti/lh_uBars1.gii.json" --extra 512 --out "$out/preprocess_vertices.json"
  cp "$example/prf/aps_Bars.mat" "$out/apertures/aps_Bars.mat"
  rm -f "$out/apertures/aps_Bars_vec" "$out/apertures/aps_Bars_vec.mat"
  octave "$octave_path reference('/example', '/out', '/samsrf');"
  seconds=$(( $(date +%s) - start ))
  echo "wall time: ${seconds} s" | tee "$out/wall_time.txt"
fi

if [ "$mode" != reference ]; then
  start=$(date +%s)
  analyses="$out/analyses"
  mkdir -p "$analyses/labels" "$analyses/apertures" "$analyses/gifti" "$analyses/template"
  if [ ! -f "$out/gifti/lh_uBars6.gii.json" ]; then
    dump_runs
  fi
  python3 -I "$here/dump_gifti.py" --out "$analyses/gifti" --samples "$analyses/gifti/lh_benson_samples.json" "$example/benson/lh_benson.gii"
  cp "$labels/lh.V123.label" "$analyses/labels/roi_full.label"
  cp "$labels/lh.V1_seed.label" "$analyses/labels/seed_v1.label"
  cp "$example/prf/aps_Bars.mat" "$analyses/apertures/aps_Bars.mat"
  rm -f "$analyses/apertures/aps_Bars_vec" "$analyses/apertures/aps_Bars_vec.mat"
  rm -rf "$analyses/patched"
  # samsrf_fit2dprf (reverse-correlation pRF fitting and CF fitting) lives in Analysis/.
  octave "$octave_path addpath('/samsrf/Analysis'); addpath('/harness/shims'); analyses('/example', '/out', '/samsrf');" 2>&1 | tee "$analyses/octave.log"
  seconds=$(( $(date +%s) - start ))
  echo "analyses wall time: ${seconds} s" | tee "$analyses/wall_time.txt"
fi
