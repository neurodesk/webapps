#!/usr/bin/env bash
# Rebuild the committed BET WebAssembly module (wasm/bet.wasm) that the command line loads.
#
#   build-bet-wasm.sh          rebuild wasm/bet.wasm from bet-wasm/
#   build-bet-wasm.sh --check  rebuild into a scratch directory and fail unless it equals wasm/bet.wasm
#
# The build is reproducible byte for byte with the pinned rustc and Cargo.lock. Source paths
# that could reach the binary are remapped to fixed prefixes, so the checkout and Cargo home
# locations do not matter.
set -euo pipefail
cd "$(dirname "$0")/.."

RUST_TOOLCHAIN=1.98.0

mode=build
if [[ $# -gt 0 ]]; then
  if [[ "$1" != --check || $# -gt 1 ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
  fi
  mode=check
fi

export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$PWD=/brain-extraction"
export CARGO_TARGET_DIR="$(mktemp -d -t bet-wasm.XXXXXX)"
trap 'rm -rf "$CARGO_TARGET_DIR"' EXIT
cargo build --manifest-path bet-wasm/Cargo.toml --locked --release --target wasm32-unknown-unknown
built="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bet_wasm.wasm"

if [[ "$mode" == check ]]; then
  if cmp -s "$built" wasm/bet.wasm; then
    echo "PASS wasm/bet.wasm equals a rebuild from source ($(sha256sum < wasm/bet.wasm | cut -c1-16))"
    exit 0
  fi
  echo "FAIL wasm/bet.wasm differs from a rebuild from source: committed $(sha256sum < wasm/bet.wasm | cut -c1-16), rebuilt $(sha256sum < "$built" | cut -c1-16)"
  echo "Run 'pnpm --filter @neurodesk/brain-extraction build:wasm' and commit wasm/bet.wasm." >&2
  exit 1
fi

mkdir -p wasm
cp "$built" wasm/bet.wasm
echo "built packages/brain-extraction/wasm/bet.wasm ($(wc -c < wasm/bet.wasm) bytes)"
