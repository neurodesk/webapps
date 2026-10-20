#!/usr/bin/env bash
# Build wasm/n4-bias.{mjs,wasm}: ANTs N4BiasFieldCorrection at the ANTs commit and ITK-Wasm
# Emscripten image that packages/registration pins. Docker, curl and tar are required.
#
#   bash packages/n4/scripts/build.sh /absolute/build/dir
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
build=${1:?Pass an absolute build directory outside the repository}
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$build"
commit=52bc0ab588102682587303d31c720de94e6ef6c1
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
if [ ! -f "$build/ants-$commit/Examples/N4BiasFieldCorrection.cxx" ]; then
  curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$commit" -o "$build/ants.tar.gz"
  mkdir -p "$build/ants-$commit"
  tar -xzf "$build/ants.tar.gz" --strip-components=1 -C "$build/ants-$commit"
fi
# One compile job; the container memory limit keeps a large ITK translation unit from exhausting the host.
docker run --rm --network none --memory "${N4_BUILD_MEMORY:-8g}" --entrypoint bash \
  -v "$build:/build" -v "$root/packages/n4:/source:ro" \
  "$toolchain" -c "emcmake cmake -S /source -B /build/wasm -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$commit -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm -j 1"
cp "$build/wasm/n4-bias.mjs" "$build/wasm/n4-bias.wasm" "$root/packages/n4/wasm/"
sha256sum "$root/packages/n4/wasm/n4-bias.wasm"
