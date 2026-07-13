#!/usr/bin/env node --no-warnings

// Asserts that web/models/manifest.json and the in-memory SCT_TASKS table in
// web/js/app/sct-tasks.js agree on every field the runtime relies on. The
// browser worker reads its task config from sct-tasks.js (via SCT_TASKS), while
// fixture-parity scripts read manifest.json — drift between the two silently
// breaks the live app while keeping tests green. This test exists because the
// graymatter task once shipped without `preprocessing.modelAxisOrder: 'zyx'`
// in sct-tasks.js (the manifest had it), causing near-empty masks at runtime.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
const { buildManifest } = await import(pathToFileURL(path.join(ROOT, 'web/js/app/sct-tasks.js')));
const live = buildManifest();

const indexById = (tasks) => Object.fromEntries(tasks.map(t => [t.id, t]));
const manifestTasks = indexById(manifest.tasks);
const liveTasks = indexById(live.tasks);

const manifestIds = Object.keys(manifestTasks).sort();
const liveIds = Object.keys(liveTasks).sort();
assert.deepEqual(liveIds, manifestIds, `Task ID set differs.\n  manifest.json only: ${manifestIds.filter(id => !liveTasks[id]).join(', ') || '(none)'}\n  sct-tasks.js only: ${liveIds.filter(id => !manifestTasks[id]).join(', ') || '(none)'}`);

// Per-task fields that must match. We only check fields that the runtime uses
// for inference; UI-only labels/descriptions are derived in sct-tasks.js and
// rebuilt in the manifest, so we don't enforce strict equality on those.
const TASK_FIELDS = ['supportStatus', 'validationStatus', 'processingOnly', 'outputType', 'outputStages'];

// Per-asset fields that the worker reads. Drift here causes silent runtime
// regressions even when fixture tests (which read manifest.json) stay green.
const ASSET_FIELDS = [
  'id',
  'filename',
  'downloadUrl',
  'checksum',
  'sizeBytes',
  'patchSize',
  'preprocessing',
  'modelOrientation',
  'output',
  'inferenceDefaults',
  'browserFormat',
  'conversionStatus'
];

const TEMPLATE_ASSET_FIELDS = [
  'id',
  'filename',
  'downloadUrl',
  'checksum',
  'sizeBytes'
];

const mismatches = [];

for (const id of manifestIds) {
  const m = manifestTasks[id];
  const l = liveTasks[id];

  for (const field of TASK_FIELDS) {
    try {
      assert.deepEqual(l[field], m[field]);
    } catch {
      mismatches.push(`${id}.${field}: sct-tasks.js=${JSON.stringify(l[field])} manifest.json=${JSON.stringify(m[field])}`);
    }
  }

  const mAssets = Array.isArray(m.modelAssets) ? m.modelAssets : [];
  const lAssets = Array.isArray(l.modelAssets) ? l.modelAssets : [];

  // Asset metadata only matters for tasks the browser actually runs. Unsupported
  // tasks intentionally carry no assets in sct-tasks.js — the manifest entries
  // are reference metadata only. The supportStatus check above already catches
  // accidental promotions.
  if (l.supportStatus !== 'supported') continue;

  // A supported task that the user can pick from the segmentation dropdown must
  // have a model asset. Without one, runInference() silently falls back to the
  // global default model. Tasks that are post-processing only (vertebrae) opt
  // out via processingOnly: true and are filtered from the segmentation menu.
  if (!l.processingOnly && lAssets.length === 0) {
    mismatches.push(`${id}: supported task has no modelAssets and is not processingOnly — segmentation dropdown would route it to the default model`);
  }

  if (lAssets.length !== mAssets.length) {
    mismatches.push(`${id}: asset count differs (sct-tasks.js=${lAssets.length} manifest.json=${mAssets.length})`);
    continue;
  }

  for (let i = 0; i < mAssets.length; i++) {
    const ma = mAssets[i];
    const la = lAssets[i];
    for (const field of ASSET_FIELDS) {
      try {
        assert.deepEqual(la[field], ma[field]);
      } catch {
        mismatches.push(`${id}.modelAssets[${i}].${field}: sct-tasks.js=${JSON.stringify(la[field])} manifest.json=${JSON.stringify(ma[field])}`);
      }
    }
  }

  const mTemplateAssets = Array.isArray(m.templateAssets) ? m.templateAssets : [];
  const lTemplateAssets = Array.isArray(l.templateAssets) ? l.templateAssets : [];
  if (lTemplateAssets.length !== mTemplateAssets.length) {
    mismatches.push(`${id}: template asset count differs (sct-tasks.js=${lTemplateAssets.length} manifest.json=${mTemplateAssets.length})`);
    continue;
  }

  for (let i = 0; i < mTemplateAssets.length; i++) {
    const ma = mTemplateAssets[i];
    const la = lTemplateAssets[i];
    for (const field of TEMPLATE_ASSET_FIELDS) {
      try {
        assert.deepEqual(la[field], ma[field]);
      } catch {
        mismatches.push(`${id}.templateAssets[${i}].${field}: sct-tasks.js=${JSON.stringify(la[field])} manifest.json=${JSON.stringify(ma[field])}`);
      }
    }
  }
}

if (mismatches.length > 0) {
  console.error('Manifest consistency check failed. The browser reads sct-tasks.js; manifest.json is read by fixture/parity scripts. Both must agree.\n');
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error(`\n${mismatches.length} mismatch(es). Fix web/js/app/sct-tasks.js or web/models/manifest.json so they match.`);
  process.exit(1);
}

console.log(`Manifest consistency OK: ${manifestIds.length} tasks match across web/js/app/sct-tasks.js and web/models/manifest.json`);
