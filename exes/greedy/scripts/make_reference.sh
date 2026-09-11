#!/usr/bin/env bash
# Generate deterministic Greedy reference outputs for the v1 workflows, once
# with -float and once in Greedy's default double precision. The spread
# between the two is the acceptance tolerance for greedy-rs.
# Usage: ./scripts/make_reference.sh /path/to/greedy [data-dir] [output-dir]
set -euo pipefail

GREEDY="${1:?usage: $0 /path/to/greedy [data-dir] [output-dir]}"
DATA="${2:-../../../allineate-benchmark}"
OUT="${3:-tests/reference}"
FIXED="$DATA/MNI152_T1_1mm.nii.gz"
MOVING="$DATA/T1_head.nii.gz"

mkdir -p "$OUT"
: > "$OUT/commands.txt"

run() {
  printf '%q ' "$GREEDY" "$@" >> "$OUT/commands.txt"
  printf '\n' >> "$OUT/commands.txt"
  "$GREEDY" "$@"
}

for P in float double; do
  FLAG=""; [ "$P" = float ] && FLAG="-float"
  run -V 0 $FLAG -threads 1 -d 3 -a -m SSD -i "$FIXED" "$MOVING" \
    -o "$OUT/ssd_aff_$P.mat" -ia-image-centers -jitter 0 -n 100x50x10
  run -V 0 $FLAG -threads 1 -d 3 -a -m NMI -i "$FIXED" "$MOVING" \
    -o "$OUT/nmi_aff_$P.mat" -ia-image-centers -jitter 0 -n 100x50x10
  run -V 0 $FLAG -threads 1 -d 3 -m NMI -i "$FIXED" "$MOVING" \
    -it "$OUT/nmi_aff_$P.mat" -o "$OUT/nmi_warp_$P.nii.gz" -sv -n 100x50x10
  run -V 0 $FLAG -threads 1 -d 3 -rf "$FIXED" -rm "$MOVING" "$OUT/nmi_reslice_$P.nii.gz" \
    -r "$OUT/nmi_warp_$P.nii.gz" "$OUT/nmi_aff_$P.mat"
done

(cd "$OUT" && shasum -a 256 *.mat *.nii.gz commands.txt > SHA256SUMS)
