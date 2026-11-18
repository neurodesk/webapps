#!/usr/bin/env bash
# RESEARCH ONLY. Runs a build's native research tests (native/*.rs, copied by build.sh) with the
# build's arithmetic reference installed, on the pinned recordings, natively with Cargo.
#
#   native.sh BUILD CSS_PIPELINES OUT
#
# BUILD is a build.sh output. CSS_PIPELINES is css-pipelines-reference.json extracted by
# validation/container/download.py. OUT (new) receives css-pipelines.json and the test log.
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 BUILD CSS_PIPELINES OUT" >&2; exit 2; }
build="$(cd "$1" && pwd)"
pipelines="$(cd "$2" && pwd)"
out=$3
if [[ -e "$out" ]]; then
  echo "$out exists; give a new directory" >&2
  exit 1
fi
mkdir -p "$out"
out="$(cd "$out" && pwd)"
export RUSTUP_TOOLCHAIN=1.98.1
export CARGO_TARGET_DIR="$build/target-native"
SAMSRF_MATLAB_CSS_PIPELINES_DIR="$pipelines" SAMSRF_HARNESS_REPORT="$out/css-pipelines.json" \
  cargo test --release --offline --locked --manifest-path "$build/exes/samsrf/Cargo.toml" \
  -p samsrf-wasm --test css_pipelines -- --nocapture > "$out/native.log" 2>&1
grep -E '^test result' "$out/native.log"
