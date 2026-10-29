#!/usr/bin/env bash
# Build a Mattes variant of the kernel (wasm/CMakeLists.txt; pdf64 or deriv64, see
# mattes-pdf-double.cmake) with the command, ANTs commit and toolchain image of scripts/build.sh.
# The result stays in the build directory; the committed kernel in wasm/ is not touched. Use it
# with HMC_WASM_DIR=BUILD_DIR/wasm/kernel.
#
#   bash validation/sdc-gate/build-wasm.sh /absolute/build/dir pdf64|deriv64
set -euo pipefail
package=$(cd "$(dirname "$0")/../.." && pwd)
build=${1:?Pass an absolute build directory outside the repository}
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
case "${2:-}" in pdf64) derivative=OFF ;; deriv64) derivative=ON ;; *) echo 'Pass pdf64 or deriv64' >&2; exit 1 ;; esac
mkdir -p "$build"
commit=52bc0ab588102682587303d31c720de94e6ef6c1
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
if [ ! -f "$build/ants-$commit/Examples/antsRegistration.cxx" ]; then
  curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$commit" -o "$build/ants.tar.gz"
  mkdir -p "$build/ants-$commit"
  tar -xzf "$build/ants.tar.gz" --strip-components=1 -C "$build/ants-$commit"
fi
docker run --rm --network none --memory "${HMC_REGISTRATION_BUILD_MEMORY:-8g}" --entrypoint bash \
  -e SOURCE_DATE_EPOCH=1749580381 -v "$build:/build" -v "$package:/source:ro" "$toolchain" \
  -c "emcmake cmake -S /source/validation/sdc-gate/wasm -B /build/wasm -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$commit -DCMAKE_BUILD_TYPE=Release -DHMC_MATTES_DERIVATIVE_DOUBLE=$derivative && cmake --build /build/wasm -j 1"
sha256sum "$build/wasm/kernel/hmc-registration.wasm"
