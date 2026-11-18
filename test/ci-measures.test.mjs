import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import {
  CI_JOBS, ciPullRequestTier, cancelledMinutes, DEPLOY_WORKFLOW, fixedJobShare, idleRuns, jobRole, measuresMarkdown, mergeToLive,
  minutesByRole, minutesPerMergedPullRequest, READY_ONLY_CI_JOBS, readyToGreen, summarizeMeasures, TARGETS, WORKFLOWS,
} from '../scripts/lib/ci-measures.mjs';
import { LARGE_RUN_JOBS } from '../scripts/lib/ci-usage.mjs';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(workflowsDir).filter((file) => file.endsWith('.yml')).map((file) => ({ file, ...parse(readFileSync(new URL(file, workflowsDir), 'utf8')) }));

test('every workflow and every ci job has a role', () => {
  for (const workflow of workflows) {
    if (Object.keys(workflow.on).every((event) => event === 'workflow_call')) continue;
    assert.ok(Object.hasOwn(WORKFLOWS, workflow.name), `${workflow.file}: name "${workflow.name}" in WORKFLOWS (scripts/lib/ci-measures.mjs)`);
  }
  const ci = workflows.find((workflow) => workflow.file === 'ci.yml');
  assert.deepEqual(Object.keys(ci.jobs).filter((job) => !Object.hasOwn(CI_JOBS, job)), [], 'ci.yml jobs missing from CI_JOBS');
  for (const job of READY_ONLY_CI_JOBS) assert.ok(Object.hasOwn(ci.jobs, job), `${job} is a ci.yml job`);
  assert.equal(workflows.find((workflow) => workflow.file === DEPLOY_WORKFLOW.file).name, DEPLOY_WORKFLOW.name);
  assert.equal(WORKFLOWS[DEPLOY_WORKFLOW.name], 'deliver');
});

test('a job a renamed workflow or ci job ran is unclassified, not dropped', () => {
  assert.equal(jobRole('ci', 'app-tests (calmar, calmar)'), 'app');
  assert.equal(jobRole('ci', 'workspace-contracts'), 'fixed');
  assert.equal(jobRole('ci', 'site-build'), 'unclassified');
  assert.equal(jobRole('ants-native', 'gate / decide'), 'plan');
  assert.equal(jobRole('ants-native', 'portable / linux-x64'), 'test');
  assert.equal(jobRole('quality', 'lint'), 'unclassified');
  assert.equal(jobRole('constructor', 'lint'), 'unclassified');

  const runs = [run({ name: 'quality', id: 1 }), run({ id: 2 })];
  const jobs = new Map([[1, [job('lint', 7)]], [2, [job('site-build', 3), job('app-plan', 1)]]]);
  const minutes = minutesByRole(runs, jobs);
  assert.equal(minutes.total, 11);
  assert.equal(minutes.roles.unclassified, 10);
  assert.deepEqual(minutes.unclassified, [{ name: 'quality', minutes: 7 }, { name: 'ci: site-build', minutes: 3 }]);
  const text = measuresMarkdown(summarizeMeasures({ runs, jobs, pullRequests: [], deploys: [], until: '2026-11-11T00:00:00Z' }));
  assert.match(text, /plan 1, .*unclassified 10\./);
  assert.match(text, /- quality: 7 min\n- ci: site-build: 3 min/);
});

let nextId = 100;
function run(fields = {}) {
  return { id: nextId++, name: 'ci', event: 'pull_request', conclusion: 'success', head_branch: 'feature', head_sha: 'f'.repeat(40), head_repository: 'neurodesk/webapps', pull_requests: [], created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:30:00Z', ...fields };
}
function job(name, minutes, conclusion = 'success') {
  const started = '2026-11-10T10:00:00Z';
  return { name, conclusion, started_at: minutes === null ? null : started, completed_at: minutes === null ? null : new Date(Date.parse(started) + minutes * 60e3).toISOString() };
}
const many = (count, name, minutes) => Array.from({ length: count }, () => job(name, minutes));

test('pull request ci runs are draft, ready or whole-catalogue by the jobs they started', () => {
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('app-tests (a, a)', 2), job('composite-site', 0, 'skipped')]), 'draft');
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('full-plan', 0)]), 'ready');
  // A site job the run cancelled before a runner took it still marks a ready run.
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('composite-site', null, 'cancelled')]), 'ready');
  assert.equal(ciPullRequestTier(many(LARGE_RUN_JOBS, 'browser-e2e (x)', 1)), 'whole');
  assert.equal(ciPullRequestTier([...many(LARGE_RUN_JOBS - 1, 'browser-e2e (x)', 1), job('app-tests', 0, 'skipped')]), 'draft');
});

