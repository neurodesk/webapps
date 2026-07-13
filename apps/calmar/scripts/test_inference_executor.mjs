#!/usr/bin/env node --no-warnings
// Phase 35: behavior tests for web/js/controllers/InferenceExecutor.js.
//
// The executor mediates the message protocol between the orchestrator
// and the worker. Source-grep covered method existence; this test
// covers the actual state machine + message routing using a fake Worker
// constructor that records postMessage calls and lets the test manually
// drive onmessage events.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fake Worker. Records every postMessage; lets the test fire fake
// onmessage / onerror events. globalThis.Worker is the constructor that
// the executor instantiates via `new Worker(...)`.
class FakeWorker {
  constructor(url, opts) {
    FakeWorker.instances.push(this);
    this.url = url;
    this.opts = opts;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }
  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  // Helper for tests: deliver a message into the executor's onmessage.
  _deliver(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}
FakeWorker.instances = [];
globalThis.Worker = FakeWorker;
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.File = class { constructor(parts, name) { this.parts = parts; this.name = name; } };

const { InferenceExecutor } = await import(path.join(ROOT, 'web/js/controllers/InferenceExecutor.js'));

function makeExecutor() {
  FakeWorker.instances.length = 0;
  const events = {
    output: [], debugOutput: [], progress: [], stageData: [], complete: 0,
    error: [], initialized: 0, stepComplete: [], volumeInfo: []
  };
  const exec = new InferenceExecutor({
    updateOutput: (m) => events.output.push(m),
    updateDebugOutput: (m, options) => events.debugOutput.push({ message: m, options }),
    setProgress: (v, l) => events.progress.push([v, l]),
    onStageData: (d) => { events.stageData.push(d); },
    onComplete: () => { events.complete++; },
    onError: (m) => events.error.push(m),
    onInitialized: () => { events.initialized++; },
    onStepComplete: (s) => events.stepComplete.push(s),
    onVolumeInfo: (i) => events.volumeInfo.push(i)
  });
  return { exec, events, getWorker: () => FakeWorker.instances[0] };
}

// ---- Test 1: initialize() boots a worker, sends 'init', resolves on 'initialized' ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initPromise = exec.initialize();
  const w = getWorker();
  assert.ok(w, 'a worker must be instantiated');
  // First message posted is the init.
  assert.equal(w.posted[0].msg.type, 'init');
  assert.ok(w.posted[0].msg.version, 'init message must include version');
  // Deliver 'initialized' -> resolves initialize() and fires onInitialized.
  w._deliver({ type: 'initialized', webgpuAvailable: true });
  await initPromise;
  assert.equal(exec.isReady(), true);
  assert.equal(events.initialized, 1);
  assert.equal(exec.webgpuAvailable, true);
  assert.equal(events.output.length, 0,
    'worker initialization chatter must stay out of the clinician log');
  assert.ok(events.debugOutput.some(e => e.message === 'ONNX Runtime ready'),
    'worker initialization must be captured in the technical log');
}

// ---- Test 1b: worker log messages route to the technical log only ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initPromise = exec.initialize();
  const w = getWorker();
  w._deliver({ type: 'initialized' });
  await initPromise;
  const outputCount = events.output.length;
  w._deliver({ type: 'log', message: 'Session created. Input=x, Output=y' });
  assert.equal(events.output.length, outputCount,
    'model/process log messages must not be shown in the clinician log');
  const logEntry = events.debugOutput.at(-1);
  assert.equal(logEntry.message, 'Session created. Input=x, Output=y');
  assert.deepEqual(logEntry.options, { source: 'worker', audience: 'technical' },
    'model/process log messages must carry diagnostic routing metadata');
}

