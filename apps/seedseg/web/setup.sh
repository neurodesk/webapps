#!/bin/bash
# One-time setup: download ONNX Runtime Web and QSM WASM files.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SCRIPT_DIR/wasm"

download() {
  local url="$1"
  local destination="$2"
  local temporary
  temporary="$(mktemp "$SCRIPT_DIR/wasm/.download.XXXXXX")"

  if ! curl --fail --show-error --silent --location \
    --retry 3 --retry-all-errors --output "$temporary" "$url"; then
    rm -f "$temporary"
    return 1
  fi

  mv "$temporary" "$destination"
}

# ONNX Runtime Web
ORT_VERSION="1.21.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

echo "Downloading ONNX Runtime Web v${ORT_VERSION}..."

ORT_FILES=(
  ort.min.js
  ort-wasm-simd-threaded.mjs
  ort-wasm-simd-threaded.wasm
)

# Remove loader files used by ONNX Runtime Web <=1.17. Leaving these in the
# generated directory can hide a failed upgrade and makes source checks inspect
# stale CDN error bodies as JavaScript.
rm -f \
  "$SCRIPT_DIR/wasm/ort-wasm.js" \
  "$SCRIPT_DIR/wasm/ort-wasm.wasm" \
  "$SCRIPT_DIR/wasm/ort-wasm-simd.js" \
  "$SCRIPT_DIR/wasm/ort-wasm-simd.wasm" \
  "$SCRIPT_DIR/wasm/ort-wasm-simd-threaded.js"

for f in "${ORT_FILES[@]}"; do
  echo "  $f"
  download "$ORT_BASE/$f" "$SCRIPT_DIR/wasm/$f"
done

# QSM WASM (bias field correction from QSMbly)
QSM_WASM_VERSION="v0.9.2"
QSM_BASE="https://github.com/astewartau/qsmbly/releases/download/${QSM_WASM_VERSION}"

echo "Downloading QSM WASM ${QSM_WASM_VERSION}..."

QSM_FILES=(
  qsm_wasm.js
  qsm_wasm_bg.wasm
)

for f in "${QSM_FILES[@]}"; do
  echo "  $f"
  download "$QSM_BASE/$f" "$SCRIPT_DIR/wasm/$f"
done

echo "Done. Files saved to wasm/"
