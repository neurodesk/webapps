#!/bin/sh
# The real atlas and examples, which are too large for the repository. Point the argument (or
# NII2TVX_REFERENCE_DIR) at a checkout of https://github.com/neurolabusc/nii2tvx that has run
# hcp2tvx.py, so it holds example/ and hcp1065_avg_tracts.tvx.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
ref=${1:-${NII2TVX_REFERENCE_DIR:-$HOME/src/nii2tvx}}
atlas=$ref/hcp1065_avg_tracts.tvx
[ -f "$atlas" ] || { echo "No atlas at $atlas; run hcp2tvx.py in that checkout." >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"$root/nii2tvx" "$ref"/example/wM2017_T1w_lesion.nii.gz "$ref"/example/wM2018_T1w_lesion.nii.gz \
                "$ref"/example/wM2208_T1w_lesion.nii.gz "$atlas" > "$work/native.tsv"
diff -u "$here/expected-examples.tsv" "$work/native.tsv" || { echo "native output changed" >&2; exit 1; }

if [ -f "$root/nii2tvx.mjs" ] && command -v node >/dev/null 2>&1; then
  for subject in wM2017 wM2018 wM2208; do
    node "$root/wasm_demo.mjs" "$ref/example/${subject}_T1w_lesion.nii.gz" "$atlas" > "$work/$subject.tsv"
    "$root/nii2tvx" "$ref/example/${subject}_T1w_lesion.nii.gz" "$atlas" > "$work/$subject.native.tsv"
    diff -u "$work/$subject.native.tsv" "$work/$subject.tsv" \
      || { echo "WASM and native disagree on $subject" >&2; exit 1; }
  done
  echo "ok: three example lesions against 87 tracts, native and WASM identical"
else
  echo "ok: three example lesions against 87 tracts (WASM skipped: run make wasm)"
fi
