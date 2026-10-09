#!/usr/bin/env node --no-warnings
// Behaviour tests for the inference worker (web/js/inference-worker.js).
//
// The real worker module runs in this process (scripts/support/
// in-process-worker.mjs) and is driven by the real CalmarPipeline executor
// over the real message protocol. Only ONNX Runtime and `fetch` are
// replaced: each test installs a small stand-in "model" whose output is a
// known function of its input, so every expected mask or image below is
// worked out by hand from the test inputs, never by re-running app code.
//
// Volumes are flat x-fastest arrays (NIfTI order): index = x + y*X + z*X*Y.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';
import * as nifti from 'nifti-reader-js';
import { InProcessWorker, ortStub, workerIdle } from './support/in-process-worker.mjs';
import { writeNifti1 } from '../web/js/modules/nifti-writer.js';

globalThis.Worker = InProcessWorker;
// The worker reports each refused command with console.error as well as an
// 'error' message. The messages are asserted below; keep the traces quiet.
console.error = () => {};
const { CalmarPipeline } = await import('../web/js/controllers/CalmarPipeline.js');

// ---- helpers ----

function makePipeline() {
  const events = { logs: [], errors: [], steps: [], stages: {}, descriptions: {}, completed: 0, volumeInfo: null };
  const pipeline = new CalmarPipeline({
    updateOutput: () => {},
    updateDebugOutput: message => events.logs.push(String(message)),
    onStageData: data => {
      events.stages[data.stage] = data.niftiData;
      events.descriptions[data.stage] = data.description;
    },
    onError: message => events.errors.push(message),
    onStepComplete: step => events.steps.push(step),
    onComplete: () => {
      events.completed++;
    },
    onVolumeInfo: info => {
      events.volumeInfo = info;
    }
  });
  return { pipeline, events };
}

// Wait for a posted command to be fully handled by the worker.
async function settle(promise) {
  await promise;
  await workerIdle();
}

function flatAffine(rows) {
  return Float64Array.from(rows.flat());
}

function translationAffine(tx, ty, tz) {
  return [[1, 0, 0, tx], [0, 1, 0, ty], [0, 0, 1, tz], [0, 0, 0, 1]];
}

function decode(buffer) {
  const header = nifti.readHeader(buffer);
  const image = nifti.readImage(header, buffer);
  const ctor = { 2: Uint8Array, 16: Float32Array, 512: Uint16Array }[header.datatypeCode];
  assert.ok(ctor, `unexpected NIfTI datatype ${header.datatypeCode}`);
  return {
    dims: [header.dims[1], header.dims[2], header.dims[3]],
    datatype: header.datatypeCode,
    affine: header.affine.slice(0, 3).map(row => row.map(value => Math.round(value * 1000) / 1000)),
    data: new ctor(image)
  };
}

// Fill the half-open box [x0, x1) x [y0, y1) x [z0, z1) of a volume.
function fillBox(data, dims, [x0, x1], [y0, y1], [z0, z1], value) {
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        data[x + y * dims[0] + z * dims[0] * dims[1]] = value;
      }
    }
  }
  return data;
}

function boxMask(dims, xs, ys, zs, value = 1) {
  return fillBox(new Uint16Array(dims[0] * dims[1] * dims[2]), dims, xs, ys, zs, value);
}

// Voxel-wise equality with a readable first mismatch (deepEqual on a
// 4.9-million-voxel volume is slow and prints the whole array).
function assertVolume(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: voxel count`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(`${label}: voxel ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

function countNonzero(data) {
  let count = 0;
  for (const value of data) {
    if (value) count++;
  }
  return count;
}

const MODEL_BYTES = new ArrayBuffer(100001);
const requestedUrls = [];
let referenceNifti = null;
globalThis.fetch = async url => {
  requestedUrls.push(String(url));
  const body = String(url).endsWith('.nii.gz') ? referenceNifti : MODEL_BYTES;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => body.slice(0)
  };
};

// ---- the executor starts the worker as a module worker and initialises it ----
{
  const { pipeline, events } = makePipeline();
  await pipeline.initialize();
  const created = InProcessWorker.created.at(-1);
  assert.match(created.url, /^js\/inference-worker\.js\?v=\d/, 'worker URL is the versioned inference worker');
  assert.deepEqual(created.options, { type: 'module' }, 'the worker is started as a module worker');
  assert.equal(pipeline.isReady(), true, "the worker answers 'init' with 'initialized'");
  assert.ok(events.logs.some(line => /ORT WASM backend ready \(\d+ threads?\)/.test(line)), 'init reports the WASM backend');
  assert.ok(events.logs.includes('ONNX Runtime ready'));
}

