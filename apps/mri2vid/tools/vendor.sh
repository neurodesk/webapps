#!/usr/bin/env bash
# Vendor third-party runtime dependencies as self-contained ES modules: NiiVue
# into web/js/vendor, and the MP4 and WebM muxers into packages/mri2vid/src/vendor,
# which the app and the mri2vid command line share. No CDN is used at runtime:
# the bundles are committed and the app makes no external requests. Re-run this
# to update the pinned versions.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/vendor"
OUT="$HERE/../web/js/vendor"
MUXERS="$HERE/../../../packages/mri2vid/src/vendor"
mkdir -p "$SRC" "$OUT" "$MUXERS"

cd "$SRC"
if [ ! -f package.json ]; then
  cat > package.json <<'JSON'
{
  "name": "mri2vid-vendor-build",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@niivue/niivue": "0.69.0",
    "mp4-muxer": "5.2.2",
    "webm-muxer": "5.1.4",
    "esbuild": "0.28.1"
  }
}
JSON
fi

cat > entry-niivue.js <<'JS'
export { Niivue, NVImage } from '@niivue/niivue';
JS
cat > entry-mp4-muxer.js <<'JS'
export * from 'mp4-muxer';
JS
cat > entry-webm-muxer.js <<'JS'
export * from 'webm-muxer';
JS

npm install --no-audit --no-fund --loglevel=error

BUNDLE() {
  npx --yes esbuild "$1" --bundle --format=esm --platform=browser \
    --target=es2020 --minify --legal-comments=inline --outfile="$2"
}

BUNDLE entry-niivue.js "$OUT/niivue.js"
BUNDLE entry-mp4-muxer.js "$MUXERS/mp4-muxer.js"
BUNDLE entry-webm-muxer.js "$MUXERS/webm-muxer.js"

VERSIONS() {
  node -e "const v=require('./package.json').devDependencies; require('fs').writeFileSync(process.argv[1], process.argv.slice(2).map(k=>k+' '+v[k]).join('\n')+'\n')" "$@"
}
VERSIONS "$OUT/VERSIONS.txt" @niivue/niivue esbuild
VERSIONS "$MUXERS/VERSIONS.txt" mp4-muxer webm-muxer esbuild

echo "Vendored bundles written to web/js/vendor and packages/mri2vid/src/vendor:"
ls -la "$OUT" "$MUXERS"
