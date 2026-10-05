#!/usr/bin/env bash
# Rebuild the committed MP2RAGE WebAssembly core in wasm/ after a change to the Rust crates.
# The web app stages this directory and the
# command line loads it, so both run the same binary.
set -euo pipefail
cd "$(dirname "$0")/.."

WASM_PACK="${WASM_PACK:-$(command -v wasm-pack || true)}"
if [[ -z "$WASM_PACK" ]]; then
  echo "wasm-pack is required to build Easy MP2RAGE" >&2
  exit 1
fi
crate=../../apps/easy-mp2rage/crates/mp2rage-wasm
"$WASM_PACK" build "$crate" --target web --release --out-dir pkg

rm -rf wasm
mkdir -p wasm
cp "$crate/pkg/mp2rage_wasm.js" \
   "$crate/pkg/mp2rage_wasm_bg.wasm" \
   "$crate/pkg/mp2rage_wasm.d.ts" \
   wasm/
echo "built wasm -> packages/easy-mp2rage/wasm/ ($(wc -c < wasm/mp2rage_wasm_bg.wasm) bytes)"
