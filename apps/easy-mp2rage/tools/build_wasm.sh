#!/usr/bin/env bash
# Build @neurodesk/easy-mp2rage (the WASM core and its JS glue) and stage the parts the
# static app loads into web/vendor/easy-mp2rage/. The command line runs the same files.
set -euo pipefail
cd "$(dirname "$0")/.."

package=../../packages/easy-mp2rage
bash "$package/scripts/build-wasm.sh"

rm -rf web/vendor/easy-mp2rage web/wasm
mkdir -p web/vendor/easy-mp2rage/src
cp -R "$package/wasm" web/vendor/easy-mp2rage/wasm
cp "$package/src/nifti.js" "$package/src/outputs.js" web/vendor/easy-mp2rage/src/
echo "staged @neurodesk/easy-mp2rage -> web/vendor/easy-mp2rage/"
