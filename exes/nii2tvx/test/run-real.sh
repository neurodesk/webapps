#!/bin/sh
# The real atlas and examples, which are too large for the repository. Point the argument (or
# NII2TVX_REFERENCE_DIR) at a checkout of https://github.com/neurolabusc/nii2tvx that has run
# hcp2tvx.py, so it holds examples2/ and hcp1065_avg_tracts.tvx.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
ref=${1:-${NII2TVX_REFERENCE_DIR:-$HOME/src/nii2tvx}}
atlas=$ref/hcp1065_avg_tracts.tvx
[ -f "$atlas" ] || { echo "No atlas at $atlas; run hcp2tvx.py in that checkout." >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"$root/nii2tvx" "$ref"/examples2/wM2017_T1w_lesion.nii.gz "$ref"/examples2/wM2018_T2w_lesion.nii.gz \
                "$ref"/examples2/wM2208_T2w_lesion.nii.gz "$atlas" > "$work/native.tsv"
diff -u "$here/expected-examples.tsv" "$work/native.tsv" || { echo "native output changed" >&2; exit 1; }

if [ -f "$root/nii2tvx.mjs" ] && command -v node >/dev/null 2>&1; then
  # wM2017 was drawn on a T1, the other two on a T2.
  for lesion in wM2017_T1w wM2018_T2w wM2208_T2w; do
    subject=${lesion%%_*}
    node "$root/wasm_demo.mjs" "$ref/examples2/${lesion}_lesion.nii.gz" "$atlas" > "$work/$subject.tsv"
    "$root/nii2tvx" "$ref/examples2/${lesion}_lesion.nii.gz" "$atlas" > "$work/$subject.native.tsv"
    diff -u "$work/$subject.native.tsv" "$work/$subject.tsv" \
      || { echo "WASM and native disagree on $subject" >&2; exit 1; }
  done
  echo "ok: three example lesions against 87 tracts, native and WASM identical"
else
  echo "ok: three example lesions against 87 tracts (WASM skipped: run make wasm)"
fi