test('the fixed-job share counts plan and fixed jobs of pull request ci runs, per tier', () => {
  const draft = run();
  const ready = run();
  const push = run({ event: 'push', head_branch: 'main' });
  const jobs = new Map([
    [draft.id, [job('app-plan', 1), job('workspace-contracts', 10), job('homepage-easter-egg', 4), job('app-tests (a, a)', 5)]],
    [ready.id, [job('app-plan', 1), job('full-plan', 0), job('workspace-contracts', 10), job('composite-site', 30), job('browser-e2e (a, a, 1/1)', 19)]],
    [push.id, [job('workspace-contracts', 10)]],
  ]);
  const share = fixedJobShare([draft, ready, push], jobs);
  assert.deepEqual(share.draft, { runs: 1, minutes: 20, fixedMinutes: 15, share: 0.75 });
  assert.deepEqual(share.ready, { runs: 1, minutes: 60, fixedMinutes: 11, share: 11 / 60 });
  assert.deepEqual(share.all, { runs: 2, minutes: 80, fixedMinutes: 26, share: 26 / 80 });
  assert.equal(share.whole.share, null);
});

test('ready to green times the green ready runs from creation to completion', () => {
  const at = (minutes) => new Date(Date.parse('2026-11-10T10:00:00Z') + minutes * 60e3).toISOString();
  const runs = [10, 30, 40].map((minutes) => run({ updated_at: at(minutes) }));
  const failed = run({ conclusion: 'failure', updated_at: at(5) });
  const draft = run({ updated_at: at(2) });
  const whole = run({ updated_at: at(60) });
  const jobs = new Map([...runs, failed].map((each) => [each.id, [job('composite-site', 1)]]));
  jobs.set(draft.id, [job('app-plan', 1)]);
  jobs.set(whole.id, many(LARGE_RUN_JOBS, 'app-tests (x)', 1));
  const green = readyToGreen([...runs, failed, draft, whole], jobs);
  assert.deepEqual(green.ready, { count: 3, median: 30, p90: 40, max: 40 });
  assert.deepEqual(green.whole, { count: 1, median: 60, p90: 60, max: 60 });
});

test('a push is live when a deploy of it or of a later commit succeeds', () => {
  const push = (sha, created_at) => run({ name: 'ci', event: 'push', head_branch: 'main', head_sha: sha, created_at });
  const deploy = (sha, created_at, updated_at, conclusion = 'success') => run({ name: DEPLOY_WORKFLOW.name, event: 'push', head_branch: 'main', head_sha: sha, created_at, updated_at, conclusion });
  const until = '2026-11-11T00:00:00Z';
  const runs = [push('a', '2026-11-10T10:00:00Z'), run({ name: 'samsrf-native', event: 'push', head_branch: 'main', head_sha: 'a', created_at: '2026-11-10T10:00:05Z' }), push('b', '2026-11-10T10:05:00Z'), push('c', '2026-11-10T12:00:00Z'), push('d', '2026-11-10T23:50:00Z'), push('e', '2026-11-10T23:55:00Z')];
  const deploys = [
    deploy('a', '2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', 'cancelled'),
    deploy('b', '2026-11-10T10:05:00Z', '2026-11-10T10:25:00Z'),
    // A scheduled deploy of a commit pushed before the window covers none of it.
    deploy('old', '2026-11-10T11:00:00Z', '2026-11-10T11:10:00Z'),
    deploy('c', '2026-11-10T12:00:00Z', '2026-11-10T12:40:00Z'),
    // A deploy of a commit pushed after the window covers every push in it.
    deploy('later', '2026-11-11T00:10:00Z', '2026-11-11T00:30:00Z'),
  ];
  assert.deepEqual(mergeToLive(runs, deploys, until), { count: 5, median: 35, p90: 40, max: 40, pushes: 5, pending: [] });
  assert.deepEqual(mergeToLive(runs, deploys.slice(0, 4), until).pending, ['d', 'e']);
});

