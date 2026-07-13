#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const pipeline = loadClassicScript(path.join(__dirname, '../web/js/inference-pipeline.js'));

(async () => {
  {
    const logits = new Float32Array([
      2, 0,
      0, 2,
      -2, -2
    ]);
    const probs = pipeline.softmaxChannels(logits, 3);
    for (let i = 0; i < 2; i++) {
      const sum = probs[i] + probs[2 + i] + probs[4 + i];
      assert.ok(Math.abs(sum - 1) < 1e-6, 'softmax probabilities sum to one per voxel');
    }
    assert.deepEqual([...pipeline.argmaxLabelsFromChannels(probs, 3, [0, 1, 2])], [0, 1]);
  }

  {
    const labels = new Uint8Array([0, 1, 2, 3, 2]);
    const split = pipeline.splitLabelsByClassMap(labels, [
      { stage: 'segmentation', labels: [1, 2] },
      { stage: 'lesion', labels: [2] }
    ]);
    assert.deepEqual([...split.segmentation], [0, 1, 1, 0, 1]);
    assert.deepEqual([...split.lesion], [0, 0, 1, 0, 1]);
  }

  {
    const result = await pipeline.runRegionInferencePipeline(
      {
        data: new Float32Array([0, 0, 0, 0]),
        dims: [2, 2, 1],
        patchSize: [2, 2, 1]
      },
      async () => new Float32Array([
        10, 10, -10, -10,
        -10, -10, 10, 10
      ]),
      {
        normalizeInput: false,
        threshold: 0.5,
        minComponentSize: 1,
        channelCount: 2,
        regions: [
          { name: 'sc', stage: 'segmentation', channel: 0, sourceLabels: [1, 2], outputLabel: 1 },
          { name: 'lesion', stage: 'lesion', channel: 1, sourceLabels: [2], outputLabel: 1 }
        ]
      }
    );
    assert.deepEqual(result.regions.map(region => region.stage), ['segmentation', 'lesion']);
    assert.deepEqual([...result.regions[0].labels], [1, 0, 1, 0]);
    assert.deepEqual([...result.regions[1].labels], [0, 1, 0, 1]);
  }

  {
    const result = await pipeline.runMulticlassInferencePipeline(
      {
        data: new Float32Array([0, 0]),
        dims: [2, 1, 1],
        patchSize: [2, 1, 1]
      },
      async () => new Float32Array([
        10, -10,
        -10, 10,
        -10, -10
      ]),
      {
        normalizeInput: false,
        channelCount: 3,
        classLabels: [0, 8, 9]
      }
    );
    assert.deepEqual([...result.labels], [0, 8], 'softmax multiclass inference returns configured class labels');
  }

  {
    const padded = pipeline.centerPadToPatchSize(
      new Float32Array([1, 2, 3]),
      [3, 1, 1],
      [5, 1, 1]
    );
    assert.deepEqual(padded.dims, [5, 1, 1], 'center padding expands short axes to patch size');
    assert.deepEqual(padded.padBelow, [1, 0, 0], 'center padding records lower-side crop offset');
    assert.deepEqual(padded.padAbove, [1, 0, 0], 'center padding records upper-side crop offset');
    assert.deepEqual([...padded.data], [0, 1, 2, 3, 0], 'center padding preserves source voxels in the middle');
    assert.deepEqual(
      [...pipeline.unpadVolumeFromOffset(new Uint8Array([0, 1, 2, 3, 0]), [5, 1, 1], [3, 1, 1], padded.padBelow, Uint8Array)],
      [1, 2, 3],
      'center padding can be cropped back from the recorded offset'
    );
  }

  {
    const result = await pipeline.runSigmoidLabelInferencePipeline(
      {
        data: new Float32Array([0, 0, 0]),
        dims: [3, 1, 1],
        patchSize: [3, 1, 1]
      },
      async () => new Float32Array([
        10, 10, -10,
        -10, 10, 10
      ]),
      {
        normalizeInput: false,
        threshold: 0.5,
        channelCount: 2,
        classLabels: [1, 9],
        labelPriority: [1, 9]
      }
    );
    assert.deepEqual([...result.labels], [1, 9, 9], 'sigmoid-label inference lets specific labels overwrite broad regions');
  }

  {
    const result = await pipeline.runInferencePipeline(
      {
        data: new Float32Array([0, 0, 0, 0]),
        dims: [2, 2, 1],
        patchSize: [2, 2, 1]
      },
      async () => new Float32Array([10, 10, -10, -10]),
      { normalizeInput: false, threshold: 0.5, minComponentSize: 1 }
    );
    assert.deepEqual([...result.labels], [1, 0, 1, 0], 'binary sigmoid inference output stays unchanged');
  }

  {
    const largest = pipeline.keepLargestComponent(
      new Uint8Array([1, 1, 0, 1, 0]),
      [5, 1, 1]
    );
    assert.deepEqual([...largest], [1, 1, 0, 0, 0], 'largest-component cleanup keeps only the biggest foreground island');
  }

  {
    const result = await pipeline.runInferencePipeline(
      {
        data: new Float32Array([0, 0, 0, 0, 0]),
        dims: [5, 1, 1],
        patchSize: [5, 1, 1]
      },
      async () => new Float32Array([10, 10, -10, 10, -10]),
      { normalizeInput: false, threshold: 0.5, minComponentSize: 0, keepLargestComponent: true }
    );
    assert.deepEqual([...result.labels], [1, 1, 0, 0, 0], 'binary inference can apply SCT-style largest-component cleanup');
  }

  console.log('Inference post-processing tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
