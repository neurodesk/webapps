#!/usr/bin/env bash
# Stage the parts of @neurodesk/easy-mp2rage the static app loads (its committed WASM core and
# JS glue) into web/vendor/easy-mp2rage/. The command line runs the same files.
set -euo pipefail
cd "$(dirname "$0")/.."

package=../../packages/easy-mp2rage
rm -rf web/vendor/easy-mp2rage web/wasm
mkdir -p web/vendor/easy-mp2rage/src
cp -R "$package/wasm" web/vendor/easy-mp2rage/wasm
cp "$package/src/nifti.js" "$package/src/outputs.js" web/vendor/easy-mp2rage/src/
echo "staged @neurodesk/easy-mp2rage -> web/vendor/easy-mp2rage/"
