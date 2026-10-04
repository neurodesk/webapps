#!/usr/bin/env node
/**
 * Heavy smoke test for the browser worker's real lesion_ms path.
 *
 * Stays out of test:fast because it loads the 409 MB ONNX model and runs a
 * dozen ResEncL patches. It drives the worker exactly as the app does and
 * checks the two things the lighter tests cannot: the worker emits a lesion
 * mask without a spinal-cord stage, and it still emits lesion metrics.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runWorkerCase } = require('./test_inference_worker_e2e.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const MODEL_PATH = path.join(ROOT, 'web/models/sct-lesion-ms.onnx');

// The worker's shared model fetch uses the process-wide fetch. runWorkerCase()
// has already verified the cached file against the manifest checksum (or
// downloaded it), so serve those bytes instead of fetching 409 MB a second time.
function serveCachedModel() {
  const hostedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!url.endsWith('/web/models/sct-lesion-ms.onnx') || !fs.existsSync(MODEL_PATH)) return hostedFetch(input, init);
    const bytes = fs.readFileSync(MODEL_PATH);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
}

async function main() {
  await ensureSctBatchFixtures(ROOT);
  serveCachedModel();
  const { messages } = await runWorkerCase({
    id: 'course_t2_ms_deepseg_lesion_ms_smoke',
    taskId: 'lesion_ms',
    modelAssetId: 'sct-lesion-ms',
    modelName: 'sct-lesion-ms.onnx',
    inputPath: 'test_data/course_t2_ms_deepseg_lesion_ms/input.nii.gz',
    expectedStages: ['lesion'],
    minForegroundByStage: {
      lesion: 100
    }
  });

  const stages = messages.filter(message => message?.type === 'stageData').map(message => message.stage);
  assert.ok(!stages.includes('segmentation'), 'lesion_ms must not emit a spinal-cord segmentation stage');
  const metrics = messages.find(message => message?.type === 'stageData' && message.stage === 'lesion_metrics');
  assert.ok(metrics, 'lesion_ms emits lesion metrics without a cord mask');
  assert.equal(metrics.kind, 'metrics');
  assert.equal(metrics.filename, 'lesion_ms_lesion_metrics.csv');
  assert.ok(metrics.summary.lesion_count >= 1, 'the MS fixture has at least one lesion');
  assert.ok(metrics.summary.total_volume_mm3 > 0, 'lesion volume is reported');
  assert.ok(metrics.rows.every(row => row.max_axial_damage_ratio === null), 'cord-relative metrics stay empty');
  console.log(`PASS: lesion_ms worker metrics: ${metrics.summary.lesion_count} lesion(s), ${metrics.summary.total_volume_mm3} mm3`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('lesion_ms worker smoke test failed:', error && error.stack || error);
    process.exit(1);
  });
}
