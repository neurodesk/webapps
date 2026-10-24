#!/usr/bin/env bash
# Builds wasm/ants-denoise.{mjs,wasm}: ANTs DenoiseImage with the ITKAdaptiveDenoising filter.
set -euo pipefail
denoise_root=$(cd "$(dirname "$0")/../../.." && pwd)
denoise_build=${1:?Pass an absolute build directory outside the repository}
case "$denoise_build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$denoise_build"
ants_commit=52bc0ab588102682587303d31c720de94e6ef6c1
ants_sha256=727dac610fb78159e63738a72376fe127917dcee6c9c8567538c8ea6cd647764
ad_commit=24825c8d246e941334f47968553f0ae388851f0c
ad_sha256=7fe6328375f8869865380b73fbf60ec2ce0afb33ff15839ee41a0abc1a6d2582
denoise_toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
fetch() {
  local url=$1 archive=$2 sha256=$3 directory=$4
  if [ ! -f "$archive" ]; then
    curl --fail --location "$url" -o "$archive"
  fi
  echo "$sha256  $archive" | sha256sum --check --quiet
  if [ ! -d "$directory" ]; then
    mkdir -p "$directory"
    tar -xzf "$archive" --strip-components=1 -C "$directory"
  fi
}
fetch "https://codeload.github.com/ANTsX/ANTs/tar.gz/$ants_commit" \
  "$denoise_build/ants-$ants_commit.tar.gz" "$ants_sha256" "$denoise_build/ants-$ants_commit"
fetch "https://codeload.github.com/ntustison/ITKAdaptiveDenoising/tar.gz/$ad_commit" \
  "$denoise_build/adaptive-denoising-$ad_commit.tar.gz" "$ad_sha256" "$denoise_build/adaptive-denoising-$ad_commit"
docker run --rm --network none --entrypoint bash \
  -v "$denoise_build:/build" -v "$denoise_root/packages/ants-denoise:/source:ro" \
  "$denoise_toolchain" -c "emcmake cmake -S /source -B /build/wasm-denoise -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$ants_commit -DAD_SOURCE_DIR=/build/adaptive-denoising-$ad_commit -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm-denoise -j 2"
cp "$denoise_build/wasm-denoise/ants-denoise.mjs" "$denoise_build/wasm-denoise/ants-denoise.wasm" "$denoise_root/packages/ants-denoise/wasm/"
sha256sum "$denoise_root/packages/ants-denoise/wasm/ants-denoise.wasm"
