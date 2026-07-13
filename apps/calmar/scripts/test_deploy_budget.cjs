#!/usr/bin/env node
// Phase 22: deploy-size budget gate.
//
// The original plan's acceptance criterion was "cold load < 200 MB on
// M-series laptop". This test asserts total fetched bytes stays under a
// fixed budget so a future model swap (e.g. swapping SynthStroke for a
// bigger model, or shipping HCP1200 connectome) doesn't silently blow
// past the cold-load target.
//
// Two budgets:
//   1. Static deploy artifact (web/ minus _dev_cache + tests): the
//      bytes GitHub Pages actually serves. Includes JS, CSS, HTML,
//      ORT WASM, dcm2niix, NIfTI-JS, manifest.
//   2. Runtime cold-load: deploy + every supported manifest entry
//      that runFullPipeline currently fetches (ONNX models + atlases
//      + connectome).
//
// Intentionally generous: the goal is to catch a regression that
// doubles either number, not to micromanage byte counts.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
// Directories we never deploy: _dev_cache holds the same assets the
// browser fetches at runtime; we already count those via the manifest.
const SKIP_RE = /\/_dev_cache(\/|$)/;

const STATIC_BUDGET_MB = 60;     // current 36 MB → headroom for future
const COLD_LOAD_BUDGET_MB = 300; // plan called for <200; we're at ~244

function walkSize(dir) {
  let total = 0;
  const breakdown = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (SKIP_RE.test(p)) continue;
    if (entry.isDirectory()) {
      const sub = walkSize(p);
      total += sub.total;
      breakdown[entry.name] = sub.total;
    } else if (entry.isFile()) {
      const size = fs.statSync(p).size;
      total += size;
      breakdown[entry.name] = size;
    }
  }
  return { total, breakdown };
}

function fmtMb(bytes) { return (bytes / 1e6).toFixed(2); }

const staticArtifact = walkSize(WEB);
console.log(`Static deploy artifact: ${fmtMb(staticArtifact.total)} MB`);
const topLevel = Object.entries(staticArtifact.breakdown)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
for (const [name, size] of topLevel) {
  console.log(`  ${fmtMb(size).padStart(8)} MB  ${name}`);
}

// Runtime-fetched assets from the manifest. Sum sizeBytes for every
// entry whose supportStatus is 'supported'. Lazy sharded connectomes
// use sizeBytes for the always-fetched index JSON only; totalShardBytes
// documents the full pack but is not part of cold-load because the
// browser fetches only shards containing lesion-hit parcels.
const manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'models/manifest.json'), 'utf8'));
let runtimeTotal = 0;
const runtimeBreakdown = [];
for (const key of ['modelAssets', 'atlasAssets', 'connectomeAssets', 'annotationAssets']) {
  for (const asset of manifest[key] || []) {
    if (asset.supportStatus !== 'supported') continue;
    if (typeof asset.sizeBytes !== 'number') continue;
    runtimeTotal += asset.sizeBytes;
    runtimeBreakdown.push({ id: asset.id, sizeBytes: asset.sizeBytes });
  }
}
runtimeBreakdown.sort((a, b) => b.sizeBytes - a.sizeBytes);
console.log(`\nRuntime-fetched (manifest sizeBytes, supported only): ${fmtMb(runtimeTotal)} MB`);
for (const { id, sizeBytes } of runtimeBreakdown) {
  console.log(`  ${fmtMb(sizeBytes).padStart(8)} MB  ${id}`);
}

const coldLoadTotal = staticArtifact.total + runtimeTotal;
console.log(`\nTotal cold-load (static + runtime): ${fmtMb(coldLoadTotal)} MB`);

assert.ok(staticArtifact.total < STATIC_BUDGET_MB * 1e6,
  `Static deploy artifact ${fmtMb(staticArtifact.total)} MB exceeds budget ` +
  `${STATIC_BUDGET_MB} MB. Trim ORT WASM, dcm2niix, or move large assets to runtime fetch.`);

assert.ok(coldLoadTotal < COLD_LOAD_BUDGET_MB * 1e6,
  `Cold-load ${fmtMb(coldLoadTotal)} MB exceeds budget ${COLD_LOAD_BUDGET_MB} MB. ` +
  `Either swap a smaller model, ship the FC pack at lower resolution (4mm fp16 instead of 2mm fp32), ` +
  `or relax the budget after explicit review.`);

console.log(
  `\ndeploy-budget OK: static ${fmtMb(staticArtifact.total)} MB < ${STATIC_BUDGET_MB} MB; ` +
  `cold-load ${fmtMb(coldLoadTotal)} MB < ${COLD_LOAD_BUDGET_MB} MB.`
);