// ---- every stage refuses to run before its prerequisite ----
{
  const { pipeline, events } = makePipeline();
  await settle(pipeline.resetWorkerState());
  await settle(pipeline.runSynthStrip({ modelBaseUrl: 'https://models.example/models' }));
  await settle(pipeline.runInference({ taskId: 't', modelAssetId: 'a', modelName: 'm.onnx', supportStatus: 'supported' }));
  await settle(pipeline.runRegistration({ modelBaseUrl: 'https://models.example/models', referenceUrl: 'ref.nii.gz' }));
  await settle(pipeline.runWarpMask({ maskBuffer: new ArrayBuffer(8) }));
  await settle(pipeline.runInverseWarpMask({ maskBuffer: new ArrayBuffer(8) }));
  assert.deepEqual(events.errors, [
    'No volume loaded. Run Load first.',
    'No volume loaded. Run Load first.',
    'No volume loaded. Run Load first.',
    'No displacement available. Run Register first.',
    'No displacement available. Run Register first.'
  ]);
  assert.deepEqual(events.stages, {}, 'a refused stage emits no output');
}

// ---- lesion segmentation: load, orient to RAS, infer, write back natively ----
{
  const dims = [8, 8, 8];
  // x runs right-to-left in this file (LAS), so the worker must flip it to
  // RAS for the model and flip the result back for the output.
  const affine = [[-1, 0, 0, 90], [0, 1, 0, -126], [0, 0, 1, -72], [0, 0, 0, 1]];
  const data = new Float32Array(512).fill(10);
  fillBox(data, dims, [1, 3], [2, 4], [4, 6], 100);
  const input = writeNifti1(data, { dims, affine: flatAffine(affine) });

  const { pipeline, events } = makePipeline();
  await settle(pipeline.loadVolume(input));
  assert.deepEqual(events.steps, ['load']);
  assert.deepEqual(events.volumeInfo.rasDims, dims);
  assert.equal(events.volumeInfo.totalSlices, 8);

  const tensors = [];
  let sessionOptions = null;
  // Stand-in model with the SynthStroke output shape: two logit channels
  // [background, stroke]. It calls "stroke" every voxel whose z-scored
  // intensity exceeds 1, which here is exactly the bright box.
  ortStub.create = async (bytes, options) => {
    sessionOptions = options;
    assert.equal(bytes.byteLength, 100001, 'the session is built from the fetched model bytes');
    return {
      inputNames: ['image'],
      outputNames: ['logits'],
      run: async feeds => {
        const tensor = feeds.image;
        tensors.push(tensor);
        const voxels = tensor.data.length;
        const logits = new Float32Array(2 * voxels);
        for (let i = 0; i < voxels; i++) {
          logits[i] = 2;
          logits[voxels + i] = tensor.data[i] > 1 ? 8 : -8;
        }
        return { logits: { data: logits } };
      },
      release: async () => {}
    };
  };

  const settings = {
    taskId: 'lnm-stroke-lesion',
    modelAssetId: 'lnm-stroke-lesion',
    modelName: 'lnm-stroke-lesion.onnx',
    modelBaseUrl: 'https://models.example/models',
    patchSize: [8, 8, 8],
    threshold: 0.5,
    minComponentSize: 1,
    supportStatus: 'supported'
  };

  // An asset that is not validated is refused before any download.
  requestedUrls.length = 0;
  await settle(pipeline.runInference({ ...settings, supportStatus: 'benchmark-only' }));
  assert.deepEqual(events.errors, [
    'Task "lnm-stroke-lesion" is benchmark-only. Convert and validate model asset "lnm-stroke-lesion" before running inference.'
  ]);
  assert.deepEqual(requestedUrls, [], 'no model is fetched for an unvalidated asset');
  await settle(pipeline.runInference({ modelName: 'x.onnx', supportStatus: 'supported' }));
  assert.equal(events.errors[1], 'run-inference requires taskId, modelAssetId, and modelName.');

  await settle(pipeline.runInference(settings));
  assert.deepEqual(events.errors.slice(2), [], 'a supported asset runs without error');
  assert.deepEqual(requestedUrls, ['https://models.example/models/lnm-stroke-lesion.onnx'], 'the model URL is base + name');
  assert.deepEqual(sessionOptions.executionProviders, ['wasm'], '3D segmentation runs on the WASM provider');
  assert.equal(tensors.length, 1, 'one patch covers an 8x8x8 volume');
  assert.deepEqual(tensors[0].dims, [1, 1, 8, 8, 8], 'single-channel NCDHW input');
  assert.equal(tensors[0].disposed, true, 'input tensors are released');

  // In RAS the box sits at x = 7 - {1, 2} = {5, 6}; the tensor is C-order
  // over [x, y, z], so its bright voxels are (x*8 + y)*8 + z.
  const bright = [];
  tensors[0].data.forEach((value, i) => {
    if (value > 1) bright.push(i);
  });
  const expectedBright = [];
  for (const x of [5, 6]) {
    for (const y of [2, 3]) {
      for (const z of [4, 5]) expectedBright.push((x * 8 + y) * 8 + z);
    }
  }
  assert.deepEqual(bright, expectedBright, 'the model sees the volume reoriented to RAS');

  // The output is back on the input grid: same box, same affine.
  const segmentation = decode(events.stages.segmentation);
  assert.deepEqual(segmentation.dims, dims);
  assert.equal(segmentation.datatype, 2, 'the mask is uint8');
  assert.deepEqual(segmentation.affine, affine.slice(0, 3), 'the output keeps the input affine');
  assertVolume(segmentation.data, boxMask(dims, [1, 3], [2, 4], [4, 6]), 'stroke mask in native orientation');
  assert.equal(events.descriptions.segmentation, 'Lesion segmentation');
  assert.deepEqual(events.steps, ['load', 'inference']);
  assert.equal(events.completed, 1);
  assert.equal(pipeline.getResult('segmentation').file.name, 'lnm-stroke-lesion_segmentation.nii');
  // Hidden state for checkpoint/restore: the pre-cleanup labels in RAS.
  assert.equal(countNonzero(new Uint8Array(pipeline.hiddenArtifacts.segmentationState.segLabelsRAS)), 8);

  // Model bytes are kept in Cache Storage: with a cache available the first
  // run stores the download under the manifest cache key and the next run
  // does not touch the network.
  const opened = [];
  const stored = new Map();
  globalThis.caches = {
    open: async name => {
      opened.push(name);
      return {
        match: async key => stored.get(key),
        put: async (key, response) => {
          stored.set(key, response.clone());
        },
        delete: async key => stored.delete(key)
      };
    }
  };
  const cachedSettings = { ...settings, cacheKey: 'lnm-stroke-lesion-synthstroke-baseline-v1' };
  requestedUrls.length = 0;
  await settle(pipeline.runInference(cachedSettings));
  assert.deepEqual(requestedUrls, ['https://models.example/models/lnm-stroke-lesion.onnx']);
  assert.deepEqual([...stored.keys()], ['lnm-stroke-lesion-synthstroke-baseline-v1'], 'cached under the manifest cache key');
  assert.equal((await stored.get('lnm-stroke-lesion-synthstroke-baseline-v1').clone().arrayBuffer()).byteLength, 100001);
  stored.set('lnm-stroke-lesion-synthstroke-baseline-v1', { arrayBuffer: async () => MODEL_BYTES.slice(0) });
  await settle(pipeline.runInference(cachedSettings));
  assert.deepEqual(requestedUrls, ['https://models.example/models/lnm-stroke-lesion.onnx'], 'the second run is served from the cache');
  assert.deepEqual([...new Set(opened)], ['lnm-models-v1'], 'models share one Cache Storage bucket');
  // A truncated cache entry is discarded and downloaded again.
  stored.set('lnm-stroke-lesion-synthstroke-baseline-v1', { arrayBuffer: async () => new ArrayBuffer(10) });
  await settle(pipeline.runInference(cachedSettings));
  assert.equal(requestedUrls.length, 2, 'a truncated cached model is re-downloaded');
  assert.ok(events.logs.some(line => line.startsWith('Discarding cached model: Model is truncated')));
  delete globalThis.caches;
  assertVolume(decode(events.stages.segmentation).data, boxMask(dims, [1, 3], [2, 4], [4, 6]), 'stroke mask from a cached model');

  // Test-time augmentation runs the patch 8 times (identity + 7 flips) and
  // still returns the box, because this stand-in model is flip-equivariant.
  tensors.length = 0;
  await settle(pipeline.runInference({ ...settings, testTimeAugmentation: true }));
  assert.equal(tensors.length, 8, 'TTA runs 8 forward passes per patch');
  assertVolume(decode(events.stages.segmentation).data, boxMask(dims, [1, 3], [2, 4], [4, 6]), 'stroke mask with TTA');

  // Small components are removed: an 8-voxel lesion does not survive a
  // 9-voxel minimum, and the log explains the empty result.
  await settle(pipeline.runInference({ ...settings, minComponentSize: 9 }));
  assert.equal(countNonzero(decode(events.stages.segmentation).data), 0);
  assert.ok(events.logs.some(line => line.startsWith('WARNING: Segmentation is empty.')));

  // A model with an unexpected output size is an error, not a silent mask.
  ortStub.create = async () => ({
    inputNames: ['image'],
    outputNames: ['logits'],
    run: async () => ({ logits: { data: new Float32Array(3 * 512) } }),
    release: async () => {}
  });
  await settle(pipeline.runInference(settings));
  assert.equal(events.errors.at(-1), 'Unexpected logits length 1536; expected 512 (1-channel) or 1024 (binary softmax)');
}

