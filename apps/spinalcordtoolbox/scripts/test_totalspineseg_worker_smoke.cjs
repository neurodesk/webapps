#!/usr/bin/env node
/**
 * Heavy smoke test for the browser worker's real TotalSpineSeg Step 1 path.
 *
 * This intentionally stays out of test:fast because it loads the 538 MB ONNX
 * model and runs a full-size nnU-Net patch. It catches the geometry regression
 * where TotalSpineSeg was fed xyz/reduced patches and failed to emit disc labels.
 */
'use strict';

const { runWorkerCase } = require('./test_inference_worker_e2e.cjs');

async function main() {
  await runWorkerCase({
    id: 'batch_t2_totalspineseg_spine_smoke',
    taskId: 'spine',
    modelAssetId: 'totalspineseg-step1',
    modelName: 'totalspineseg-step1.onnx',
    patchSize: [256, 256, 48],
    inputPath: 'test_data/batch_t2_deepseg_spinalcord/input.nii.gz',
    expectedStages: ['spine_step1', 'spine_discs'],
    minForegroundByStage: {
      spine_step1: 1,
      spine_discs: 25
    }
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('TotalSpineSeg worker smoke test failed:', error && error.stack || error);
    process.exit(1);
  });
}
