#!/usr/bin/env node

import assert from 'node:assert/strict';

// We test the message-handling logic by attaching a fake worker after
// construction (bypassing _setupWorker, which requires a browser Worker).
// Globals (Blob, File, URL) used by stage-data handling are provided by
// modern Node, but we shim document for downloadStage's <a> creation.

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
}

function makeStubElement() {
  return {
    classList: new FakeClassList(),
    style: {},
    href: '',
    download: '',
    click() { this.clicked = true; },
    appendChild() {},
    removeChild() {}
  };
}

globalThis.document = {
  body: makeStubElement(),
  createElement: () => makeStubElement(),
  getElementById: () => null
};
globalThis.URL = globalThis.URL || {};
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:fake';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

const { InferenceExecutor } = await import('../web/js/controllers/InferenceExecutor.js');

function makeExecutor(callbacks = {}) {
  const log = [];
  const progress = [];
  const completed = [];
  const errors = [];
  const stages = [];
  const stepCompletes = [];
  const volumes = [];
  const initialized = [];

  const exec = new InferenceExecutor({
    updateOutput: (m) => log.push(m),
    setProgress: (v, t) => progress.push([v, t]),
    onComplete: () => completed.push(true),
    onError: (m) => errors.push(m),
    onStageData: (d) => stages.push(d.stage),
    onStepComplete: (s) => stepCompletes.push(s),
    onVolumeInfo: (v) => volumes.push(v),
    onInitialized: () => initialized.push(true),
    ...callbacks
  });

  return { exec, log, progress, completed, errors, stages, stepCompletes, volumes, initialized };
}

// Wire up a fake worker so the message handler can be exercised.
function attachFakeWorker(exec) {
  const sent = [];
  const fakeWorker = {
    postMessage: (msg, transferables) => sent.push({ msg, transferables }),
    terminate: () => { fakeWorker.terminated = true; },
    onmessage: null,
    onerror: null,
    terminated: false
  };
  exec.worker = fakeWorker;
  // Attach the same handlers _setupWorker would have installed.
  exec.worker.onmessage = (e) => {
    const { type, ...data } = e.data;
    switch (type) {
      case 'progress': exec.setProgress(data.value, data.text); break;
      case 'log': exec.updateOutput(data.message); break;
      case 'error': exec._handleError(data.message); break;
      case 'initialized':
        exec.workerReady = true;
        exec.workerInitializing = false;
        exec.webgpuAvailable = !!data.webgpuAvailable;
        exec.updateOutput('ONNX Runtime ready');
        exec.onInitialized();
        break;
      case 'complete': exec._handleComplete(); break;
      case 'stageData': exec._handleStageData(data); break;
      case 'step-complete': exec._handleStepComplete(data.step); break;
      case 'volume-info': exec._handleVolumeInfo(data); break;
    }
  };
  return { fakeWorker, sent };
}

// Test 1: initial state
{
  const { exec } = makeExecutor();
  assert.equal(exec.isReady(), false);
  assert.equal(exec.isRunning(), false);
  assert.deepEqual(exec.getStageOrder(), []);
  assert.equal(exec.getStepStatus('load'), 'pending');
  assert.equal(exec.getStepStatus('inference'), 'pending');
  assert.equal(exec.hasResult('inference'), false);
  assert.equal(exec.getVolumeInfo(), null);
}

// Test 2: progress messages route to setProgress
{
  const { exec, progress } = makeExecutor();
  attachFakeWorker(exec);
  exec.worker.onmessage({ data: { type: 'progress', value: 0.25, text: 'Loading' } });
  exec.worker.onmessage({ data: { type: 'progress', value: 0.5, text: 'Inferring' } });
  assert.deepEqual(progress, [[0.25, 'Loading'], [0.5, 'Inferring']]);
}

// Test 3: initialized message flips workerReady and fires callback
{
  const { exec, initialized, log } = makeExecutor();
  attachFakeWorker(exec);
  exec.worker.onmessage({ data: { type: 'initialized', webgpuAvailable: true } });
  assert.equal(exec.isReady(), true);
  assert.equal(exec.webgpuAvailable, true);
  assert.equal(initialized.length, 1);
  assert.ok(log.includes('ONNX Runtime ready'));
}

// Test 4: stageData adds to results, sets stage order, names file by taskId
{
  const { exec, stages } = makeExecutor();
  attachFakeWorker(exec);
  exec.currentTaskId = 'spinalcord';
  const niftiData = new Uint8Array([1, 2, 3]).buffer;
  exec.worker.onmessage({
    data: {
      type: 'stageData',
      stage: 'inference',
      taskId: 'spinalcord',
      description: 'segmentation',
      niftiData
    }
  });
  assert.deepEqual(exec.getStageOrder(), ['inference']);
  assert.equal(exec.hasResult('inference'), true);
  assert.equal(exec.getResult('inference').file.name, 'spinalcord_inference.nii');
  assert.equal(stages[0], 'inference');
}

