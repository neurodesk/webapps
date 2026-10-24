#!/usr/bin/env bash
# Rebuild the committed hmc WebAssembly module (src/hmc.wasm) from exes/dwi/hmc-wasm.
# The web app and the command line load this file, so both run the same binary.
#
#   build-wasm.sh          rebuild src/hmc.wasm from the Rust source
#   build-wasm.sh --check  rebuild into a scratch directory and fail unless it equals src/hmc.wasm
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
# --max-memory bounds the model heap. The full ds005577 GP series and one fit are validated at 1 GiB.
export RUSTFLAGS="--remap-path-prefix=$repo=/webapps --remap-path-prefix=$cargo_home=/cargo -C link-arg=--max-memory=1073741824"

scratch="$(mktemp -d -t hmc-wasm.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
cargo build --manifest-path ../../exes/dwi/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown -p hmc-wasm --target-dir "$scratch/target"
"$WASM_OPT" -O3 "$scratch/target/wasm32-unknown-unknown/release/hmc_wasm.wasm" -o "$scratch/hmc.wasm"

if [[ "$mode" == check ]]; then
  if cmp -s "$scratch/hmc.wasm" src/hmc.wasm; then
    echo "PASS src/hmc.wasm equals a rebuild from source ($(sha256sum < src/hmc.wasm | cut -c1-16))"
    exit 0
  fi
  echo "FAIL src/hmc.wasm differs from a rebuild from source: committed $(sha256sum < src/hmc.wasm | cut -c1-16), rebuilt $(sha256sum < "$scratch/hmc.wasm" | cut -c1-16)" >&2
  echo "Run 'pnpm --filter @neurodesk/hmc build:wasm' and commit src/hmc.wasm." >&2
  exit 1
fi

cp "$scratch/hmc.wasm" src/hmc.wasm
echo "built src/hmc.wasm ($(wc -c < src/hmc.wasm) bytes)"
