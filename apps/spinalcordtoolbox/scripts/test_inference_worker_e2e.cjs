#!/usr/bin/env node
/**
 * End-to-end test of web/js/inference-worker.js against browser-runnable
 * SCT fixture/model pairs.
 *
 * Loads the worker source as text, evaluates it in a Node context with shimmed
 * globals (self/importScripts/fetch/localforage/ort/nifti), then drives it via
 * a synthetic message and asserts the produced segmentation is non-empty and
 * overlaps the SCT batch reference.
 *
 * Catches the regression class: changes to inference-worker.js preprocessing,
 * model selection, patching, or post-processing that silently produce
 * empty/degenerate outputs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ort = require('onnxruntime-node');
const loadClassicScript = require('./load-classic-script.cjs');
const nifti = loadClassicScript(path.resolve(__dirname, '../web/nifti-js/index.js'));
const manifest = require('../web/models/manifest.json');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const { ensureHostedAsset } = require('./hosted-assets.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'web/js/inference-worker.js');

const FIXTURE_CASES = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    taskId: 'spinalcord',
    modelAssetId: 'sct-spinalcord',
    modelName: 'sct-spinalcord.onnx',
    patchSize: [160, 224, 64],
    minDice: 0.95,
    foregroundRatioTolerance: 0.1,
    inputPath: 'test_data/batch_t2_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz'
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    taskId: 'spinalcord',
    modelAssetId: 'sct-spinalcord',
    modelName: 'sct-spinalcord.onnx',
    patchSize: [160, 224, 64],
    minDice: 0.5,
    foregroundRatioTolerance: 0.5,
    inputPath: 'test_data/batch_dmri_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_dmri_deepseg_spinalcord/batch_output.nii.gz'
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    taskId: 'graymatter',
    modelAssetId: 'sct-graymatter',
    modelName: 'sct-graymatter.onnx',
    patchSize: [64, 64, 64],
    minDice: 0.7,
    foregroundRatioTolerance: 0.15,
    inputPath: 'test_data/batch_t2s_deepseg_graymatter/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2s_deepseg_graymatter/batch_output.nii.gz'
  }
]);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function loadFixtureForeground(filePath) {
  const compressed = fs.readFileSync(filePath);
  const zlib = require('node:zlib');
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (bytes.readInt32LE(0) !== 348) throw new Error(`Only NIfTI-1: ${filePath}`);
  const datatype = bytes.readInt16LE(70);
  const voxOffset = Math.ceil(bytes.readFloatLE(108));
  const dims = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const n = dims[0] * dims[1] * dims[2];
  let fg = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (datatype === 2) v = bytes[voxOffset + i];
    else if (datatype === 4) v = bytes.readInt16LE(voxOffset + i * 2);
    else if (datatype === 16) v = bytes.readFloatLE(voxOffset + i * 4);
    if (v > 0) fg++;
  }
  return { dims, fg };
}

function decodeWorkerNifti(niftiData) {
  const niftiBytes = niftiData instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(niftiData))
    : Buffer.from(niftiData.buffer || niftiData);
  const datatype = niftiBytes.readInt16LE(70);
  const voxOffset = Math.ceil(niftiBytes.readFloatLE(108));
  const dims = [niftiBytes.readInt16LE(42), niftiBytes.readInt16LE(44), niftiBytes.readInt16LE(46)];
  const n = dims[0] * dims[1] * dims[2];
  if (datatype !== 2) fail(`expected uint8 segmentation output, got datatype=${datatype}`);
  const labels = new Uint8Array(n);
  let foreground = 0;
  for (let i = 0; i < n; i++) {
    labels[i] = niftiBytes[voxOffset + i] > 0 ? 1 : 0;
    if (labels[i]) foreground++;
  }
  return { dims, labels, foreground };
}

function loadFixtureLabels(filePath) {
  const compressed = fs.readFileSync(filePath);
  const zlib = require('node:zlib');
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (bytes.readInt32LE(0) !== 348) throw new Error(`Only NIfTI-1: ${filePath}`);
  const datatype = bytes.readInt16LE(70);
  const voxOffset = Math.ceil(bytes.readFloatLE(108));
  const dims = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const n = dims[0] * dims[1] * dims[2];
  const labels = new Uint8Array(n);
  let foreground = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (datatype === 2) v = bytes[voxOffset + i];
    else if (datatype === 4) v = bytes.readInt16LE(voxOffset + i * 2);
    else if (datatype === 16) v = bytes.readFloatLE(voxOffset + i * 4);
    labels[i] = v > 0 ? 1 : 0;
    if (labels[i]) foreground++;
  }
  return { dims, labels, foreground };
}

function diceCoefficient(produced, expected) {
  let intersection = 0;
  for (let i = 0; i < expected.labels.length; i++) {
    if (produced.labels[i] && expected.labels[i]) intersection++;
  }
  return (2 * intersection) / (produced.foreground + expected.foreground || 1);
}

// Build an ort shim that maps onnxruntime-web API surface to onnxruntime-node.
function makeOrtShim() {
  return {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: async (data /* ArrayBuffer */, _opts) => {
        // onnxruntime-node accepts Buffer or path; convert ArrayBuffer to Buffer
        const buf = Buffer.from(data);
        const session = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
        return session;
      }
    },
    env: {
      wasm: { numThreads: 1, wasmPaths: '' }
    }
  };
}

