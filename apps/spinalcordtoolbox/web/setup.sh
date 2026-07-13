#!/bin/bash
# One-time setup: download ONNX Runtime Web WASM files
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SCRIPT_DIR/wasm"

# ONNX Runtime Web
ORT_VERSION="1.21.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

echo "Downloading ONNX Runtime Web v${ORT_VERSION}..."

ORT_FILES=(
  ort.webgpu.min.js
  ort-wasm-simd-threaded.mjs
  ort-wasm-simd-threaded.wasm
  ort-wasm-simd-threaded.jsep.mjs
  ort-wasm-simd-threaded.jsep.wasm
)

for f in "${ORT_FILES[@]}"; do
  echo "  $f"
  curl -sL -o "$SCRIPT_DIR/wasm/$f" "$ORT_BASE/$f"
done

echo "Done. Files saved to wasm/"

# Vertebral labeling assets
HF_DATASET_ASSET_REVISION="55c9462a14bc9c84cf093c348cffda9148099df9"
HF_DATASET_ASSET_BASE="https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/${HF_DATASET_ASSET_REVISION}"
mkdir -p "$SCRIPT_DIR/models/templates/PAM50"
echo "Downloading PAM50 vertebral labeling assets..."
for f in PAM50_t2.nii.gz PAM50_levels.nii.gz; do
  echo "  $f"
  curl -sL -o "$SCRIPT_DIR/models/templates/PAM50/$f" "$HF_DATASET_ASSET_BASE/web/models/templates/PAM50/$f"
done

mkdir -p "$SCRIPT_DIR/models/c2c3_disc_models"
SCT_DATA_BASE="https://raw.githubusercontent.com/spinalcordtoolbox/spinalcordtoolbox/master/data/c2c3_disc_models"
for f in t1_model.yml t2_model.yml; do
  echo "  $f"
  curl -sL -o "$SCRIPT_DIR/models/c2c3_disc_models/$f" "$SCT_DATA_BASE/$f"
done

echo ""
echo "Note: SCT task metadata is recorded in: $SCRIPT_DIR/models/manifest.json"
echo "      Browser-runnable SCT model assets must be converted and validated before tasks are enabled."
