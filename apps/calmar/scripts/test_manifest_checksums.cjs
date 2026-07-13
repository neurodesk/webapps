#!/usr/bin/env node
// Phase 25: verify cached/committed asset bytes match the manifest's
// declared sha256 checksum. Catches three regression classes:
//
// 1. The committed `tests/fixtures/yeo7-mini/atlas.nii.gz` drifts from
//    the runtime asset (manifest says yeo7-2mm@sha256:X, fixture is
//    sha256:Y).
// 2. A model rebuild lands in `web/models/_dev_cache/` without a
//    matching manifest checksum bump (cacheKey collision, browser
//    serves stale cached bytes).
// 3. A manifest typo where `filename`/`sourceUrl` doesn't match the
//    actual asset id.
//
// The check is opportunistic — assets without a local copy in the dev
// cache or fixtures dir are skipped (most CI runners don't fetch the
// 200 MB of weights). At least one hash is required to pass so the
// gate doesn't silently no-op.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
const DEV_CACHE = path.join(ROOT, 'web/models/_dev_cache');
const FIXTURES = path.join(ROOT, 'tests/fixtures');

// Build candidate paths for each asset id. Tries the dev cache (whose
// filenames mirror the manifest's `filename` basename) and a couple of
// fixture conventions (yeo7 has a committed atlas under yeo7-mini/).
function candidatePaths(asset) {
  const paths = [];
  const base = path.basename(asset.filename || asset.id || '');
  if (base) paths.push(path.join(DEV_CACHE, base));
  if (asset.filename) paths.push(path.join(ROOT, 'web/models', asset.filename));
  // Fixture overrides for committed copies.
  if (asset.id === 'yeo7-2mm') paths.push(path.join(FIXTURES, 'yeo7-mini/atlas.nii.gz'));
  return paths;
}

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let verified = 0;
let skipped = 0;
let failures = 0;

for (const key of ['modelAssets', 'atlasAssets', 'connectomeAssets', 'annotationAssets']) {
  for (const asset of MANIFEST[key] || []) {
    const checksum = asset.checksum;
    if (!checksum || !checksum.startsWith('sha256:')) continue;
    const expected = checksum.slice('sha256:'.length).toLowerCase();
    // Verify every candidate path that exists, not just the first —
    // the committed fixture and the dev cache copy must independently
    // match the manifest checksum.
    const found = candidatePaths(asset).filter(p => fs.existsSync(p));
    if (found.length === 0) {
      skipped++;
      continue;
    }
    for (const filePath of found) {
      const actual = sha256(filePath);
      if (actual === expected) {
        verified++;
        console.log(`OK ${asset.id.padEnd(22)} ${path.relative(ROOT, filePath)}`);
      } else {
        failures++;
        console.error(
          `MISMATCH ${asset.id}\n` +
          `  expected ${expected}\n` +
          `  actual   ${actual}\n` +
          `  file     ${path.relative(ROOT, filePath)}`
        );
      }
    }
  }
}

assert.equal(failures, 0, `${failures} asset(s) failed sha256 verification`);
assert.ok(verified >= 1,
  'No assets verified — at least the committed Yeo7 fixture must be present and match');

console.log(`\nmanifest-checksums OK: ${verified} verified, ${skipped} skipped (not present locally).`);
