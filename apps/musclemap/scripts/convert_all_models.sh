#!/bin/bash
# Download all MuscleMap .pth weights and convert to quantized ONNX.
#
# Usage (from project root):
#   bash scripts/convert_all_models.sh
#
# Requires: pip install torch monai onnx onnxruntime
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="$PROJECT_ROOT/web/models"
TMP_DIR="$PROJECT_ROOT/.tmp_weights"

mkdir -p "$MODELS_DIR" "$TMP_DIR"

GITHUB_BASE="https://raw.githubusercontent.com/MuscleMap/MuscleMap/main/scripts/models"

# Model definitions: region|out_channels|roi_size|num_res_units
MODELS=(
  "wholebody|100|256|1"
  "abdomen|9|128|2"
  "forearm|6|256|1"
  "leg|15|128|2"
  "pelvis|14|128|2"
  "thigh|29|128|2"
)

FAILED=0

for entry in "${MODELS[@]}"; do
  IFS='|' read -r region out_channels roi_size num_res_units <<< "$entry"

  pth_url="${GITHUB_BASE}/${region}/contrast_agnostic_${region}_model.pth"
  pth_file="$TMP_DIR/contrast_agnostic_${region}_model.pth"
  onnx_file="$MODELS_DIR/musclemap-${region}.onnx"

  echo ""
  echo "=============================="
  echo "Model: $region (out_channels=$out_channels, roi=$roi_size, res_units=$num_res_units)"
  echo "=============================="

  # Download .pth if not already cached
  if [ ! -f "$pth_file" ]; then
    echo "Downloading $pth_url ..."
    curl -fSL -o "$pth_file" "$pth_url" || {
      echo "ERROR: Failed to download $region model"
      FAILED=$((FAILED + 1))
      continue
    }
  else
    echo "Using cached weights: $pth_file"
  fi

  # Convert to quantized ONNX
  python3 "$SCRIPT_DIR/convert_model.py" \
    --checkpoint "$pth_file" \
    --output "$onnx_file" \
    --quantize \
    --out-channels "$out_channels" \
    --roi-size "$roi_size" \
    --num-res-units "$num_res_units" || {
      echo "ERROR: Conversion failed for $region"
      FAILED=$((FAILED + 1))
      continue
    }

  echo "OK: $onnx_file ($(du -h "$onnx_file" | cut -f1))"
done

# Remove old quantized wholebody model if it exists
if [ -f "$MODELS_DIR/musclemap-wholebody-q8.onnx" ]; then
  echo ""
  echo "Removing old musclemap-wholebody-q8.onnx..."
  rm "$MODELS_DIR/musclemap-wholebody-q8.onnx"
fi

echo ""
echo "=============================="
if [ $FAILED -eq 0 ]; then
  echo "All models converted successfully."
else
  echo "$FAILED model(s) failed. See errors above."
  exit 1
fi

echo ""
echo "Converted models:"
ls -lh "$MODELS_DIR"/*.onnx

echo ""
echo "Temporary weights cached in $TMP_DIR (safe to delete)"
