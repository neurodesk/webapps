#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(rustc --version)" == 'rustc 1.98.0 '* ]] || { echo 'Rust 1.98.0 is required' >&2; exit 1; }
[[ "$(wasm-pack --version)" == 'wasm-pack 0.13.1' ]] || { echo 'wasm-pack 0.13.1 is required' >&2; exit 1; }
[[ "$(wasm-bindgen --version)" == 'wasm-bindgen 0.2.114' ]] || { echo 'wasm-bindgen 0.2.114 is required' >&2; exit 1; }
task_bindgen_path="$(command -v wasm-bindgen)"
task_bindgen_sha="$(node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex')" "$task_bindgen_path")"
[[ "$task_bindgen_sha" == 'bbc726fb17a79c004d2dcb979977be5f49e3f057fa579364c33d838153849ab7' ]] || { echo 'Use the byte-pinned official wasm-bindgen 0.2.114 Linux x64 musl release; source-built CLI producer metadata differs' >&2; exit 1; }
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
task_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
task_repo_root="$(cd "$package_dir/../.." && pwd)"
# Panic source locations must not embed a developer's checkout or Cargo cache.
export RUSTFLAGS="--remap-path-prefix=$task_cargo_home=/cargo --remap-path-prefix=$task_repo_root=/workspace"
cd "$package_dir/../../apps/vesselboost/rust-preprocessing"
wasm-pack build --locked --target web --out-dir "$package_dir/preprocessing" --release
rm -f "$package_dir/preprocessing/.gitignore" "$package_dir/preprocessing/package.json" "$package_dir/preprocessing/README.md"
node "$package_dir/scripts/verify-preprocessing.mjs" --record
