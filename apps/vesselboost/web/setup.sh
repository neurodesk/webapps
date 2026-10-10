#!/bin/bash
# One-time setup: fetch the manifest-pinned ONNX Runtime Web files and build
# the required Rust preprocessing WASM. File names, URLs, and sha256 checksums
# come from runtime-assets/manifest.json via the shared fetcher.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../../../scripts/fetch-app-runtime.mjs" --dest "$SCRIPT_DIR/wasm" \
  ort-web:ort.webgpu.bundle.min.mjs,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm

# Preprocessing is a required, committed artifact. Source rebuilds run in native CI.
node "$SCRIPT_DIR/../../../packages/vesselboost/scripts/verify-preprocessing.mjs"
node "$SCRIPT_DIR/../../../packages/vesselboost/scripts/stage-browser.mjs"

node "$SCRIPT_DIR/../../../scripts/fetch-app-runtime.mjs" --dest "$SCRIPT_DIR/runtime" niivue-legacy:niivue.umd.js
