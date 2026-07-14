#!/usr/bin/env bash
# Vendor third-party runtime dependencies into web/js/vendor as self-contained
# ES modules. No CDN is used at runtime: the bundles are committed and the app
# makes no external requests. Re-run this to update the pinned versions.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/vendor"
OUT="$HERE/../web/js/vendor"
mkdir -p "$SRC" "$OUT"

cd "$SRC"
if [ ! -f package.json ]; then
  cat > package.json <<'JSON'
{
  "name": "dicom2vid-vendor-build",
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
BUNDLE entry-mp4-muxer.js "$OUT/mp4-muxer.js"
BUNDLE entry-webm-muxer.js "$OUT/webm-muxer.js"

node -e "const v=require('./package.json').devDependencies; require('fs').writeFileSync('$OUT/VERSIONS.txt', Object.entries(v).map(([k,val])=>k+' '+val).join('\n')+'\n')"

echo "Vendored bundles written to web/js/vendor:"
ls -la "$OUT"
