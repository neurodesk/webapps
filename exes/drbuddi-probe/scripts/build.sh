#!/usr/bin/env bash
set -euo pipefail
build=${1:?Usage: build.sh ABSOLUTE_STORAGE_DIRECTORY}
case "$build" in /*) ;; *) echo 'Use an absolute storage path' >&2; exit 2;; esac
source_dir=$(cd "$(dirname "$0")/.." && pwd)
commit=1ffb8f362e8e8487d7a82cb8310d2532a9da5253
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
mkdir -p "$build"
if [ ! -d "$build/tortoise/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/QMICodeBase/TORTOISEV4.git "$build/tortoise"
fi
git -C "$build/tortoise" checkout --detach "$commit"
if git -C "$build/tortoise" apply --check "$source_dir/itk-vnl.patch"; then
  git -C "$build/tortoise" apply "$source_dir/itk-vnl.patch"
else
  git -C "$build/tortoise" apply --reverse --check "$source_dir/itk-vnl.patch"
fi
git -C "$build/tortoise" diff --no-ext-diff --binary > "$build/source.patch"
cmp "$source_dir/itk-vnl.patch" "$build/source.patch"
if [ ! -f "$build/boost_1_90_0.tar.bz2" ]; then
  curl --fail --location --retry 3 https://archives.boost.io/release/1.90.0/source/boost_1_90_0.tar.bz2 -o "$build/boost_1_90_0.tar.bz2.partial"
  echo "49551aff3b22cbc5c5a9ed3dbc92f0e23ea50a0f7325b0d198b705e8ee3fc305  $build/boost_1_90_0.tar.bz2.partial" | sha256sum --check
  mv "$build/boost_1_90_0.tar.bz2.partial" "$build/boost_1_90_0.tar.bz2"
fi
echo "49551aff3b22cbc5c5a9ed3dbc92f0e23ea50a0f7325b0d198b705e8ee3fc305  $build/boost_1_90_0.tar.bz2" | sha256sum --check
mkdir -p "$build/boost"
tar -xjf "$build/boost_1_90_0.tar.bz2" -C "$build/boost" --strip-components=1 boost_1_90_0/boost boost_1_90_0/LICENSE_1_0.txt
docker run --rm --network none --memory "${DRBUDDI_BUILD_MEMORY:-2g}" --entrypoint bash \
  -e SOURCE_DATE_EPOCH=1792800000 \
  -v "$build:/build" -v "$source_dir:/source:ro" \
  -v "$build/tortoise:/tortoise:ro" -v "$build/boost:/boost-headers:ro" \
  "$toolchain" -c 'emcmake cmake -S /source -B /build/wasm -DITK_DIR=/ITK-build -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm -j1'
sha256sum "$build/wasm/drbuddi-probe.wasm"
