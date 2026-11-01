#!/usr/bin/env bash
# Native builds for the #462 precision tests, with the compiler flags of the reference's
# SuperBuild (sdc/reference/env/ants-cmake-cache-excerpt.txt: Release, -mtune=native -march=corei7).
#
#   bash native/build.sh /absolute/build/dir
#
# 1. ITK 5.4.3 through ANTs 52bc0ab's SuperBuild (target ITKv5 only, about 30 minutes on 14 cores).
# 2. Four builds of native/CMakeLists.txt against it, each with hmc-native (src/main.cxx: the
#    kernel's argv[0] dispatch) and DenoiseImage:
#      stock/    3D float and 3D double, ITK unchanged
#      pdf64/    3D float, Mattes PDFs and value in double (mattes-pdf-double.cmake)
#      deriv64/  as pdf64, and the Mattes global-support derivative in double
#      fma/      as stock with -march=native: a rounding-only perturbation of the double run
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
build=${1:?Pass an absolute build directory}
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
jobs=${JOBS:-$(nproc)}
commit=52bc0ab588102682587303d31c720de94e6ef6c1
flags="-mtune=native -march=corei7"
mkdir -p "$build"
if [ ! -f "$build/ants-$commit/Examples/antsRegistration.cxx" ]; then
  curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$commit" -o "$build/ants.tar.gz"
  mkdir -p "$build/ants-$commit"
  tar -xzf "$build/ants.tar.gz" --strip-components=1 -C "$build/ants-$commit"
fi
cmake -S "$build/ants-$commit" -B "$build/superbuild" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DRUN_SHORT_TESTS=OFF -DRUN_LONG_TESTS=OFF -DBUILD_ALL_ANTS_APPS=OFF \
  -DITK_BUILD_MINC_SUPPORT=OFF -DUSE_VTK=OFF -DSuperBuild_ANTS_USE_GOLD_LINKER=OFF
cmake --build "$build/superbuild" --target ITKv5 -j "$jobs"
variant() {
  local name=$1 arch=$2; shift 2
  cmake -S "$here" -B "$build/$name" -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="$arch" -DCMAKE_C_FLAGS="$arch" \
    -DITK_DIR="$build/superbuild/ITKv5-build" -DANTS_SOURCE_DIR="$build/ants-$commit" "$@"
  cmake --build "$build/$name" -j "$jobs"
}
variant stock "$flags" -DHMC_NATIVE_DOUBLE=ON
variant pdf64 "$flags" -DHMC_MATTES_PDF_DOUBLE=ON -DHMC_MATTES_DERIVATIVE_DOUBLE=OFF
variant deriv64 "$flags" -DHMC_MATTES_PDF_DOUBLE=ON -DHMC_MATTES_DERIVATIVE_DOUBLE=ON
variant fma "-march=native" -DHMC_NATIVE_DOUBLE=ON
sha256sum "$build"/{stock,pdf64,deriv64,fma}/hmc-native "$build/stock/DenoiseImage"
