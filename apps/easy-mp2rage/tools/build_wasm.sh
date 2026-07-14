#!/usr/bin/env bash
# Build the WASM core and stage it into web/wasm/ for the static app.
set -euo pipefail
cd "$(dirname "$0")/.."

WASM_PACK="${WASM_PACK:-$(command -v wasm-pack || true)}"
if [[ -z "$WASM_PACK" ]]; then
  echo "wasm-pack is required to build Easy MP2RAGE" >&2
  exit 1
fi
"$WASM_PACK" build crates/mp2rage-wasm --target web --release --out-dir pkg

rm -rf web/wasm
mkdir -p web/wasm
cp crates/mp2rage-wasm/pkg/mp2rage_wasm.js \
   crates/mp2rage-wasm/pkg/mp2rage_wasm_bg.wasm \
   crates/mp2rage-wasm/pkg/mp2rage_wasm.d.ts \
   web/wasm/
echo "staged wasm -> web/wasm/ ($(ls -la web/wasm/mp2rage_wasm_bg.wasm | awk '{print $5}') bytes)"
