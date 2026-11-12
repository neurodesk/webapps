#!/bin/bash
# One-time setup: fetch the manifest-pinned ONNX Runtime Web and NiiVue files for the LNM
# webapp. Run from anywhere: `bash web/setup.sh`. File names, URLs, and sha256
# checksums come from runtime-assets/manifest.json via the shared fetcher.
# The module-worker (web/js/inference-worker.js) imports the ESM bundle
# (.mjs); the sibling .wasm and .jsep.mjs/.wasm files are loaded on demand.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../../../scripts/fetch-app-runtime.mjs" --dest "$SCRIPT_DIR/wasm" \
  ort-web:ort.min.js,ort.webgpu.bundle.min.mjs,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm niivue-umd:niivue.umd.js

echo ""
echo "LNM model assets (SynthStrip, atlases, connectomes) are fetched at"
echo "runtime from the manifest URLs (see web/models/manifest.json)."
