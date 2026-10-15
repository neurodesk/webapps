import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, aggregateJobs, classifyRun, jobTiming, osOf, percentile, selectionFromLog, summarizeRun } from '../scripts/lib/ci-minutes.mjs';

const at = (minute, second = 0) => new Date(Date.UTC(2026, 9, 15, 0, minute, second)).toISOString();
const job = (name, labels, created, started, completed, conclusion = 'success') => ({ name, labels, created_at: created, started_at: started, completed_at: completed, conclusion });

test('runner OS comes from the job labels', () => {
  assert.equal(osOf({ labels: ['macos-15'] }), 'macOS');
  assert.equal(osOf({ labels: ['windows-latest'] }), 'Windows');
  assert.equal(osOf({ labels: ['ubuntu-latest'] }), 'Linux');
});

test('queue latency and execution are separate, and minutes round up per job', () => {
  const timing = jobTiming(job('browser-e2e-gpu (syncro, syncro)', ['macos-15'], at(0), at(30), at(32, 1)));
  assert.deepEqual(timing, { name: 'browser-e2e-gpu (syncro, syncro)', group: 'browser-e2e-gpu', os: 'macOS', conclusion: 'success', queueSeconds: 1800, runSeconds: 121, billableMinutes: 3 });
  assert.equal(jobTiming(job('browser-e2e-gpu', ['macos-15'], at(0), at(0), at(0), 'skipped')), null);
  assert.equal(jobTiming(job('composite-site', ['ubuntu-latest'], at(0), null, at(5), 'cancelled')), null);
});

test('the planner summary line classifies a run', () => {
  assert.deepEqual(selectionFromLog('2026-10-15T00:00:00Z Full catalog and site selected: package.json: no rule classifies it\n'), { kind: 'full', reason: 'package.json: no rule classifies it' });
  assert.deepEqual(selectionFromLog('x Selected 3 of 31 apps; site build runs.'), { kind: 'narrowed', selected: 3, total: 31, site: true });
  assert.equal(selectionFromLog('x Selected 0 of 31 apps; site build skipped.').kind, 'no apps');
  assert.equal(selectionFromLog('x Selected 31 of 31 apps; site build runs.').kind, 'full');
  assert.equal(selectionFromLog('no planner output'), null);
});

test('a run is classified only when its planner job succeeded', () => {
  const planJob = { name: 'app-plan', conclusion: 'success' };
  const appJobs = (count) => Array.from({ length: count }, (_, index) => ({ name: `app-tests (app${index}, app${index})` }));
  assert.equal(classifyRun({ planJob, log: 'x Selected 2 of 31 apps; site build runs.', jobs: appJobs(5), catalogSize: 31 }).kind, 'narrowed');
  assert.deepEqual(classifyRun({ planJob, log: '', jobs: appJobs(31), catalogSize: 31 }), { kind: 'full (inferred)', selected: 31 });
  assert.equal(classifyRun({ planJob, log: '', jobs: appJobs(32), catalogSize: 31 }).kind, 'full (inferred)');
  assert.equal(classifyRun({ planJob, log: '', jobs: appJobs(30), catalogSize: 31 }).kind, 'narrowed (inferred)');
  assert.equal(classifyRun({ planJob, log: '', jobs: [], catalogSize: 31 }).kind, 'no apps (inferred)');
  for (const conclusion of ['cancelled', 'failure', null]) {
    assert.equal(classifyRun({ planJob: { ...planJob, conclusion }, log: '', jobs: [], catalogSize: 31 }), null, String(conclusion));
  }
  assert.equal(classifyRun({ planJob: undefined, log: '', jobs: [], catalogSize: 31 }), null);
});

test('a run summary splits minutes and queue by OS and counts per-app jobs', () => {
  const run = { id: 7, event: 'pull_request', conclusion: 'success', created_at: at(0), run_started_at: at(0, 5) };
  const jobs = [
    job('app-plan', ['ubuntu-latest'], at(0), at(0, 10), at(1)),
    job('app-tests (alpha, alpha)', ['ubuntu-latest'], at(1), at(2), at(3, 30)),
    job('browser-e2e (alpha, alpha, 1/2)', ['ubuntu-latest'], at(1), at(1), at(11)),
    job('browser-e2e-gpu (alpha, alpha)', ['macos-15'], at(1), at(41), at(50)),
    job('browser-e2e-gpu (beta)', ['macos-15'], at(1), at(1), at(1), 'skipped'),
  ];
  const summary = summarizeRun(run, jobs, { kind: 'narrowed', selected: 1 });
  assert.deepEqual(summary.minutes, { Linux: 1 + 2 + 10, macOS: 9 });
  assert.deepEqual(summary.queue, { Linux: [10, 60, 0], macOS: [2400] });
  assert.deepEqual(summary.perApp, { app: 1, browser: 1, gpu: 1 });
  assert.equal(summary.runQueueSeconds, 5);
  assert.equal(summary.wallSeconds, 50 * 60);

  const [group] = aggregate([summary, { ...summary, conclusion: 'cancelled' }]);
  assert.equal(group.runs, 2);
  assert.equal(group.finished, 1);
  assert.equal(group.cancelled, 1);
  assert.deepEqual(group.runnerMinutesTotal, { Linux: 26, macOS: 18, Windows: 0 });
  assert.deepEqual(group.runnerMinutesPerFinishedRun.macOS, { median: 9, p90: 9 });
  assert.equal(group.wallMinutes.median, 50);
  assert.equal(group.jobQueueSeconds.macOS.max, 2400);

  const gpu = aggregateJobs([summary]).find((entry) => entry.job === 'browser-e2e-gpu (macOS)');
  assert.deepEqual(gpu, { job: 'browser-e2e-gpu (macOS)', jobs: 1, runMinutes: { median: 9, p90: 9, total: 9 }, queueSeconds: { median: 2400, p90: 2400, max: 2400 } });
});

test('percentiles use the nearest rank', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});
