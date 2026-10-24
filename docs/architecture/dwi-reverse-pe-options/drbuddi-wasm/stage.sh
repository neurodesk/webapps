#!/usr/bin/env bash
# Collect the #505 results into the Hugging Face folder layout.
# Usage: stage.sh BASE OUT   (OUT/ becomes sdc/reverse-pe-options/drbuddi-wasm/)
# Per run: receipt.json, the solver log (host paths removed), and for each scored run field_hz.nii.gz,
# metrics.json and bbr.mat. up/down fields only for the ds005134 sub-01 parity
# runs on the 2 mm grid (Chromium; the native fields are byte-identical, see
# the receipts). Quad-grid fields are not uploaded (264 MB each); parity.json
# holds their comparison.
set -euo pipefail
base=$(cd "$1" && pwd) out=$2
rm -rf "$out"
mkdir -p "$out"
out=$(cd "$out" && pwd)
cp "$base/gate.md" "$base/gate.json" "$base/parity.json" "$out/"
mkdir -p "$out/scripts"
cp -r "$base/scripts/." "$out/scripts/"
rm -rf "$out/scripts/README.md" "$out/scripts/.ruff_cache"
mkdir -p "$out/inputs"
(cd "$base/inputs" && sha256sum */blip_up_b0.nii */blip_down_b0.nii) > "$out/inputs/SHA256SUMS"
(cd "$base/inputs-quad" && sha256sum */blip_up_b0.nii */blip_down_b0.nii) > "$out/inputs/quad-SHA256SUMS"
for dir in "$base"/runs/*/*/*/; do
  rel=${dir#"$base/runs/"}
  rel=${rel%/}
  engine=${rel%%/*}
  rest=${rel#*/}
  sched=${rest%%/*}
  sub=${rest#*/}
  dest=$out/runs/$rel
  mkdir -p "$dest"
  [[ -f $dir/receipt.json ]] && cp "$dir/receipt.json" "$dest/"
  # time.log is left out (host paths); receipt.json keeps wall time and peak RSS.
  # Host paths in the logs become <base> and <home>.
  for log in probe.log drbuddi.log browser.log; do
    if [[ -f $dir/$log ]]; then
      sed -e "s|$base|<base>|g" -e "s|$HOME|<home>|g" -e "s|/home/[a-z]*/|<home>/|g" "$dir/$log" | gzip -9n > "$dest/$log.gz"
    fi
  done
  ev=$base/eval/$engine-$sched/runs/$sub/drbuddi
  if [[ -f $ev/metrics.json ]]; then
    cp "$ev/metrics.json" "$ev/field_hz.nii.gz" "$ev/bbr.mat" "$dest/"
  fi
  if [[ $engine == chromium && $sub == ds005134-sub-01 ]]; then
    gzip -9nc "$dir/up.nii" > "$dest/up.nii.gz"
    gzip -9nc "$dir/down.nii" > "$dest/down.nii.gz"
  fi
done
(cd "$out" && find . -type f ! -path ./SHA256SUMS -printf '%P\n' | sort | xargs sha256sum) > "$out/SHA256SUMS"
du -sh "$out"
find "$out" -type f | wc -l
