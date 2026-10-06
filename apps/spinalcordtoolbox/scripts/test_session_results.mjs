#!/usr/bin/env node

// Which loaded image owns which results (web/js/app/session-results.js),
// against the real SctPipeline result storage: a task run on image A must
// survive switching to image B, running there, and switching back.

import assert from 'node:assert/strict';
import {
  MAX_SESSIONS_WITH_RESULTS,
  SessionResultStore,
  restoreSessionResults,
  snapshotSessionResults
} from '../web/js/app/session-results.js';

const { SctPipeline } = await import('../web/js/controllers/SctPipeline.js');

function makeExecutor() {
  return new SctPipeline({ updateOutput: () => {}, onStageData: () => {} });
}

// What the worker posts for a mask and for a metrics table.
function maskStage(executor, stage, taskId, bytes = [1, 2, 3]) {
  executor.handleStageData({ stage, kind: 'nifti', taskId, niftiData: new Uint8Array(bytes).buffer });
}

function metricsStage(executor, stage, rows) {
  executor.handleStageData({ stage, kind: 'metrics', rows, summary: { count: rows.length }, csv: 'a\n1\n', taskId: 'spinalcord', columns: ['a'] });
}

// ---------------------------------------------------------------------------
// The store: park, peek, unpark, and a count bound released oldest first.
// ---------------------------------------------------------------------------
{
  assert.equal(MAX_SESSIONS_WITH_RESULTS, 4);
  const store = new SessionResultStore();
  assert.equal(store.limit, 3, 'the active session holds the fourth set of results');
  assert.deepEqual(store.park('a', { tag: 'a' }), []);
  assert.deepEqual(store.park('b', { tag: 'b' }), []);
  assert.deepEqual(store.park('c', { tag: 'c' }), []);
  assert.deepEqual(store.peek('a'), { tag: 'a' }, 'peek leaves the snapshot parked');
  assert.equal(store.has('a'), true);
  assert.deepEqual(store.park('a', { tag: 'a2' }), [], 're-parking refreshes, it does not grow');
  assert.deepEqual(store.park('d', { tag: 'd' }), ['b'], 'the least recently parked session is released');
  assert.equal(store.size, 3);
  assert.deepEqual(store.unpark('a'), { tag: 'a2' });
  assert.equal(store.has('a'), false, 'unpark hands the results over');
  assert.equal(store.unpark('missing'), null);
  assert.deepEqual(store.park('e', null), [], 'nothing to park is a no-op');
  assert.equal(store.has('e'), false);
  store.retain(['d']);
  assert.deepEqual([...store.parked.keys()], ['d'], 'removed images take their results with them');
  store.drop('d');
  assert.equal(store.size, 0);
  store.park('x', {});
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(new SessionResultStore({ limit: -2 }).limit, 0);
}

// ---------------------------------------------------------------------------
// Snapshots carry masks, metrics stages and their settings, without the
// worker's duplicate transfer buffer.
// ---------------------------------------------------------------------------
{
  const executor = makeExecutor();
  assert.equal(snapshotSessionResults(executor), null, 'an image without results parks nothing');

  maskStage(executor, 'segmentation', 'spinalcord');
  maskStage(executor, 'lesion', 'lesion_sci_t2');
  metricsStage(executor, 'lesion_metrics', [{ label: 1 }]);
  executor.stepStatus.inference = 'complete';
  executor.lastRunSettings = { taskId: 'spinalcord', threshold: 0.5 };

  const snapshot = snapshotSessionResults(executor, { note: 'app state' });
  assert.deepEqual(snapshot.stageOrder, ['segmentation', 'lesion', 'lesion_metrics']);
  assert.equal(snapshot.results.segmentation.file, executor.getResult('segmentation').file, 'parked results keep the same File');
  assert.equal(snapshot.results.segmentation.raw.niftiData, undefined, 'the transfer buffer is not kept twice');
  assert.equal(snapshot.results.segmentation.raw.taskId, 'spinalcord', 'the producing task is kept for colours');
  assert.ok(executor.getResult('segmentation').raw.niftiData, 'the active results are left untouched');
  assert.deepEqual(snapshot.results.lesion_metrics.rows, [{ label: 1 }]);
  assert.deepEqual(snapshot.results.lesion_metrics.raw.columns, ['a']);
  assert.deepEqual(snapshot.stepStatus, { inference: 'complete' });
  assert.deepEqual(snapshot.lastRunSettings, { taskId: 'spinalcord', threshold: 0.5 });
  assert.equal(snapshot.note, 'app state', 'extra app state travels with the snapshot');
}

// ---------------------------------------------------------------------------
// Ownership across a switch: run on A, switch to B and run there, switch back.
// Mirrors SpinalCordToolboxApp.parkSessionResults / restoreSessionResults
// around the executor reset that every activation performs.
// ---------------------------------------------------------------------------
{
  const executor = makeExecutor();
  const store = new SessionResultStore();
  const switchTo = async (from, to) => {
    store.park(from, snapshotSessionResults(executor));
    await executor.resetWorkerState().catch(() => {});
    executor.results = {};
    executor.stageOrder = [];
    const snapshot = store.unpark(to);
    if (snapshot) restoreSessionResults(executor, snapshot);
    return Boolean(snapshot);
  };
  // resetWorkerState posts to a worker; this test needs only its bookkeeping.
  executor.initialize = async () => {};
  executor.postRaw = () => {};

  maskStage(executor, 'segmentation', 'spinalcord', [1]);
  metricsStage(executor, 'lesion_metrics', [{ label: 4 }]);
  executor.stepStatus.inference = 'complete';
  const fileA = executor.getResult('segmentation').file;

  assert.equal(await switchTo('A', 'B'), false, 'B has no results yet');
  assert.deepEqual(executor.getStageOrder(), [], 'B starts empty: A\'s outputs are not shown as B\'s');
  assert.equal(executor.getStepStatus('inference'), 'pending');
  maskStage(executor, 'segmentation', 'graymatter', [2]);
  const fileB = executor.getResult('segmentation').file;
  assert.notEqual(fileA, fileB);
  assert.equal(store.peek('A').results.segmentation.file, fileA, 'running on B leaves A\'s parked results alone');

  assert.equal(await switchTo('B', 'A'), true);
  assert.equal(executor.getResult('segmentation').file, fileA, 'A\'s mask is back: downloads and Results act on it');
  assert.deepEqual(executor.getResult('lesion_metrics').rows, [{ label: 4 }], 'A\'s metrics come back with it');
  assert.equal(executor.getStepStatus('inference'), 'complete');
  assert.equal(executor.getResults().segmentation.raw.taskId, 'spinalcord');
  assert.equal(store.peek('B').results.segmentation.file, fileB, 'B is parked in turn');
  assert.equal(store.peek('B').results.segmentation.raw.taskId, 'graymatter', 'B keeps its own task colours');

  // Restoring replaces, never merges.
  executor.removeResult('lesion_metrics');
  assert.equal(await switchTo('A', 'B'), true);
  assert.equal(executor.hasResult('lesion_metrics'), false, 'B never had lesion metrics');
}

console.log('Session result ownership tests passed');
