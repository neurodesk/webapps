#!/usr/bin/env bash
set -euo pipefail
syncro_root=$(cd "$(dirname "$0")/../../.." && pwd)
syncro_build=${1:?Pass an absolute build directory outside the repository}
case "$syncro_build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$syncro_build"
syncro_commit=52bc0ab588102682587303d31c720de94e6ef6c1
syncro_toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
if [ ! -f "$syncro_build/ants-$syncro_commit/Examples/antsRegistration.cxx" ]; then
  curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$syncro_commit" -o "$syncro_build/ants.tar.gz"
  mkdir -p "$syncro_build/ants-$syncro_commit"
  tar -xzf "$syncro_build/ants.tar.gz" --strip-components=1 -C "$syncro_build/ants-$syncro_commit"
fi
# Keep the original ANTs build timestamp stable across rebuilds.
docker run --rm --network none --entrypoint bash \
  -e SOURCE_DATE_EPOCH=1788904777 \
  -v "$syncro_build:/build" -v "$syncro_root/packages/registration:/source:ro" \
  "$syncro_toolchain" -c "emcmake cmake -S /source -B /build/wasm -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$syncro_commit -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm -j 1"
cp "$syncro_build/wasm/syncro-registration.mjs" "$syncro_build/wasm/syncro-registration.wasm" "$syncro_root/packages/registration/wasm/"
sha256sum "$syncro_root/packages/registration/wasm/syncro-registration.wasm"
