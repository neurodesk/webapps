#!/bin/sh
# The real atlases and examples, which are too large for the repository. Point the argument (or
# NII2TVX_REFERENCE_DIR) at a checkout of https://github.com/neurolabusc/nii2tvx that has run
# hcp2tvx.py and enigma2tvx.py, so it holds examples2/, hcp1065_avg_tracts.tvx and
# enigma_symmetric.tvx.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
ref=${1:-${NII2TVX_REFERENCE_DIR:-$HOME/src/nii2tvx}}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# wM2017 was drawn on a T1, the other three on a T2.
lesions="wM2017_T1w wM2018_T2w wM2201_T2w wM2208_T2w"
set -- \
  "hcp1065_avg_tracts.tvx expected-examples.tsv 87" \
  "enigma_symmetric.tvx expected-examples-enigma.tsv 65"

for entry in "$@"; do
  set -- $entry
  atlas=$ref/$1
  expected=$here/$2
  tracts=$3
  [ -f "$atlas" ] || { echo "No atlas at $atlas; build it in that checkout." >&2; exit 2; }

  args=""
  for lesion in $lesions; do args="$args $ref/examples2/${lesion}_lesion.nii.gz"; done
  # shellcheck disable=SC2086 # deliberate word splitting: one argument per lesion
  "$root/nii2tvx" $args "$atlas" > "$work/native.tsv"
  diff -u "$expected" "$work/native.tsv" || { echo "native output changed for $1" >&2; exit 1; }

  if [ -f "$root/nii2tvx.mjs" ] && command -v node >/dev/null 2>&1; then
    for lesion in $lesions; do
      node "$root/wasm_demo.mjs" "$ref/examples2/${lesion}_lesion.nii.gz" "$atlas" > "$work/wasm.tsv"
      "$root/nii2tvx" "$ref/examples2/${lesion}_lesion.nii.gz" "$atlas" > "$work/native-one.tsv"
      diff -u "$work/native-one.tsv" "$work/wasm.tsv" \
        || { echo "WASM and native disagree on $lesion against $1" >&2; exit 1; }
    done
    echo "ok: four example lesions against $tracts tracts in $1, native and WASM identical"
  else
    echo "ok: four example lesions against $tracts tracts in $1 (WASM skipped: run make wasm)"
  fi
done
