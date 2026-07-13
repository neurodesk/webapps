#!/bin/bash
# One-time setup: download ONNX Runtime Web WASM files and dcm2niix WASM
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
echo ""
echo "Note: bundled MuscleMap ONNX model files are served from: $SCRIPT_DIR/models/"