// Test 4b: metrics stageData is stored as CSV/table data, not as a NIfTI
{
  const { exec, stages } = makeExecutor();
  attachFakeWorker(exec);
  exec.currentTaskId = 'lesion_sci_t2';
  exec.worker.onmessage({
    data: {
      type: 'stageData',
      kind: 'metrics',
      stage: 'lesion_metrics',
      taskId: 'lesion_sci_t2',
      description: 'metrics',
      rows: [{ lesion_id: 1, volume_mm3: 12 }],
      summary: { lesion_count: 1 },
      csv: 'row_type,lesion_id\nlesion,1\n',
      filename: 'lesion_sci_t2_lesion_metrics.csv'
    }
  });
  assert.deepEqual(exec.getStageOrder(), ['lesion_metrics']);
  assert.equal(exec.hasResult('lesion_metrics'), true);
  assert.equal(exec.getResult('lesion_metrics').kind, 'metrics');
  assert.equal(exec.getResult('lesion_metrics').file.name, 'lesion_sci_t2_lesion_metrics.csv');
  assert.equal(exec.getResult('lesion_metrics').rows[0].volume_mm3, 12);
  assert.equal(stages[0], 'lesion_metrics');
}

// Test 5: error message sets progress to 0 and fires onError
{
  const { exec, errors, progress } = makeExecutor();
  attachFakeWorker(exec);
  exec.worker.onmessage({ data: { type: 'error', message: 'model load failed' } });
  assert.deepEqual(errors, ['model load failed']);
  assert.deepEqual(progress.at(-1), [0, 'Failed']);
  assert.equal(exec.isRunning(), false);
}

// Test 6: complete fires onComplete and clears running
{
  const { exec, completed } = makeExecutor();
  attachFakeWorker(exec);
  exec.running = true;
  exec.currentRunningStep = 'inference';
  exec.worker.onmessage({ data: { type: 'complete' } });
  assert.equal(completed.length, 1);
  assert.equal(exec.isRunning(), false);
  assert.equal(exec.currentRunningStep, null);
}

// Test 7: step-complete sets status to 'complete' (not over 'skipped')
{
  const { exec, stepCompletes } = makeExecutor();
  attachFakeWorker(exec);
  exec.stepStatus.inference = 'running';
  exec.worker.onmessage({ data: { type: 'step-complete', step: 'inference' } });
  assert.equal(exec.getStepStatus('inference'), 'complete');
  assert.deepEqual(stepCompletes, ['inference']);

  // 'skipped' is preserved
  exec.stepStatus.load = 'skipped';
  exec.worker.onmessage({ data: { type: 'step-complete', step: 'load' } });
  assert.equal(exec.getStepStatus('load'), 'skipped');
}

// Test 8: volume-info populates volumeInfo and fires onVolumeInfo
{
  const { exec, volumes } = makeExecutor();
  attachFakeWorker(exec);
  exec.worker.onmessage({
    data: { type: 'volume-info', rasDims: [320, 320, 64], rasSpacing: [1, 1, 3], totalSlices: 64 }
  });
  assert.deepEqual(exec.getVolumeInfo(), { rasDims: [320, 320, 64], rasSpacing: [1, 1, 3], totalSlices: 64 });
  assert.equal(volumes.length, 1);
}

// Test 9: resetDownstream resets steps after the given one
{
  const { exec } = makeExecutor();
  exec.stepStatus.load = 'complete';
  exec.stepStatus.inference = 'complete';
  exec.resetDownstream('load');
  assert.equal(exec.getStepStatus('load'), 'complete');
  assert.equal(exec.getStepStatus('inference'), 'pending');
}

// Test 10: removeResult / clearResults
{
  const { exec } = makeExecutor();
  exec.results.inference = { file: 'fake' };
  exec.stageOrder = ['inference', 'morphometry'];
  exec.results.morphometry = { file: 'fake2' };
  exec.removeResult('inference');
  assert.equal(exec.hasResult('inference'), false);
  assert.deepEqual(exec.getStageOrder(), ['morphometry']);
  exec.clearResults();
  assert.equal(exec.hasResult('morphometry'), false);
  assert.deepEqual(exec.getStageOrder(), []);
}

// Test 11: captureCheckpoint snapshots state; deep-clones results
{
  const { exec } = makeExecutor();
  exec.inputVolumeBuffer = new Uint8Array([7, 8, 9]).buffer;
  exec.stepStatus.load = 'complete';
  exec.results.inference = { file: 'orig' };
  const cp = exec.captureCheckpoint('inference');
  assert.equal(cp.step, 'inference');
  assert.equal(cp.stepStatus.load, 'complete');
  // Mutating the live state after capture must not affect the snapshot.
  exec.results.inference = { file: 'mutated' };
  assert.equal(cp.results.inference.file, 'orig');
}

// Test 12: cancel clears state and terminates worker
{
  const { exec, log, progress } = makeExecutor();
  const { fakeWorker } = attachFakeWorker(exec);
  exec.running = true;
  exec.currentRunningStep = 'inference';
  exec.cancel();
  assert.equal(fakeWorker.terminated, true);
  assert.equal(exec.isRunning(), false);
  assert.equal(exec.worker, null);
  assert.deepEqual(progress.at(-1), [0, 'Cancelled']);
  assert.ok(log.some(m => m.includes('Cancelling')));
}

// Test 13: cancel is a no-op when not running
{
  const { exec } = makeExecutor();
  const { fakeWorker } = attachFakeWorker(exec);
  exec.cancel();
  assert.equal(fakeWorker.terminated, false);
}

console.log('InferenceExecutor tests passed');