// ---- Test 2: loadVolume posts 'load' message with the buffer transferred ----
{
  const { exec, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  const buf = new Uint8Array([1, 2, 3, 4]).buffer;
  await exec.loadVolume(buf);
  const w = getWorker();
  const loadMsg = w.posted.find(p => p.msg.type === 'load');
  assert.ok(loadMsg, 'load message must be sent');
  assert.equal(loadMsg.msg.data.inputData.byteLength, 4);
  assert.deepEqual(loadMsg.transfer, [buf],
    'load must transfer the buffer (zero-copy)');
  assert.equal(exec.isRunning(), true);
  assert.equal(exec.getStepStatus('load'), 'running');
}

// ---- Test 3: runSynthStrip posts 'run-synthstrip' + tracks state ----
{
  const { exec, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runSynthStrip({
    modelAssetId: 'lnm-synthstrip', modelName: 'synthstrip.onnx',
    modelBaseUrl: 'https://example.com', modelCacheKey: 'k'
  });
  const w = getWorker();
  const msg = w.posted.find(p => p.msg.type === 'run-synthstrip');
  assert.ok(msg);
  assert.equal(msg.msg.data.modelAssetId, 'lnm-synthstrip');
  assert.equal(exec.getStepStatus('brainmask'), 'running');
  assert.equal(exec.currentRunningStep, 'brainmask');
  // Checkpoint captured for cancel-restore.
  assert.ok(exec.pendingAbortCheckpoint, 'checkpoint must capture for runSynthStrip');
  assert.equal(exec.pendingAbortCheckpoint.step, 'brainmask');
}

// ---- Test 4: stageData routing creates a File + invokes onStageData ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  exec.currentTaskId = 'lnm-synthstrip';
  const niftiBytes = new Uint8Array([0x5c, 0x01, 0x00, 0x00]).buffer;
  getWorker()._deliver({
    type: 'stageData',
    stage: 'brainmask',
    niftiData: niftiBytes,
    description: 'Brain mask',
    taskId: 'lnm-synthstrip'
  });
  // Wait one microtask for the async onStageData handler.
  await new Promise(r => setImmediate(r));
  assert.equal(exec.hasResult('brainmask'), true,
    'stageData must populate this.results[stage]');
  const result = exec.getResult('brainmask');
  assert.ok(result.file, 'result must include a File');
  assert.equal(result.file.name, 'lnm-synthstrip_brainmask.nii');
  assert.equal(events.stageData.length, 1, 'onStageData callback fires once');
  assert.equal(exec.getStageOrder()[0], 'brainmask');
  // Re-delivery of the same stage doesn't duplicate stageOrder.
  getWorker()._deliver({
    type: 'stageData', stage: 'brainmask',
    niftiData: niftiBytes.slice(0), description: 'redo'
  });
  await new Promise(r => setImmediate(r));
  assert.equal(exec.getStageOrder().length, 1,
    'stageOrder must dedupe by stage name');
}

// ---- Test 4b: runInverseWarpMask posts inverse-warp-mask + transfers mask ----
{
  const { exec, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  const maskBuffer = new Uint8Array([1, 0, 1, 0]).buffer;
  await exec.runInverseWarpMask({
    maskBuffer,
    maskDims: [2, 2, 1],
    stage: 'threshold-patient'
  });
  const w = getWorker();
  const msg = w.posted.find(p => p.msg.type === 'inverse-warp-mask');
  assert.ok(msg, 'inverse-warp-mask message must be sent');
  assert.equal(msg.msg.data.stage, 'threshold-patient');
  assert.deepEqual(msg.transfer, [maskBuffer],
    'inverse-warp-mask must transfer the mask buffer');
  assert.equal(exec.getStepStatus('inverse-warp-mask'), 'running');
  assert.equal(exec.currentRunningStep, 'inverse-warp-mask');
}

// ---- Test 4c: inverse-warp step-complete updates status ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runInverseWarpMask({ maskBuffer: new Uint8Array([1]).buffer });
  getWorker()._deliver({ type: 'step-complete', step: 'inverse-warp-mask' });
  assert.equal(exec.getStepStatus('inverse-warp-mask'), 'complete');
  assert.equal(exec.isRunning(), false);
  assert.deepEqual(events.stepComplete, ['inverse-warp-mask']);
}

// ---- Test 5: step-complete updates status + invokes onStepComplete ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runSynthStrip({});
  getWorker()._deliver({ type: 'step-complete', step: 'brainmask' });
  assert.equal(exec.getStepStatus('brainmask'), 'complete');
  assert.equal(exec.isRunning(), false);
  assert.equal(exec.currentRunningStep, null);
  assert.deepEqual(events.stepComplete, ['brainmask']);
}

// ---- Test 6: error routing -> _handleError + onError + state cleared ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runSynthStrip({});
  getWorker()._deliver({ type: 'error', message: 'synthetic worker failure' });
  assert.equal(exec.isRunning(), false);
  assert.equal(events.error.length, 1);
  assert.match(events.error[0], /synthetic worker failure/);
  // updateOutput surfaces 'Error: ...' line and progress is reset.
  assert.ok(events.output.some(m => /Error: synthetic worker failure/.test(m)));
  assert.deepEqual(events.progress[events.progress.length - 1], [0, 'Failed']);
}

// ---- Test 7: cancel terminates the worker + clears state ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runSynthStrip({});
  const w = getWorker();
  exec.cancel();
  assert.equal(w.terminated, true, 'worker must be terminated on cancel');
  assert.equal(exec.isRunning(), false);
  assert.equal(exec.workerReady, false);
  assert.deepEqual(events.progress[events.progress.length - 1], [0, 'Cancelled']);
}

// ---- Test 8: cancel is a no-op when nothing is running ----
{
  const { exec, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  const w = getWorker();
  exec.cancel();
  assert.equal(w.terminated, false,
    'cancel() while idle must NOT terminate the worker');
}

// ---- Test 9: clearResults / removeResult prune state ----
{
  const { exec, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  exec.results = { a: { file: 'x' }, b: { file: 'y' } };
  exec.stageOrder = ['a', 'b'];
  exec.removeResult('a');
  assert.deepEqual(exec.stageOrder, ['b'],
    'removeResult must drop the stage from stageOrder');
  assert.equal(exec.hasResult('a'), false);
  exec.clearResults();
  assert.equal(exec.hasResult('b'), false);
  assert.deepEqual(exec.stageOrder, []);
}

// ---- Test 10: volume-info routing -> onVolumeInfo callback ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  getWorker()._deliver({
    type: 'volume-info', rasDims: [160, 256, 256], rasSpacing: [1, 1, 1], totalSlices: 256
  });
  assert.equal(events.volumeInfo.length, 1);
  assert.deepEqual(exec.getVolumeInfo(), {
    rasDims: [160, 256, 256], rasSpacing: [1, 1, 1], totalSlices: 256
  });
}

// ---- Test 11: 'complete' message fires onComplete + clears running ----
{
  const { exec, events, getWorker } = makeExecutor();
  const initP = exec.initialize();
  getWorker()._deliver({ type: 'initialized' });
  await initP;
  await exec.runSynthStrip({});
  getWorker()._deliver({ type: 'complete' });
  assert.equal(events.complete, 1);
  assert.equal(exec.isRunning(), false);
  assert.equal(exec.currentRunningStep, null);
}

console.log('InferenceExecutor OK: 14 cases (init/log-routing/load/run/stageData/step/error/cancel/clear/volumeInfo/inverse-warp).');
