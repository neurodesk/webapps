#!/usr/bin/env node
/**
 * Worker message-protocol test.
 *
 * Drives the inference worker via the existing E2E VM scaffold and asserts
 * invariants on the captured postMessage stream that the lightweight
 * fixture-parity test cannot see:
 *   1. At least one progress message arrives before any stageData.
 *   2. Numeric progress values are monotonically non-decreasing.
 *   3. Exactly one terminal message (complete or error) is emitted.
 *   4. Error path: a deliberately broken (zero-byte) input causes the worker
 *      to emit an `error` message rather than throwing or hanging.
 *
 * Reuses runWorkerCase from test_inference_worker_e2e.cjs so we only maintain
 * one VM/shim scaffold.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { runWorkerCase, FIXTURE_CASES } = require('./test_inference_worker_e2e.cjs');
const loadClassicScript = require('./load-classic-script.cjs');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  // Pick the smallest E2E fixture for speed (dmri, 378K input).
  const testCase = FIXTURE_CASES.find(c => c.id === 'batch_dmri_deepseg_spinalcord');
  assert.ok(testCase, 'dmri fixture is available in E2E suite');

  console.log('--- protocol invariants on success path ---');
  const result = await runWorkerCase(testCase);
  const { messages } = result;

  // Invariant 1: at least one progress before any stageData
  const firstProgressIdx = messages.findIndex(m => m && m.type === 'progress');
  const firstStageIdx = messages.findIndex(m => m && m.type === 'stageData');
  assert.ok(firstProgressIdx >= 0, 'at least one progress message');
  assert.ok(firstStageIdx >= 0, 'at least one stageData message');
  assert.ok(firstProgressIdx < firstStageIdx,
    `progress (idx=${firstProgressIdx}) precedes stageData (idx=${firstStageIdx})`);

  // Invariant 2: numeric progress values are monotonically non-decreasing.
  // The worker may issue several distinct progress *phases* (load, inference,
  // post-processing), each restarting from a low value — that is intentional
  // user-facing behavior. We assert non-decrease *within* each contiguous run
  // by checking that no value falls more than 0.05 below the previous value
  // without a phase-change marker (text change).
  let lastValue = -Infinity;
  let lastText = null;
  for (const m of messages) {
    if (!m || m.type !== 'progress') continue;
    if (typeof m.value !== 'number') continue;
    if (m.text !== lastText) {
      // phase change resets the floor
      lastValue = m.value;
      lastText = m.text;
      continue;
    }
    assert.ok(m.value >= lastValue - 1e-9,
      `progress within phase "${lastText}" went backward: ${lastValue} -> ${m.value}`);
    lastValue = m.value;
  }

  // Invariant 3: exactly one terminal message
  const terminals = messages.filter(m => m && (m.type === 'complete' || m.type === 'error'));
  assert.equal(terminals.length, 1, `expected 1 terminal message, got ${terminals.length}`);
  assert.equal(terminals[0].type, 'complete', 'success path emits complete');

  console.log(`Protocol checks passed on ${messages.length} messages.`);

  // --- Error path ---------------------------------------------------------
  // Drive a fresh worker instance with a deliberately invalid (zero-byte)
  // input and assert it emits {type:'error'} rather than throwing/hanging.
  console.log('--- protocol invariants on error path ---');
  await runErrorCase();

  console.log('Worker protocol tests passed');
}

// Self-contained error-path runner. We don't use runWorkerCase because that
// helper hard-fails on the absence of a 'complete' message. Here we *want*
// an error and treat 'complete' as the failure mode.
async function runErrorCase() {
  const ort = require('onnxruntime-node');
  const nifti = loadClassicScript(path.resolve(ROOT, 'web/nifti-js/index.js'));
  const WORKER_PATH = path.join(ROOT, 'web/js/inference-worker.js');
  const workerSource = fs.readFileSync(WORKER_PATH, 'utf8');

  const messages = [];
  let resolveDone, rejectDone;
  const donePromise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const selfObj = {
    onmessage: null,
    postMessage: (msg) => {
      messages.push(msg);
      if (msg && (msg.type === 'error' || msg.type === 'complete')) resolveDone();
    },
    _modelCacheKey: null,
    _appVersion: 'test',
    _currentTaskId: null
  };

  const sandbox = {
    self: selfObj,
    importScripts: (relPath) => {
      if (typeof relPath !== 'string') return;
      if (!/(inference-pipeline|modules\/lesion-analysis|modules\/vertebrae|modules\/totalspineseg)\.js$/.test(relPath)) return;
      const abs = path.resolve(path.dirname(WORKER_PATH), relPath);
      if (!fs.existsSync(abs)) return;
      const src = fs.readFileSync(abs, 'utf8');
      vm.runInContext(src, sandbox, { filename: abs });
      for (const name of ['SCTInferencePipeline', 'SCTLesionAnalysis', 'VertebraeLabeling', 'TotalSpineSeg']) {
        if (selfObj[name]) sandbox[name] = selfObj[name];
      }
    },
    ort: {
      Tensor: ort.Tensor,
      InferenceSession: { create: async () => ({ run: async () => ({}) }) },
      env: { wasm: { numThreads: 1, wasmPaths: '' } }
    },
    localforage: {
      config: () => {},
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {}
    },
    nifti,
    fetch: async () => { throw new Error('no model fetch on error path'); },
    performance: { now: () => Date.now() },
    console, Math, Number, Array, Uint8Array, Uint16Array, Int16Array, Int32Array,
    Float32Array, Float64Array, DataView, ArrayBuffer, SharedArrayBuffer, Buffer,
    Object, String, Boolean, Promise, Set, Map, Symbol, Error, TypeError, RangeError,
    Infinity, NaN, URL, parseInt, parseFloat, isFinite, isNaN,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    navigator: { hardwareConcurrency: 1 },
    location: { href: 'http://localhost/' }
  };
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  vm.runInContext(workerSource, sandbox, { filename: 'inference-worker.js' });
  assert.equal(typeof selfObj.onmessage, 'function', 'worker registered onmessage');

  await selfObj.onmessage({ data: { type: 'init', version: 'test' } });

  // Empty input buffer — the NIfTI parser must reject this.
  const emptyBuffer = new ArrayBuffer(0);
  Promise.resolve(selfObj.onmessage({
    data: {
      type: 'run',
      data: {
        inputData: emptyBuffer,
        settings: {
          taskId: 'spinalcord',
          modelAssetId: 'sct-spinalcord',
          supportStatus: 'supported',
          cacheKey: 'spinalcord:sct-spinalcord:stable',
          provenance: { taskId: 'spinalcord', appVersion: 'test' },
          overlap: 0.5,
          probabilityThreshold: 0.5,
          minComponentSize: 0,
          keepLargestComponent: true,
          modelName: 'sct-spinalcord.onnx',
          patchSize: [160, 224, 64],
          preprocessing: {},
          testTimeAugmentation: false,
          modelBaseUrl: 'http://localhost/web/models'
        }
      }
    }
  })).catch(() => { /* swallow — we expect the worker to surface this via postMessage */ });

  const timeout = setTimeout(() => rejectDone(new Error('worker did not terminate in 30s on error path')), 30000);
  await donePromise;
  clearTimeout(timeout);

  const terminals = messages.filter(m => m && (m.type === 'complete' || m.type === 'error'));
  assert.equal(terminals.length, 1, `error path: expected 1 terminal message, got ${terminals.length}`);
  assert.equal(terminals[0].type, 'error', 'broken input must produce error, not complete');
  assert.ok(typeof terminals[0].message === 'string' && terminals[0].message.length > 0,
    'error message is a non-empty string');
  console.log(`Error path produced: ${terminals[0].message}`);
}

main().catch((err) => {
  console.error('Test crashed:', err && err.stack || err);
  process.exit(1);
});
