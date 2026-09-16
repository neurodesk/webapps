#!/bin/bash
# One-time setup: fetch the manifest-pinned ONNX Runtime Web and QSM WASM
# files. File names, URLs, and sha256 checksums come from
# runtime-assets/manifest.json via the shared fetcher, which also removes
# stale ONNX Runtime loader files from previous versions.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../../../scripts/fetch-app-runtime.mjs" --dest "$SCRIPT_DIR/wasm" \
  ort-web:ort.webgpu.bundle.min.mjs,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm \
  qsm-wasm:qsm_wasm.js,qsm_wasm_bg.wasm
