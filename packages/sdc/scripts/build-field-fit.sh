#!/usr/bin/env bash
# Rebuild the committed sdc-field-fit WebAssembly module (src/sdc-field-fit.wasm) from exes/dwi/sdc-wasm.
# The separate @neurodesk/sdc/field-fit entry point loads it in browsers and Node.
#
#   build-wasm.sh          rebuild src/sdc-field-fit.wasm from the Rust source
#   build-wasm.sh --check  rebuild into a scratch directory and fail unless it equals src/sdc-field-fit.wasm
#
# The bytes depend on rustc and on binaryen's wasm-opt, so both are pinned. Panic locations embed
# source paths, so the repository and the Cargo home are remapped to fixed prefixes: a checkout in
# another directory produces the same binary.
set -euo pipefail
cd "$(dirname "$0")/.."

RUST_TOOLCHAIN=1.98.0
WASM_OPT_VERSION=version_117

mode=build
if [[ $# -gt 0 ]]; then
  if [[ "$1" != --check || $# -gt 1 ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
  fi
  mode=check
fi

WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || echo "$HOME/.cache/binaryen/bin/wasm-opt")}"
optimizer=$("$WASM_OPT" --version 2>/dev/null || true)
if [[ "$optimizer" != *"($WASM_OPT_VERSION)"* ]]; then
  echo "binaryen $WASM_OPT_VERSION wasm-opt is required (found '${optimizer:-none}'), as .github/actions/setup-wasm-opt installs it" >&2
  exit 1
fi

repo="$(cd ../.. && pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
# The checked CSR working budget fits within the 4 GiB wasm32 heap.
export RUSTFLAGS="--remap-path-prefix=$repo=/webapps --remap-path-prefix=$cargo_home=/cargo -C link-arg=--max-memory=4294967296"

scratch="$(mktemp -d -t sdc-field-fit-wasm.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
cargo build --manifest-path ../../exes/dwi/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown -p sdc-wasm --target-dir "$scratch/target"
"$WASM_OPT" -O3 "$scratch/target/wasm32-unknown-unknown/release/sdc_wasm.wasm" -o "$scratch/sdc-field-fit.wasm"

if [[ "$mode" == check ]]; then
  if cmp -s "$scratch/sdc-field-fit.wasm" src/sdc-field-fit.wasm; then
    echo "PASS src/sdc-field-fit.wasm equals a rebuild from source ($(sha256sum < src/sdc-field-fit.wasm | cut -c1-16))"
    exit 0
  fi
  echo "FAIL src/sdc-field-fit.wasm differs from a rebuild from source: committed $(sha256sum < src/sdc-field-fit.wasm | cut -c1-16), rebuilt $(sha256sum < "$scratch/sdc-field-fit.wasm" | cut -c1-16)" >&2
  echo "Run 'pnpm --filter @neurodesk/sdc build:field-fit' and commit src/sdc-field-fit.wasm." >&2
  exit 1
fi

cp "$scratch/sdc-field-fit.wasm" src/sdc-field-fit.wasm
echo "built src/sdc-field-fit.wasm ($(wc -c < src/sdc-field-fit.wasm) bytes)"
