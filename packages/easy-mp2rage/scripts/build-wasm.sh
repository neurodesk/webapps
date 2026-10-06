#!/usr/bin/env bash
# Rebuild the committed MP2RAGE WebAssembly core in wasm/ after a change to the Rust crates.
# The web app stages this directory and the command line loads it, so both run the same binary.
#
#   build-wasm.sh          rebuild wasm/ from the Rust source
#   build-wasm.sh --check  rebuild into a scratch directory and fail unless every file equals wasm/
#
# The build is reproducible byte for byte given the pinned toolchain below (rustc, wasm-pack and
# the binaryen wasm-opt that wasm-pack takes from PATH all change the output). Panic messages embed
# source paths, so the Cargo home is remapped to a fixed prefix: a runner with a different home
# directory then produces the same binary.
set -euo pipefail
cd "$(dirname "$0")/.."

RUST_TOOLCHAIN=1.98.0
WASM_PACK_VERSION=0.13.1
WASM_OPT_VERSION=version_117
FILES=(mp2rage_wasm.js mp2rage_wasm_bg.wasm mp2rage_wasm.d.ts)

mode=build
if [[ $# -gt 0 ]]; then
  if [[ "$1" != --check || $# -gt 1 ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
  fi
  mode=check
fi

WASM_PACK="${WASM_PACK:-$(command -v wasm-pack || true)}"
if [[ -z "$WASM_PACK" ]]; then
  echo "wasm-pack $WASM_PACK_VERSION is required to build Easy MP2RAGE" >&2
  exit 1
fi
installed=$("$WASM_PACK" --version | awk '{print $2}')
if [[ "$installed" != "$WASM_PACK_VERSION" ]]; then
  echo "wasm-pack $WASM_PACK_VERSION is required (found $installed)" >&2
  exit 1
fi

optimizer=$(wasm-opt --version 2>/dev/null || true)
if [[ "$optimizer" != *"($WASM_OPT_VERSION)"* ]]; then
  echo "binaryen $WASM_OPT_VERSION wasm-opt must be on PATH (found '${optimizer:-none}'), as .github/actions/setup-wasm-opt installs it" >&2
  exit 1
fi

export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo"

crate=../../apps/easy-mp2rage/crates/mp2rage-wasm
scratch="$(mktemp -d -t easy-mp2rage-wasm.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
"$WASM_PACK" build "$crate" --target web --release --out-dir "$scratch"

if [[ "$mode" == check ]]; then
  status=0
  for file in "${FILES[@]}"; do
    if cmp -s "$scratch/$file" "wasm/$file"; then
      echo "PASS wasm/$file equals a rebuild from source ($(sha256sum < "wasm/$file" | cut -c1-16))"
    else
      echo "FAIL wasm/$file differs from a rebuild from source: committed $(sha256sum < "wasm/$file" | cut -c1-16), rebuilt $(sha256sum < "$scratch/$file" | cut -c1-16)"
      status=1
    fi
  done
  if [[ $status -ne 0 ]]; then
    echo "Run 'pnpm --filter @neurodesk/easy-mp2rage build:wasm' and commit wasm/." >&2
  fi
  exit $status
fi

rm -rf wasm
mkdir -p wasm
for file in "${FILES[@]}"; do
  cp "$scratch/$file" wasm/
done
echo "built wasm -> packages/easy-mp2rage/wasm/ ($(wc -c < wasm/mp2rage_wasm_bg.wasm) bytes)"
