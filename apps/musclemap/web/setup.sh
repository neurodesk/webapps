#!/bin/bash
# One-time setup: fetch the manifest-pinned ONNX Runtime Web and NiiVue files and prepare
# MuscleMap model assets. File names, URLs, and sha256 checksums come from
# runtime-assets/manifest.json via the shared fetcher.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../../../scripts/fetch-app-runtime.mjs" --dest "$SCRIPT_DIR/wasm" \
  ort-web:ort.webgpu.bundle.min.mjs,ort.webgpu.min.js,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm niivue-umd:niivue.umd.js

echo ""
node "$SCRIPT_DIR/../scripts/prepare_model_assets.mjs"
echo "Note: MuscleMap verifies immutable model assets and serves deployment parts from the app origin."
