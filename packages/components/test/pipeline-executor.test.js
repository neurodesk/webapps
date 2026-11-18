import assert from 'node:assert/strict';
import test from 'node:test';
import { PipelineExecutor } from '../src/inference/PipelineExecutor.js';

test('abort recreates, initializes, restores, and repairs the active step', async () => {
  const events = [];
  const workers = [];
  const createWorker = () => {
    const worker = {
      onmessage: null,
      postMessage(message) {
        events.push(`post:${message.type}`);
        if (message.type === 'init') queueMicrotask(() => worker.onmessage({ data: { type: 'initialized' } }));
        if (message.type === 'restore-state') queueMicrotask(() => worker.onmessage({ data: { type: 'state-restored' } }));
      },
      terminate() { events.push('terminate'); },
    };
    workers.push(worker);
    events.push('create');
    return worker;
  };
  const executor = new PipelineExecutor({
    createWorker,
    steps: ['load', 'inference'],
    hiddenArtifacts: { segmentation: null },
  });

  await executor.loadVolume(new Uint8Array([1, 2, 3, 4]).buffer);
  await executor.executeCommand('run-inference', { threshold: 0.5 }, { step: 'inference' });
  const result = await executor.abortCurrentStep();

  assert.equal(workers.length, 2);
  assert.equal(result.abortedStep, 'inference');
  assert.equal(executor.getStepStatus('inference'), 'pending');
  assert.deepEqual(events.slice(-4), ['terminate', 'create', 'post:init', 'post:restore-state']);
});

test('stage results preserve worker provenance for downstream contracts', () => {
  const executor = new PipelineExecutor();
  const provenance = { labelSpaceId: 'musclemap-wholebody-v1.4', encoding: 'sparse' };
  executor.handleStageData({
    type: 'stageData',
    stage: 'segmentation',
    niftiData: new Uint8Array([1, 2, 3]).buffer,
    provenance,
  });
  assert.deepEqual(executor.getResult('segmentation').provenance, provenance);
});

for (const command of ['loadVolume', 'executeCommand']) {
  test(`${command} rechecks its owner after initialization`, async () => {
    const posted = [];
    let current = true;
    const executor = new PipelineExecutor({
      createWorker: () => ({
        postMessage(message) { posted.push(message.type); },
        terminate() {},
      }),
    });
    const check = () => { if (!current) throw new DOMException('replaced', 'AbortError'); };
    const result = command === 'loadVolume'
      ? executor.loadVolume(new Uint8Array([1]).buffer, {}, { assertCurrent: check })
      : executor.executeCommand('run', {}, { assertCurrent: check });
    current = false;
    executor.handleMessage({ type: 'initialized' });
    await assert.rejects(result, { name: 'AbortError' });
    assert.deepEqual(posted, ['init']);
  });
}

test('cancel during initialization settles the old wait without borrowing replacement readiness', async () => {
  const executor = new PipelineExecutor({ createWorker: () => ({ postMessage() {}, terminate() {} }) });
  const initializing = executor.initialize();
  const rejected = assert.rejects(initializing, { name: 'AbortError' });
  executor.cancel();
  const replacement = executor.initialize();
  executor.handleMessage({ type: 'initialized' });
  await replacement;
  await rejected;
  assert.equal(executor.isReady(), true);
});

test('initialization failure releases the readiness wait and preserves the worker error reason', async () => {
  const executor = new PipelineExecutor({ createWorker: () => ({ postMessage() {}, terminate() {} }) });
  const pending = executor.initialize();
  const rejected = assert.rejects(pending, /Worker initialization failed: WebAssembly\.Memory\(\): could not allocate memory/);
  executor.handleMessage({ type: 'error', message: 'WebAssembly.Memory(): could not allocate memory' });
  await rejected;
});

test('a mid-run worker crash terminates the dead worker, rejects pending restore and lets retry start fresh', async () => {
  const workers = [];
  const errors = [];
  let failOnInit = true;
  const executor = new PipelineExecutor({
    createWorker: () => {
      const worker = {
        terminated: false,
        postMessage(message) {
          if (message.type === 'init') {
            queueMicrotask(() => {
              if (failOnInit) worker.onerror({});
              else worker.onmessage({ data: { type: 'initialized' } });
            });
          }
        },
        terminate() { this.terminated = true; },
      };
      workers.push(worker);
      return worker;
    },
    onError: (message) => errors.push(message),
  });

  // 1. Worker error during initialization rejects initialize() and discards the broken session.
  await assert.rejects(executor.initialize(), /Worker initialization failed/);
  assert.equal(workers[0].terminated, true);
  assert.equal(executor.isReady(), false);

  // 2. Retrying initialize() spawns a fresh worker.
  failOnInit = false;
  await executor.run({ label: 'segmentation' });
  assert.equal(workers.length, 2);
  assert.equal(executor.isReady(), true);

  // 3. Worker error during restoreState() rejects the restore promise instead of stranding it.
  const restoring = executor.restoreState({ inputData: new ArrayBuffer(4) });
  const rejectedRestore = assert.rejects(restoring, /stopped unexpectedly \(often low device memory\)/);
  await Promise.resolve();
  workers[1].onerror({});
  await rejectedRestore;
  assert.equal(workers[1].terminated, true);
  assert.equal(executor.isReady(), false);
  assert.equal(executor.isRunning(), false);
  assert.match(errors.at(-1), /stopped unexpectedly \(often low device memory\)/);

  // 4. Subsequent run() spawns another fresh worker.
  await executor.run({ label: 'segmentation' });
  assert.equal(workers.length, 3);

  // 5. A fatal worker message (such as installWorkerRouter unhandledrejection) discards the worker so retry starts fresh.
  executor.handleMessage({ type: 'error', message: 'Out of memory', fatal: true });
  assert.equal(workers[2].terminated, true);
  assert.equal(executor.isReady(), false);
  await executor.run({ label: 'segmentation' });
  assert.equal(workers.length, 4);
  assert.equal(executor.isReady(), true);
});

test('synchronous postMessage throws and init timeouts clear the failed session so retry spawns a fresh worker', async () => {
  const workers = [];
  let mode = 'sync-throw';
  const executor = new PipelineExecutor({
    initTimeoutMs: 25,
    createWorker: () => {
      const currentMode = mode;
      const worker = {
        terminated: false,
        postMessage(message) {
          if (message.type === 'init') {
            if (currentMode === 'sync-throw') throw new RangeError('Out of memory');
            if (currentMode === 'ready') queueMicrotask(() => worker.onmessage({ data: { type: 'initialized' } }));
          }
        },
        terminate() { this.terminated = true; },
      };
      workers.push(worker);
      return worker;
    },
  });

  await assert.rejects(executor.initialize(), { name: 'RangeError', message: /Out of memory/ });
  assert.equal(workers[0].terminated, true);
  assert.equal(executor.isReady(), false);

  mode = 'hang';
  await assert.rejects(executor.initialize(), /Worker initialization timed out/);
  assert.equal(workers[1].terminated, true);
  assert.equal(executor.isReady(), false);

  mode = 'ready';
  await executor.initialize();
  assert.equal(workers.length, 3);
  assert.equal(executor.isReady(), true);
});
