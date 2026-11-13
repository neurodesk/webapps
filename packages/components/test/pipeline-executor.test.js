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

test('initialization failure releases the readiness wait', async () => {
  const executor = new PipelineExecutor({ createWorker: () => ({ postMessage() {}, terminate() {} }) });
  const pending = executor.initialize();
  const rejected = assert.rejects(pending, /Worker initialization failed/);
  executor.handleError('failed to initialize');
  await rejected;
});
