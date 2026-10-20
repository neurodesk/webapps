#!/usr/bin/env bash
# Rebuild the committed dwidenoise WebAssembly module (src/dwidenoise.wasm) from exes/dwi/denoise-wasm.
# The web app stages this file and the command line loads it, so both run the same binary.
#
#   build-wasm.sh          rebuild src/dwidenoise.wasm from the Rust source
#   build-wasm.sh --check  rebuild into a scratch directory and fail unless it equals src/dwidenoise.wasm
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
# --max-memory: the app holds every volume in module memory, so allow the whole 4 GB.
export RUSTFLAGS="--remap-path-prefix=$repo=/webapps --remap-path-prefix=$cargo_home=/cargo -C link-arg=--max-memory=4294967296"

scratch="$(mktemp -d -t dwidenoise-wasm.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
cargo build --manifest-path ../../exes/dwi/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown -p denoise-wasm --target-dir "$scratch/target"
"$WASM_OPT" -O3 "$scratch/target/wasm32-unknown-unknown/release/denoise_wasm.wasm" -o "$scratch/dwidenoise.wasm"

if [[ "$mode" == check ]]; then
  if cmp -s "$scratch/dwidenoise.wasm" src/dwidenoise.wasm; then
    echo "PASS src/dwidenoise.wasm equals a rebuild from source ($(sha256sum < src/dwidenoise.wasm | cut -c1-16))"
    exit 0
  fi
  echo "FAIL src/dwidenoise.wasm differs from a rebuild from source: committed $(sha256sum < src/dwidenoise.wasm | cut -c1-16), rebuilt $(sha256sum < "$scratch/dwidenoise.wasm" | cut -c1-16)" >&2
  echo "Run 'pnpm --filter @neurodesk/dwidenoise build:wasm' and commit src/dwidenoise.wasm." >&2
  exit 1
fi

cp "$scratch/dwidenoise.wasm" src/dwidenoise.wasm
echo "built src/dwidenoise.wasm ($(wc -c < src/dwidenoise.wasm) bytes)"
