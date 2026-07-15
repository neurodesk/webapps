#!/bin/bash
# One-time setup: download ONNX Runtime Web WASM files for the LNM webapp.
# Run from anywhere: `bash web/setup.sh`.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SCRIPT_DIR/wasm"

# ONNX Runtime Web. The module-worker (web/js/inference-worker.js) imports
# the ESM bundle (.mjs); the sibling .wasm and .jsep.mjs/.wasm files are
# loaded on demand by the bundle.
ORT_VERSION="1.21.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

echo "Downloading ONNX Runtime Web v${ORT_VERSION}..."

ORT_FILES=(
  ort.min.js
  ort.webgpu.bundle.min.mjs
  ort-wasm-simd-threaded.mjs
  ort-wasm-simd-threaded.wasm
  ort-wasm-simd-threaded.jsep.mjs
  ort-wasm-simd-threaded.jsep.wasm
)

for f in "${ORT_FILES[@]}"; do
  echo "  $f"
  curl -sL -o "$SCRIPT_DIR/wasm/$f" "$ORT_BASE/$f"
done

echo ""
echo "Done. ORT files saved to wasm/."
echo "LNM model assets (SynthStrip, atlases, connectomes) are fetched at"
echo "runtime from the manifest URLs (see web/models/manifest.json)."
