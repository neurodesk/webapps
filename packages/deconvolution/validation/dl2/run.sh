#!/usr/bin/env bash
# Regenerate ../rltv-dl2.json: see README.md. PYTHON must have ../requirements.txt installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
work="$(mktemp -d -t deconvolution-dl2.XXXXXX)"
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/DeconvolutionLab_2.jar" https://bigwww.epfl.ch/deconvolution/deconvolutionlab2/DeconvolutionLab_2.jar
curl -fsSL -o "$work/ij.jar" https://repo1.maven.org/maven2/net/imagej/ij/1.54p/ij-1.54p.jar
echo "37ade1a14b7063b5a1c9b53d685379cc45b3704d023db1d10dbeae92b0a6762c  $work/DeconvolutionLab_2.jar" | sha256sum -c -

node "$here/ours.mjs" psf "$work"
"$python" -I "$here/phantom.py" "$work"
node "$here/ours.mjs" deconvolve "$work"
for run in $(node -e 'for (const [n, i, w] of require(process.argv[1])) console.log(`${n}:${i}:${w}`)' "$here/runs.json"); do
  IFS=: read -r name iterations weight <<<"$run"
  algorithm="RL $iterations"
  if [[ "$weight" != 0 ]]; then algorithm="RLTV $iterations $weight"; fi
  docker run --rm -v "$work:/w" -w /w eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a \
    java -Djava.awt.headless=true -cp DeconvolutionLab_2.jar:ij.jar DeconvolutionLab2 Run \
    -image file /w/image.tif -psf file /w/psf.tif -algorithm $algorithm -norm 1 -monitor no \
    -out stack "dl2_$name" noshow -path /w > /dev/null
done
"$python" -I "$here/compare.py" "$work" "$here/runs.json" > "$here/../rltv-dl2.json"
cat "$here/../rltv-dl2.json"