// ---- DeepISLES DWI/ADC seed route ----
{
  const dims = [8, 8, 8];
  const dwiAffine = translationAffine(-4, -4, -4);
  // The ADC grid starts one voxel further along +x than the DWI grid, so
  // DWI voxel x shows ADC voxel x - 1 once resampled.
  const adcAffine = translationAffine(-3, -4, -4);
  const trace = new Float32Array(512).fill(100);
  fillBox(trace, dims, [3, 5], [2, 4], [4, 6], 900);
  const adc = new Float32Array(512).fill(1000);
  fillBox(adc, dims, [2, 4], [2, 4], [4, 6], 200);
  const dwiBuffer = writeNifti1(trace, { dims, affine: flatAffine(dwiAffine) });
  const adcBuffer = writeNifti1(adc, { dims, affine: flatAffine(adcAffine) });

  const settings = {
    taskId: 'lnm-deepisles',
    modelAssetId: 'lnm-deepisles-nvauto-browser-seed',
    modelName: 'lnm-deepisles-nvauto-browser-seed.onnx',
    modelBaseUrl: 'https://models.example/models',
    patchSize: [8, 8, 8],
    overlap: 0.625,
    threshold: 0.5,
    minComponentSize: 1,
    channelOrder: ['ADC', 'TRACE']
  };
  const { pipeline, events } = makePipeline();
  await settle(pipeline.resetWorkerState());

  // The route is gated: benchmark-only assets, missing inputs and a wrong
  // channel order are all refused.
  await settle(pipeline.runDeepIslesInference({ ...settings, dwiBuffer, adcBuffer, supportStatus: 'benchmark-only' }));
  await settle(pipeline.runDeepIslesInference({ ...settings, adcBuffer, supportStatus: 'supported' }));
  await settle(pipeline.runDeepIslesInference({ ...settings, dwiBuffer, adcBuffer, supportStatus: 'supported', channelOrder: ['TRACE', 'ADC'] }));
  assert.deepEqual(events.errors, [
    'Task "lnm-deepisles" is benchmark-only. DeepISLES browser seed remains benchmark-only until a validated ONNX asset is selected.',
    'DeepISLES requires DWI/TRACE and ADC input buffers.',
    'DeepISLES channelOrder must be [ADC, TRACE].'
  ]);

  // Stand-in two-channel model: stroke where ADC is low and TRACE is high
  // (both z-scored over nonzero voxels), i.e. restricted diffusion.
  const tensors = [];
  ortStub.create = async () => ({
    inputNames: ['image'],
    outputNames: ['logits'],
    run: async feeds => {
      const tensor = feeds.image;
      tensors.push(tensor);
      const voxels = tensor.data.length / 2;
      const logits = new Float32Array(2 * voxels);
      for (let i = 0; i < voxels; i++) {
        const adcValue = tensor.data[i];
        const traceValue = tensor.data[voxels + i];
        logits[voxels + i] = adcValue < -1 && traceValue > 1 ? 9 : -9;
      }
      return { logits: { data: logits } };
    },
    release: async () => {}
  });
  await settle(pipeline.runDeepIslesInference({ ...settings, dwiBuffer, adcBuffer, supportStatus: 'supported' }));
  assert.deepEqual(events.errors.slice(3), [], 'a validated DeepISLES asset runs');
  assert.ok(events.logs.includes('Resampling ADC onto DWI/TRACE grid for DeepISLES.'));
  assert.equal(tensors.length, 1);
  assert.deepEqual(tensors[0].dims, [1, 2, 8, 8, 8], 'two-channel NCDHW input');
  // Channel 0 is ADC: its low box, moved onto the DWI grid at x = {3, 4}.
  const lowAdc = [];
  for (let i = 0; i < 512; i++) {
    if (tensors[0].data[i] < -1) lowAdc.push(i);
  }
  const expectedLowAdc = [];
  for (const x of [3, 4]) {
    for (const y of [2, 3]) {
      for (const z of [4, 5]) expectedLowAdc.push((x * 8 + y) * 8 + z);
    }
  }
  assert.deepEqual(lowAdc, expectedLowAdc, 'channel 0 is ADC resampled onto the DWI grid');

  const seed = decode(events.stages.segmentation);
  assert.deepEqual(seed.affine, dwiAffine.slice(0, 3), 'the seed is written on the DWI/TRACE grid');
  assertVolume(seed.data, boxMask(dims, [3, 5], [2, 4], [4, 6]), 'seed = low ADC and high TRACE');
  assert.equal(events.descriptions.segmentation, 'DeepISLES lesion seed');
}

