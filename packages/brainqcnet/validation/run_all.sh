#!/bin/sh
# Usage: run_all.sh <dir of *_T1w.nii.gz> <ref dir>
IN=$1; REF=$2
for f in "$IN"/*_T1w.nii.gz; do
  name=$(basename "$f" _T1w.nii.gz)
  [ -f "$REF/$name/tot_df.csv" ] && continue
  sub=$(echo "$name" | cut -d_ -f1)
  docker run --rm --user $(id -u):$(id -g) --entrypoint sh -v "$IN":/cand:ro -v "$REF":/ref -v "$(cd "$(dirname "$0")" && pwd)":/harness:ro -v "$MODELS":/saved_models:ro garciaml/brainqcnetcpu:latest /harness/run_reference.sh "/cand/$(basename "$f")" "/ref/$name" /saved_models/resnet152/19112020/ "$sub"
  echo "done $name"
done
