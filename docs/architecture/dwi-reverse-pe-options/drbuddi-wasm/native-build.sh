#!/usr/bin/env bash
# Build the #596 DR-BUDDI probe natively (x86-64) in the same pinned ITK-Wasm
# container as the WebAssembly build: the same TORTOISE commit and VNL patch,
# the same Boost headers, the container's own ITK source (/ITK), and the
# container's clang 20 (the compiler behind its emcc), at -O3.
# Usage: native-build.sh PROBE_SOURCE_DIR ABSOLUTE_BUILD_DIR [JOBS]
set -euo pipefail
probe=$(cd "${1:?probe source (exes/drbuddi-probe)}" && pwd)
build=${2:?absolute build directory}
jobs=${3:-16}
here=$(cd "$(dirname "$0")" && pwd)
commit=1ffb8f362e8e8487d7a82cb8310d2532a9da5253
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
mkdir -p "$build"
if [ ! -d "$build/tortoise/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/QMICodeBase/TORTOISEV4.git "$build/tortoise"
fi
git -C "$build/tortoise" checkout --detach "$commit"
if git -C "$build/tortoise" apply --check "$probe/itk-vnl.patch"; then
  git -C "$build/tortoise" apply "$probe/itk-vnl.patch"
fi
git -C "$build/tortoise" diff --no-ext-diff --binary | cmp "$probe/itk-vnl.patch" -
if [ ! -f "$build/boost_1_90_0.tar.bz2" ]; then
  curl --fail --location --retry 3 https://archives.boost.io/release/1.90.0/source/boost_1_90_0.tar.bz2 -o "$build/boost_1_90_0.tar.bz2.partial"
  mv "$build/boost_1_90_0.tar.bz2.partial" "$build/boost_1_90_0.tar.bz2"
fi
echo "49551aff3b22cbc5c5a9ed3dbc92f0e23ea50a0f7325b0d198b705e8ee3fc305  $build/boost_1_90_0.tar.bz2" | sha256sum --check
mkdir -p "$build/boost"
[ -d "$build/boost/boost" ] || tar -xjf "$build/boost_1_90_0.tar.bz2" -C "$build/boost" --strip-components=1 boost_1_90_0/boost boost_1_90_0/LICENSE_1_0.txt
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint bash \
  -v "$build:/build" -v "$probe:/source:ro" -v "$here/native:/native:ro" \
  -v "$build/tortoise:/tortoise:ro" -v "$build/boost:/boost-headers:ro" \
  -e CC=/emsdk/upstream/bin/clang -e CXX=/emsdk/upstream/bin/clang++ \
  "$toolchain" -c "set -e
    # The image exports the Emscripten toolchain file and wasm compiler flags.
    unset CMAKE_TOOLCHAIN_FILE CFLAGS CXXFLAGS LDFLAGS
    if [ ! -f /build/itk-native/ITKConfig.cmake ]; then
      cmake -G Ninja -S /ITK -B /build/itk-native -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF -DITK_BUILD_DEFAULT_MODULES=ON
      cmake --build /build/itk-native -j$jobs
    fi
    cmake -G Ninja -S /native -B /build/native -DITK_DIR=/build/itk-native -DCMAKE_BUILD_TYPE=Release
    cmake --build /build/native -j$jobs"
sha256sum "$build/native/drbuddi-probe"