// Minimal localforage shim: in-memory Map.
function makeLocalforageShim() {
  const store = new Map();
  return {
    config: () => {},
    getItem: async (key) => store.has(key) ? store.get(key) : null,
    setItem: async (key, value) => { store.set(key, value); },
    removeItem: async (key) => { store.delete(key); }
  };
}

// Fetch shim: reads MODEL_PATH from disk for any model URL.
function makeFetchShim() {
  return async (url) => {
    if (!url.endsWith('.onnx')) throw new Error(`Unexpected fetch: ${url}`);
    const modelName = path.basename(new URL(url).pathname);
    const modelPath = path.join(ROOT, 'web/models', modelName);
    const buffer = fs.readFileSync(modelPath);
    let offset = 0;
    return {
      ok: true,
      headers: { get: (name) => name === 'content-length' ? String(buffer.length) : null },
      body: {
        getReader: () => ({
          read: async () => {
            if (offset >= buffer.length) return { done: true, value: undefined };
            const chunk = buffer.subarray(offset, Math.min(offset + 1024 * 1024, buffer.length));
            offset += chunk.length;
            return { done: false, value: new Uint8Array(chunk) };
          }
        })
      }
    };
  };
}

async function runWorkerCase(testCase) {
  const task = manifest.tasks.find(item => item.id === testCase.taskId);
  const asset = task?.modelAssets?.find(item => item.id === testCase.modelAssetId);
  if (!asset) throw new Error(`No model asset ${testCase.modelAssetId} for task ${testCase.taskId}`);
  await ensureHostedAsset(ROOT, asset);
  console.log('Loading worker source...');
  const workerSource = fs.readFileSync(WORKER_PATH, 'utf8');

  const messages = [];
  let resolveDone, rejectDone;
  const donePromise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  // Build the sandbox `self` (also exposed as global).
  const selfObj = {
    onmessage: null,
    postMessage: (msg /*, transferList */) => {
      messages.push(msg);
      if (msg && msg.type === 'error') rejectDone(new Error(msg.message));
      if (msg && msg.type === 'complete') resolveDone();
    },
    _modelCacheKey: null,
    _appVersion: 'test',
    _currentTaskId: null
  };

  const sandbox = {
    self: selfObj,
    // External scripts (ort/localforage/nifti, the wasm bundle) are pre-shimmed
    // via context globals, so we ignore those importScripts calls. For local
    // worker modules we evaluate the file so each UMD bootstrap registers on `self`.
    importScripts: (relPath) => {
      if (typeof relPath !== 'string') return;
      if (!/(inference-pipeline|modules\/lesion-analysis|modules\/vertebrae|modules\/totalspineseg)\.js$/.test(relPath)) return;
      const abs = path.resolve(path.dirname(WORKER_PATH), relPath);
      if (!fs.existsSync(abs)) return;
      const src = fs.readFileSync(abs, 'utf8');
      vm.runInContext(src, sandbox, { filename: abs });
      // The UMD bootstraps assign to `root.*`
      // where root === self in worker context. In our vm sandbox, `self` is a
      // sandbox property (not the global itself), so promote exports to
      // bare global so bare-name references in inference-worker.js resolve.
      for (const name of ['SCTInferencePipeline', 'SCTLesionAnalysis', 'VertebraeLabeling', 'TotalSpineSeg']) {
        if (selfObj[name]) sandbox[name] = selfObj[name];
      }
    },
    ort: makeOrtShim(),
    localforage: makeLocalforageShim(),
    nifti,
    fetch: makeFetchShim(),
    performance: { now: () => Date.now() },
    console,
    Math,
    Number,
    Array,
    Uint8Array,
    Uint16Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    ArrayBuffer,
    SharedArrayBuffer,
    Buffer,
    Object,
    String,
    Boolean,
    Promise,
    Set,
    Map,
    Symbol,
    Error,
    TypeError,
    RangeError,
    Infinity,
    NaN,
    URL,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    setTimeout,
    clearTimeout,
    setImmediate,
    queueMicrotask,
    navigator: { hardwareConcurrency: 1 },
    location: { href: 'http://localhost/' }
  };

  vm.createContext(sandbox);
  // Make selfObj fields also accessible as bare globals (worker uses both `self.x` and bare names).
  sandbox.globalThis = sandbox;

  console.log('Evaluating worker source...');
  vm.runInContext(workerSource, sandbox, { filename: 'inference-worker.js' });

  if (typeof selfObj.onmessage !== 'function') {
    fail('worker did not register self.onmessage');
  }

  console.log(`Loading fixture input: ${testCase.id}...`);
  const inputBytes = fs.readFileSync(path.join(ROOT, testCase.inputPath));
  // Wrap into an ArrayBuffer view that the worker's parser expects.
  const inputArrayBuffer = inputBytes.buffer.slice(inputBytes.byteOffset, inputBytes.byteOffset + inputBytes.byteLength);

  console.log(`Driving worker: init -> run ${testCase.taskId}...`);
  // init
  await selfObj.onmessage({ data: { type: 'init', version: 'test' } });

  // legacy 'run' message: stepLoad + stepInference in one go
  selfObj.onmessage({
    data: {
      type: 'run',
      data: {
        inputData: inputArrayBuffer,
        settings: {
          overlap: asset?.inferenceDefaults?.overlap ?? 0,
          taskId: testCase.taskId,
          modelAssetId: testCase.modelAssetId,
          supportStatus: 'supported',
          cacheKey: `${testCase.taskId}:${testCase.modelAssetId}:stable`,
          provenance: { taskId: testCase.taskId, appVersion: 'test' },
          threshold: asset?.inferenceDefaults?.probabilityThreshold ?? 0.5,
          minComponentSize: asset?.inferenceDefaults?.minComponentSize ?? 10,
          keepLargestComponent: !!asset?.inferenceDefaults?.keepLargestComponent,
          modelName: testCase.modelName,
          modelUrl: asset?.downloadUrl || null,
          patchSize: testCase.patchSize || asset?.patchSize,
          preprocessing: asset?.preprocessing || {},
          output: asset?.output || {},
          testTimeAugmentation: false, // turn off TTA for speed; bug is independent of TTA
          modelBaseUrl: 'http://localhost/web/models'
        }
      }
    }
  }).catch(rejectDone);

  // Watchdog
  const timeout = setTimeout(() => rejectDone(new Error('worker did not complete in 5min')), 5 * 60 * 1000);
  await donePromise;
  clearTimeout(timeout);

  if (Array.isArray(testCase.expectedStages) && testCase.expectedStages.length > 0) {
    for (const stage of testCase.expectedStages) {
      const stageMsg = messages.find(m => m && m.type === 'stageData' && m.stage === stage);
      if (!stageMsg) {
        const emittedStages = messages.filter(m => m && m.type === 'stageData').map(m => m.stage).join(', ') || '(none)';
        const logTail = messages
          .filter(m => m && m.type === 'log')
          .slice(-12)
          .map(m => m.message)
          .join('\n');
        fail(`${testCase.id}: worker did not emit ${stage} stageData; emitted stages: ${emittedStages}\nLog tail:\n${logTail}`);
      }
      const produced = decodeWorkerNifti(stageMsg.niftiData);
      console.log(`${stage}: foreground voxels=${produced.foreground}, dims=${produced.dims.join('x')}`);
      const minForeground = testCase.minForegroundByStage?.[stage] ?? 1;
      if (produced.foreground < minForeground) {
        fail(`${testCase.id}: ${stage} foreground ${produced.foreground} is below minimum ${minForeground}`);
      }
    }
    console.log(`PASS: inference-worker e2e on ${testCase.id}`);
    return { messages };
  }

  // Find the segmentation stage data
  const stageMsg = messages.find(m => m && m.type === 'stageData' && m.stage === 'segmentation');
  if (!stageMsg) fail('worker did not emit segmentation stageData');

  const produced = decodeWorkerNifti(stageMsg.niftiData);
  const { dims, foreground: producedFg } = produced;
  const expected = loadFixtureForeground(path.join(ROOT, testCase.expectedOutputPath));
  const expectedLabels = loadFixtureLabels(path.join(ROOT, testCase.expectedOutputPath));
  const dice = diceCoefficient(produced, expectedLabels);

  console.log(`Produced foreground voxels: ${producedFg}`);
  console.log(`SCT batch reference foreground voxels: ${expected.fg}`);
  console.log(`Dice vs SCT batch reference: ${dice.toFixed(4)}`);
  console.log(`Output dims: ${dims.join('x')}, expected dims: ${expected.dims.join('x')}`);

  if (producedFg === 0) fail(`${testCase.id}: worker produced empty segmentation`);
  const foregroundRatioTolerance = testCase.foregroundRatioTolerance == null ? 0.5 : testCase.foregroundRatioTolerance;
  if (producedFg < expected.fg * (1 - foregroundRatioTolerance) || producedFg > expected.fg * (1 + foregroundRatioTolerance)) {
    fail(`${testCase.id}: worker foreground count ${producedFg} differs from SCT batch reference ${expected.fg} by >${Math.round(foregroundRatioTolerance * 100)}%`);
  }
  if (dims[0] !== expected.dims[0] || dims[1] !== expected.dims[1] || dims[2] !== expected.dims[2]) {
    fail(`${testCase.id}: output dims ${dims.join('x')} != expected ${expected.dims.join('x')}`);
  }
  const minDice = testCase.minDice == null ? 0.5 : testCase.minDice;
  if (dice < minDice) {
    fail(`${testCase.id}: worker Dice ${dice.toFixed(4)} is below the ${minDice.toFixed(4)} minimum`);
  }

  console.log(`PASS: inference-worker e2e on ${testCase.id}`);
  return { messages, dims, producedFg, dice, expected };
}

async function main() {
  await ensureSctBatchFixtures(ROOT);
  const runnableCases = FIXTURE_CASES.filter(testCase => {
    const task = manifest.tasks.find(item => item.id === testCase.taskId);
    if (!task || task.supportStatus !== 'supported' || task.validationStatus !== 'passed') {
      console.log(`SKIP: ${testCase.id} (${testCase.taskId} is not supported/passed in manifest)`);
      return false;
    }
    return true;
  });
  if (runnableCases.length === 0) fail('no supported inference-worker fixture cases were selected');
  for (const testCase of runnableCases) {
    await runWorkerCase(testCase);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Test crashed:', err && err.stack || err);
    process.exit(1);
  });
}

module.exports = {
  runWorkerCase,
  FIXTURE_CASES,
  fail
};