// ---- brain extraction ----
{
  const dims = [32, 32, 32];
  const affine = translationAffine(-16, -16, -16);
  const data = new Float32Array(32 ** 3).fill(1);
  fillBox(data, dims, [8, 24], [10, 22], [12, 20], 200);
  const { pipeline, events } = makePipeline();
  await settle(pipeline.resetWorkerState());
  await settle(pipeline.loadVolume(writeNifti1(data, { dims, affine: flatAffine(affine) })));

  await settle(pipeline.runSynthStrip({}));
  assert.deepEqual(events.errors, ['run-synthstrip requires modelBaseUrl.']);

  // Stand-in SynthStrip: a signed distance that is negative (inside the
  // brain) exactly where the normalised input is bright.
  const tensors = [];
  ortStub.create = async () => ({
    inputNames: ['input'],
    outputNames: ['sdt'],
    run: async feeds => {
      const tensor = feeds.input;
      tensors.push(tensor);
      return { sdt: { data: Float32Array.from(tensor.data, value => (value > 0.5 ? -4 : 4)) } };
    },
    release: () => {}
  });
  requestedUrls.length = 0;
  await settle(pipeline.runSynthStrip({ modelBaseUrl: 'https://models.example/models' }));
  assert.deepEqual(events.errors.slice(1), []);
  assert.deepEqual(requestedUrls, ['https://models.example/models/synthstrip.onnx'], 'default SynthStrip model name');
  assert.equal(tensors.length, 1, 'SynthStrip is a single full-volume pass');
  const mask = decode(events.stages.brainmask);
  assert.deepEqual(mask.dims, dims);
  assert.deepEqual(mask.affine, affine.slice(0, 3));
  assertVolume(mask.data, boxMask(dims, [8, 24], [10, 22], [12, 20]), 'brain mask on the input grid');
  assert.deepEqual(events.steps, ['load', 'brainmask']);
  assert.ok(events.logs.some(line => /SynthStrip brain mask: 1536 voxels \(4\.7% coverage\)/.test(line)), '16*12*8 = 1536 of 32768 voxels');
  assert.equal(pipeline.getResult('brainmask').file.name, 'lnm-synthstrip_brainmask.nii');
}

