#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(rustc --version)" == 'rustc 1.98.0 '* ]] || { echo 'Rust 1.98.0 is required' >&2; exit 1; }
[[ "$(wasm-pack --version)" == 'wasm-pack 0.13.1' ]] || { echo 'wasm-pack 0.13.1 is required' >&2; exit 1; }
[[ "$(wasm-bindgen --version)" == 'wasm-bindgen 0.2.114' ]] || { echo 'wasm-bindgen 0.2.114 is required' >&2; exit 1; }
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cd "$package_dir/../../apps/vesselboost/rust-preprocessing"
wasm-pack build --locked --target web --out-dir "$package_dir/preprocessing" --release
rm -f "$package_dir/preprocessing/.gitignore" "$package_dir/preprocessing/package.json" "$package_dir/preprocessing/README.md"
node "$package_dir/scripts/verify-preprocessing.mjs" --record
