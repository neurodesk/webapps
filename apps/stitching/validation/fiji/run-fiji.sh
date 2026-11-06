#!/bin/sh
# Runs Fiji's Grid/Collection stitching (Stitching 3.1.8) headless on the example tiles, as
# recorded in TileConfiguration.registered.txt and pairs.tsv here.
#
#   sh run-fiji.sh <directory with the 16 example tiles> <output directory>
#
# Fiji writes TileConfiguration.txt and TileConfiguration.registered.txt into the tile
# directory and the fused image into the output directory. pairs.tsv is the pairwise lines of
# its log ("A <- B: (dx, dy) correlation (R)=r"), one tab-separated row per pair, sorted.
set -eu
tiles=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
cp "$here/grid-collection-stitching.ijm" "$out/stitch.ijm"
docker run --rm -v "$tiles:/data" -v "$out:/out" \
  --entrypoint /opt/fiji/Fiji.app/ImageJ-linux64 \
  fiji/fiji@sha256:6ca1105db5b8f4234baab107f7b833ba0f5da64770ef48dddabb954990d68120 \
  --headless --console -macro /out/stitch.ijm > "$out/log.txt" 2>&1
grep 'correlation (R)' "$out/log.txt" \
  | sed -E 's/^(\S+)\[1\] <- (\S+)\[1\]: \(([^,]+), ([^)]+)\) correlation \(R\)=([0-9.E-]+).*/\1\t\2\t\3\t\4\t\5/' \
  | sort > "$out/pairs.tsv"