// ---- registration, lesion warp and inverse projection on the MNI160 grid ----
{
  const dims = [160, 160, 192];
  const voxels = 160 * 160 * 192;
  const index = (x, y, z) => x + y * 160 + z * 160 * 160;
  const sourceAffine = translationAffine(-80, -80, -96);
  const referenceAffine = translationAffine(-79, -95, -77);

  // Registration refuses a volume that is not on the 160x160x192 grid.
  {
    const { pipeline, events } = makePipeline();
    await settle(pipeline.resetWorkerState());
    await settle(pipeline.loadVolume(writeNifti1(new Float32Array(512).fill(1), { dims: [8, 8, 8] })));
    await settle(pipeline.runRegistration({ modelBaseUrl: 'm', referenceUrl: 'ref.nii.gz' }));
    assert.match(events.errors[0], /^SynthMorph registration requires source at 160x160x192; got 8x8x8\./);
  }

  // Moving image: background 5, a "brain" box whose intensity varies with x
  // (50 + x mod 7) so a shift along x is visible voxel by voxel.
  const source = new Float32Array(voxels).fill(5);
  for (let z = 50; z < 150; z++) {
    for (let y = 40; y < 120; y++) {
      for (let x = 40; x < 120; x++) source[index(x, y, z)] = 50 + (x % 7);
    }
  }
  // A bright non-brain slab ("scalp") beside the box.
  fillBox(source, dims, [130, 140], [40, 120], [50, 150], 200);
  const sourceMax = 200;
  const sourceMin = 5;
  const reference = new Float32Array(voxels);
  fillBox(reference, dims, [30, 130], [30, 130], [40, 160], 0.8);
  referenceNifti = writeNifti1(reference, { dims, affine: flatAffine(referenceAffine) });

  const { pipeline, events } = makePipeline();
  await settle(pipeline.resetWorkerState());
  await settle(pipeline.loadVolume(writeNifti1(source, { dims, affine: flatAffine(sourceAffine) })));

  await settle(pipeline.runRegistration({ referenceUrl: 'ref.nii.gz' }));
  await settle(pipeline.runRegistration({ modelBaseUrl: 'm' }));
  assert.deepEqual(events.errors, ['run-register requires modelBaseUrl', 'run-register requires referenceUrl']);

  // Stand-in SynthMorph: a constant stationary velocity of 0.3 SVF-grid
  // voxels along +x on the 24x32x40 half-resolution grid. A constant
  // velocity integrates to the same translation, and upsampling to the
  // 160-voxel axis scales it by 160 / 24, giving 0.3 * 160 / 24 = 2 voxels.
  const sessions = [];
  ortStub.create = async (bytes, options) => {
    const provider = options.executionProviders[0];
    if (provider === 'webgpu') throw new Error('3D MaxPool is not supported');
    const session = {
      provider,
      inputNames: ['source', 'target'],
      outputNames: ['svf'],
      feeds: null,
      run: async feeds => {
        session.feeds = feeds;
        const svf = new Float32Array(24 * 32 * 40 * 3);
        for (let i = 0; i < svf.length; i += 3) svf[i] = 0.3;
        return { svf: { data: svf, dims: [1, 24, 32, 40, 3] } };
      },
      release: () => {
        session.released = true;
      }
    };
    sessions.push(session);
    return session;
  };
  const settings = {
    modelBaseUrl: 'https://models.example/models',
    modelName: 'lnm-synthmorph-mni-48x64x80.onnx',
    referenceUrl: 'https://models.example/atlases/lnm-mni160.nii.gz',
    modelInputDims: [48, 64, 80],
    svfDims: [24, 32, 40],
    executionProviders: ['webgpu']
  };
  requestedUrls.length = 0;
  await settle(pipeline.runRegistration(settings));
  assert.deepEqual(events.errors.slice(2), []);
  assert.deepEqual(requestedUrls, [
    'https://models.example/atlases/lnm-mni160.nii.gz',
    'https://models.example/models/lnm-synthmorph-mni-48x64x80.onnx'
  ]);

  // Provider routing: the manifest order is tried first and WASM is always
  // the fallback; the chosen provider is logged for the smoke test.
  assert.ok(events.logs.includes('SynthMorph EP candidates=webgpu,wasm'));
  assert.ok(events.logs.includes('SynthMorph EP webgpu failed (3D MaxPool is not supported); trying wasm.'));
  assert.ok(events.logs.includes('SynthMorph EP=wasm'));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].released, true);
  const { source: sourceTensor, target: targetTensor } = sessions[0].feeds;
  assert.deepEqual(sourceTensor.dims, [1, 48, 64, 80, 1], 'channel-last input on the browser model grid');
  assert.deepEqual(targetTensor.dims, [1, 48, 64, 80, 1]);
  // Without a brain mask the source is min-max scaled, so background 5
  // becomes (5 - 5) / (200 - 5) = 0 and the tensor stays within [0, 1].
  assert.ok(sourceTensor.data.every(value => value >= 0 && value <= 1));
  assert.equal(sourceTensor.data[0], 0);

  assert.deepEqual(events.steps, ['load', 'register']);

  // Registered T1: output(x, y, z) = normalised source(x + 2, y, z), written
  // on the fixed reference grid.
  const registered = decode(events.stages['registered-t1-mni160']);
  assert.deepEqual(registered.dims, dims);
  assert.equal(registered.datatype, 16);
  assert.deepEqual(registered.affine, referenceAffine.slice(0, 3), 'QC output uses the fixed MNI160 reference header');
  const normalised = (x, y, z) => (source[index(x, y, z)] - sourceMin) / (sourceMax - sourceMin);
  for (const [x, y, z] of [[60, 60, 60], [38, 100, 149], [117, 40, 50], [118, 60, 60], [0, 0, 0], [100, 119, 100]]) {
    const got = registered.data[index(x, y, z)];
    const want = normalised(x + 2, y, z);
    assert.ok(Math.abs(got - want) < 1e-4, `registered T1 at ${x},${y},${z}: got ${got}, expected ${want}`);
  }
  // The last two columns sample beyond the volume and are zero-filled.
  assert.equal(registered.data[index(158, 60, 60)], 0);
  assert.equal(registered.data[index(159, 60, 60)], 0);

  // Displacement magnitude: 2 voxels everywhere.
  const magnitude = decode(events.stages['registration-displacement-mag']);
  assert.deepEqual(magnitude.affine, referenceAffine.slice(0, 3));
  let minMagnitude = Infinity;
  let maxMagnitude = -Infinity;
  for (const value of magnitude.data) {
    if (value < minMagnitude) minMagnitude = value;
    if (value > maxMagnitude) maxMagnitude = value;
  }
  assert.ok(Math.abs(minMagnitude - 2) < 1e-4 && Math.abs(maxMagnitude - 2) < 1e-4, `|displacement| in [${minMagnitude}, ${maxMagnitude}], expected 2`);

  // warp-mask: a lesion at x in [50, 54) lands at x in [48, 52) and is
  // written with the reference header, not the patient header.
  const lesion = fillBox(new Uint8Array(voxels), dims, [50, 54], [60, 64], [70, 73], 1);
  await settle(pipeline.runWarpMask({ maskBuffer: lesion.buffer.slice(0), maskDims: dims }));
  const mniLesion = decode(events.stages['mni-lesion']);
  assert.equal(mniLesion.datatype, 2);
  assert.deepEqual(mniLesion.affine, referenceAffine.slice(0, 3), 'mni-lesion uses the fixed MNI160 reference header');
  assertVolume(mniLesion.data, boxMask(dims, [48, 52], [60, 64], [70, 73]), 'lesion warped by the 2-voxel shift');
  assert.equal(events.steps.at(-1), 'warp-mask');

  // inverse-warp-mask: the same box goes back by +2 to x in [52, 56), is
  // binary, defaults to stage 'threshold-patient' and keeps the patient header.
  await settle(pipeline.runInverseWarpMask({ maskBuffer: lesion.buffer.slice(0), maskDims: dims }));
  const patient = decode(events.stages['threshold-patient']);
  assert.equal(patient.datatype, 2);
  assert.deepEqual(patient.affine, sourceAffine.slice(0, 3), 'patient-space output keeps the structural header');
  assertVolume(patient.data, boxMask(dims, [52, 56], [60, 64], [70, 73]), 'mask projected back to patient space');
  assert.equal(events.descriptions['threshold-patient'], 'Threshold map projected to patient T1 space');

  // Label maps keep their integer labels, including Schaefer labels above
  // 255, which need the uint16 path.
  const atlas = new Uint16Array(voxels);
  fillBox(atlas, dims, [50, 54], [60, 64], [70, 73], 399);
  fillBox(atlas, dims, [90, 92], [60, 64], [70, 73], 7);
  await settle(pipeline.runInverseWarpMask({
    maskBuffer: atlas.buffer.slice(0),
    maskDims: dims,
    stage: 'atlas-patient',
    description: 'Atlas in patient space',
    labelMap: true,
    labelDataType: 'uint16'
  }));
  const patientAtlas = decode(events.stages['atlas-patient']);
  assert.equal(patientAtlas.datatype, 512, 'uint16 label map');
  const expectedAtlas = new Uint16Array(voxels);
  fillBox(expectedAtlas, dims, [52, 56], [60, 64], [70, 73], 399);
  fillBox(expectedAtlas, dims, [92, 94], [60, 64], [70, 73], 7);
  assertVolume(patientAtlas.data, expectedAtlas, 'labels 399 and 7 survive the inverse warp');
  // The same labels through the default uint8 binary path collapse to 0/1.
  await settle(pipeline.runInverseWarpMask({ maskBuffer: Uint8Array.from(atlas, value => (value ? 1 : 0)).buffer, maskDims: dims }));
  assert.deepEqual([...new Set(decode(events.stages['threshold-patient']).data)].sort(), [0, 1], 'binary projection is 0/1');
  assert.deepEqual(events.errors.slice(2), []);

  // With a brain mask the worker normalises robustly inside the mask and
  // zeroes everything outside it before the model sees the image.
  const brainMask = fillBox(new Uint8Array(voxels), dims, [40, 120], [40, 120], [50, 150], 1);
  await settle(pipeline.runRegistration({ ...settings, executionProviders: ['wasm'], brainMaskBuffer: new ArrayBuffer(512), brainMaskDims: [8, 8, 8] }));
  assert.equal(events.errors.at(-1), 'registration brain mask dims 8x8x8 must match registration grid 160x160x192');
  // Second stand-in SynthMorph output: a velocity that contracts towards
  // the grid centre along x, v_x = a (x - c) with a = -0.2 and c = 11.5 on
  // the 24-voxel SVF axis. Its flow has the closed form
  // (x - c) (e^a - 1) with e^-0.2 - 1 = -0.1812692469, so this run only
  // matches if the worker really integrates the velocity field.
  const contraction = -0.1812692469;
  ortStub.create = async () => ({
    inputNames: ['source', 'target'],
    outputNames: ['svf'],
    run: async () => {
      const svf = new Float32Array(24 * 32 * 40 * 3);
      for (let x = 0; x < 24; x++) {
        for (let i = 0; i < 32 * 40; i++) svf[(x * 32 * 40 + i) * 3] = -0.2 * (x - 11.5);
      }
      return { svf: { data: svf, dims: [1, 24, 32, 40, 3] } };
    },
    release: () => {}
  });
  // Full-grid displacement at voxel x: the upsample maps x to SVF
  // coordinate x * 23 / 159 and scales voxel units by 160 / 24.
  const displacementAt = x => (160 / 24) * ((x * 23) / 159 - 11.5) * contraction;
  const errorsBefore = events.errors.length;
  await settle(pipeline.runRegistration({ ...settings, executionProviders: ['wasm'], brainMaskBuffer: brainMask.buffer, brainMaskDims: dims }));
  assert.equal(events.errors.length, errorsBefore);
  // 80 * 80 * 100 = 640000 source voxels; the reference foreground (> 5 % of
  // its maximum) is its 100 * 100 * 120 = 1200000-voxel box. p01 and p99 of
  // 50 + x mod 7 are 50 and 56.
  const normalisationLog = events.logs.find(line => line.startsWith('SynthMorph masked normalization:'));
  assert.match(normalisationLog, /source=640\D?000 voxels \(p01=50\.000, p99=56\.000\), target=1\D?200\D?000 voxels/);

  const contractedMagnitude = decode(events.stages['registration-displacement-mag']).data;
  for (const x of [0, 40, 79, 120, 159]) {
    const got = contractedMagnitude[index(x, 80, 96)];
    const want = Math.abs(displacementAt(x));
    // 7 squaring steps approximate e^a by (1 + a / 128)^128, 0.1 % off.
    assert.ok(Math.abs(got - want) < 2e-2, `|displacement| at x=${x}: got ${got}, expected ${want}`);
  }
  // displacementAt(0) = 13.897 voxels; the raw velocity would give 15.333.
  assert.ok(Math.abs(displacementAt(0) - 13.897) < 1e-3);

  const maskedRegistered = decode(events.stages['registered-t1-mni160']).data;
  // Inside the brain: (value - 50) / (56 - 50). Voxel x = 79 samples
  // x = 79.0874, between (79 mod 7) / 6 = 2/6 and (80 mod 7) / 6 = 3/6.
  const inside = maskedRegistered[index(79, 60, 60)];
  const expectedInside = 2 / 6 + displacementAt(79) / 6;
  assert.ok(Math.abs(displacementAt(79) - 0.0874) < 1e-4);
  assert.ok(Math.abs(inside - expectedInside) < 1e-3, `masked registered T1: got ${inside}, expected ${expectedInside}`);
  // Outside the brain mask the source is zeroed: voxel x = 145 samples
  // x = 133.55, inside the bright slab, which robust scaling alone would
  // clip to 1.
  assert.ok(Math.abs(145 + displacementAt(145) - 133.55) < 0.01);
  assert.equal(maskedRegistered[index(145, 60, 60)], 0, 'non-brain voxels are zeroed before registration');

  // reset-state drops the displacement field.
  await settle(pipeline.resetWorkerState());
  await settle(pipeline.runWarpMask({ maskBuffer: lesion.buffer.slice(0), maskDims: dims }));
  assert.equal(events.errors.at(-1), 'No displacement available. Run Register first.');
}

// ---- policy lint (source property, not behaviour) ----
// A module worker must not use top-level await: Chromium drops messages
// posted while the module is suspended, so the first 'init' would be lost.
{
  const source = fs.readFileSync(new URL('../web/js/inference-worker.js', import.meta.url), 'utf8');
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const topLevelAwait = program.body.filter(node => {
    const expression = node.type === 'ExpressionStatement' ? node.expression : node.declarations?.[0]?.init;
    return expression?.type === 'AwaitExpression' || node.type === 'ForOfStatement' && node.await;
  });
  assert.deepEqual(topLevelAwait.map(node => source.slice(node.start, node.end)), [], 'no top-level await in the worker module');
}

console.log('inference worker OK: executor -> worker protocol, segmentation, DeepISLES seed, SynthStrip, registration and warps executed.');
