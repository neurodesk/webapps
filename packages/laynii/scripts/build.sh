#!/usr/bin/env bash
# Builds wasm/laynii.{mjs,wasm}: LayNii v2.10.0 (LN2_LAYERS and LN2_PROFILE) using the
# pinned ITK-Wasm Emscripten container image, without pthreads so it needs no SharedArrayBuffer.
# Docker, curl, tar and sha256sum are required.
#
#   bash packages/laynii/scripts/build.sh /absolute/build/dir          rebuild and copy into wasm/
#   bash packages/laynii/scripts/build.sh --check /absolute/build/dir  rebuild and fail unless both
#                                                                      files equal the committed ones
set -euo pipefail
mode=build
if [ "${1:-}" = --check ]; then
  mode=check
  shift
fi
if [ $# -ne 1 ]; then
  echo "usage: $0 [--check] /absolute/build/dir" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/../../.." && pwd)
build=$1
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$build"

commit=9febedf0157740dc7987fa5098f3e53e70a1c915
archive_sha256=826846ffa4b98694dcfdb2b753b79a0151b1090a8f302679141d8b16b6d8a8da
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
source_date_epoch=1772668800

archive="$build/laynii-$commit.tar.gz"
src="$build/laynii-$commit"
if [ ! -f "$archive" ]; then
  curl --fail --location "https://codeload.github.com/layerfMRI/LAYNII/tar.gz/$commit" -o "$archive"
fi
echo "$archive_sha256  $archive" | sha256sum --check --quiet
if [ ! -f "$src/src/LN2_LAYERS.cpp" ]; then
  mkdir -p "$src"
  tar -xzf "$archive" --strip-components=1 -C "$src"
fi

docker run --rm --network none --memory "${LAYNII_BUILD_MEMORY:-4g}" --entrypoint bash \
  -e SOURCE_DATE_EPOCH="$source_date_epoch" \
  -v "$build:/build" -v "$root/packages/laynii:/source:ro" \
  "$toolchain" -c "
    set -euo pipefail
    rm -rf /build/wasm && mkdir -p /build/wasm
    em++ -std=c++11 -O3 \
      -I/build/laynii-$commit/dep -I/build/laynii-$commit/src \
      /source/main.cxx \
      /source/ln2_layers_unit.cxx \
      /source/ln2_profile_unit.cxx \
      /build/laynii-$commit/dep/nifti2_io.cpp \
      /build/laynii-$commit/dep/znzlib.cpp \
      /build/laynii-$commit/dep/laynii_lib.cpp \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLaynii \
      -sERROR_ON_UNDEFINED_SYMBOLS=1 \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=2147483648 \
      -sENVIRONMENT=web,worker,node \
      -sFORCE_FILESYSTEM=1 \
      -sEXPORTED_RUNTIME_METHODS=\"['FS','callMain','stackSave','stackRestore']\" \
      -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
      -o /build/wasm/laynii.mjs
  "

if [ "$mode" = check ]; then
  status=0
  for file in laynii.wasm laynii.mjs; do
    committed=$(sha256sum < "$root/packages/laynii/wasm/$file" | cut -c1-64)
    rebuilt=$(sha256sum < "$build/wasm/$file" | cut -c1-64)
    if cmp -s "$build/wasm/$file" "$root/packages/laynii/wasm/$file"; then
      echo "PASS wasm/$file equals a rebuild from source ($committed)"
    else
      echo "FAIL wasm/$file differs from a rebuild from source: committed $committed, rebuilt $rebuilt" >&2
      status=1
    fi
  done
  if [ "$status" -ne 0 ]; then
    echo "Run 'bash packages/laynii/scripts/build.sh /absolute/build/dir' and commit wasm/." >&2
  fi
  exit "$status"
fi

mkdir -p "$root/packages/laynii/wasm"
cp "$build/wasm/laynii.mjs" "$build/wasm/laynii.wasm" "$root/packages/laynii/wasm/"
sha256sum "$root/packages/laynii/wasm/laynii.mjs" "$root/packages/laynii/wasm/laynii.wasm"