test('a merged pull request costs every run on its branch from opening to merge and its merge commit\'s push runs', () => {
  const pullRequest = { number: 864, repository: 'neurodesk/webapps', branch: 'ci/audit', createdAt: '2026-11-09T08:00:00Z', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: 'm'.repeat(40) };
  const other = { ...pullRequest, number: 872, branch: 'site/link', mergeCommit: 'n'.repeat(40) };
  const mine = [
    run({ head_branch: 'ci/audit', pull_requests: [864], created_at: '2026-11-09T09:00:00Z' }),
    // GitHub empties the list on a merged pull request's runs; the branch still ties them to it.
    run({ name: 'ants-native', head_branch: 'ci/audit', created_at: '2026-11-10T11:00:00Z' }),
    run({ event: 'push', head_branch: 'main', head_sha: 'm'.repeat(40), created_at: '2026-11-10T12:00:05Z' }),
    run({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-864-0123abc', created_at: '2026-11-10T11:50:00Z' }),
  ];
  const notMine = [
    run({ head_branch: 'ci/audit', head_repository: 'ada/webapps', created_at: '2026-11-10T09:00:00Z' }),
    run({ head_branch: 'ci/audit', pull_requests: [870], created_at: '2026-11-10T09:00:00Z' }),
    run({ head_branch: 'ci/audit', created_at: '2026-11-08T09:00:00Z' }),
    run({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-8640-0123abc', created_at: '2026-11-10T11:50:00Z' }),
    run({ head_branch: 'site/link', created_at: '2026-11-10T09:00:00Z' }),
  ];
  const jobs = new Map([...mine, ...notMine].map((each, index) => [each.id, [job('app-tests (a, a)', 10 + index)]]));
  const result = minutesPerMergedPullRequest([pullRequest, other], [...mine, ...notMine], jobs);
  assert.deepEqual(result.largest, [{ number: 864, runs: 4, minutes: 10 + 11 + 12 + 13 }, { number: 872, runs: 1, minutes: 18 }]);
  assert.equal(result.median, 18);
  assert.equal(minutesPerMergedPullRequest([], [], jobs).median, null);
});

test('runs that tested nothing are skipped, jobless, report-only or plan-only', () => {
  const runs = [
    run({ conclusion: 'skipped' }),
    run({ name: 'ants-native' }),
    run({ name: 'scheduled workflow failure reports', event: 'schedule' }),
    run({ name: 'ants-native' }),
    run({}),
    run({ name: DEPLOY_WORKFLOW.name, event: 'push' }),
    run({ name: 'quality' }),
  ];
  const jobs = new Map([
    // Cancelled before a runner took its only job.
    [runs[1].id, [job('portable / linux-x64', null, 'cancelled')]],
    [runs[2].id, [job('report', 1)]],
    [runs[3].id, [job('gate / decide', 1), job('portable / linux-x64', 0, 'skipped')]],
    [runs[4].id, [job('app-plan', 1), job('workspace-contracts', 9)]],
    [runs[5].id, [job('deploy', 2)]],
    [runs[6].id, [job('lint', 2)]],
  ]);
  assert.deepEqual(idleRuns(runs, jobs), { runs: 7, idle: 4, share: 4 / 7, reasons: { skipped: 1, 'no job': 1, 'report only': 1, 'plan or gate only': 1 } });
});

test('cancelled runs keep the job minutes they used', () => {
  const runs = [run({ conclusion: 'cancelled' }), run({ name: 'ants-native', conclusion: 'cancelled' }), run({})];
  const jobs = new Map([[runs[0].id, [job('app-tests (a)', 6), job('browser-e2e (a)', null, 'cancelled')]], [runs[1].id, [job('gate / decide', 1)]], [runs[2].id, [job('app-tests (a)', 50)]]]);
  assert.deepEqual(cancelledMinutes(runs, jobs), { runs: 2, minutes: 7, pullRequestCiMinutes: 6 });
  // A job still running when the report is made counts up to then.
  assert.equal(cancelledMinutes([runs[0]], new Map([[runs[0].id, [{ ...job('app-tests (a)', 0), completed_at: null }]]]), '2026-11-10T10:12:00Z').minutes, 12);
});

test('the report compares the targets without failing on them', () => {
  const measures = summarizeMeasures({ runs: [], jobs: new Map(), pullRequests: [], deploys: [], until: '2026-11-11T00:00:00Z' });
  const empty = measuresMarkdown(measures);
  assert.match(empty, /target under 30%, no runs/);
  assert.match(empty, /target under 20 min, no runs/);
  const met = measuresMarkdown({ ...measures, fixedShare: { ...measures.fixedShare, draft: { runs: 4, minutes: 100, fixedMinutes: 20, share: 0.2 } }, readyToGreen: { ...measures.readyToGreen, ready: { count: 3, median: 25, p90: 30, max: 31 } } });
  assert.match(met, /\| 20% \(20 of 100 min, 4 runs\) \| meets the target under 30% \|/);
  assert.match(met, /\| 25 and 30 min over 3 runs \| misses the target under 20 min \|/);
  assert.deepEqual(TARGETS, { readyToGreenMedianMinutes: 20, draftFixedShare: 0.3 });
});

// The 48 hours the CI analysis measured by hand (16 Nov 11:00 to 18 Nov 11:00 UTC 2026),
// cut to the runs the timed measures read and the counted shape of the rest.
test('the measures reproduce the hand-computed numbers of the measured window', () => {
  const fixture = JSON.parse(readFileSync(new URL('fixtures/ci-usage-2026-11-18.json', import.meta.url), 'utf8'));
  const runs = [];
  const jobs = new Map();
  for (const { jobs: compact, ...fields } of fixture.runs) {
    const each = run(fields);
    runs.push(each);
    jobs.set(each.id, compact.flatMap(([name, count, minutes, conclusion]) => Array.from({ length: count }, () => job(name, minutes === null ? null : minutes / count, conclusion))));
  }
  for (const [name, event, conclusion, kinds, count] of fixture.groups) {
    for (let index = 0; index < count; index += 1) {
      const each = run({ name, event, conclusion, created_at: '2026-11-17T00:00:00Z' });
      runs.push(each);
      jobs.set(each.id, kinds.map((kind) => job(kind, 0)));
    }
  }
  const until = '2026-11-18T11:00:00Z';
  const measures = summarizeMeasures({ runs, jobs, pullRequests: [], deploys: runs.filter((each) => each.name === DEPLOY_WORKFLOW.name), until, now: until });
  assert.equal(runs.length, 1256);
  assert.equal(measures.minutes.unclassified.length, 0);
  // 1,015 of 1,743 draft minutes (58%); the runs the analysis set apart as empty add 2 minutes here.
  assert.equal(measures.fixedShare.draft.fixedMinutes, 1015);
  assert.ok(Math.abs(measures.fixedShare.draft.share - 0.58) <= 0.01, `draft fixed share ${measures.fixedShare.draft.share}`);
  // 34 minutes for one-app ready runs, within a minute: the analysis timed from the run's start.
  assert.ok(Math.abs(measures.readyToGreen.ready.median - 34) <= 1, `ready to green ${measures.readyToGreen.ready.median}`);
  assert.deepEqual([measures.mergeToLive.median, measures.mergeToLive.max, measures.mergeToLive.pushes], [20, 65, 12]);
  assert.deepEqual([measures.cancelled.runs, measures.cancelled.minutes], [31, 640]);
  // About 690 runs tested nothing in the analysis, which left out the 50 scheduled
  // reports (CI approval report 48, ci-usage 2) that this counts as report-only.
  assert.equal(measures.idle.idle, 694 + 50);
  assert.deepEqual(measures.idle.reasons, { skipped: 306, 'no job': 9, 'report only': 235, 'plan or gate only': 194 });
});
