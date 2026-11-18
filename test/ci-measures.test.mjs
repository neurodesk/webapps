import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import {
  ciPullRequestTier, cancelledMinutes, DEPLOY_WORKFLOW, fixedJobShare, idleRuns, jobRole, measuresMarkdown, mergeToLive,
  minutesByRole, minutesPerMergedPullRequest, READY_ONLY_CI_JOBS, readyToGreen, summarizeMeasures, TARGETS, WORKFLOWS,
} from '../scripts/lib/ci-measures.mjs';
import { LARGE_RUN_JOBS } from '../scripts/lib/ci-usage.mjs';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)).map((file) => ({ file, ...parse(readFileSync(new URL(file, workflowsDir), 'utf8')) }));

// The names the Actions API lists a job under, before its matrix values: its
// `name:` or else its id, and for a reusable workflow call that name, ' / '
// and the name of each job the called workflow runs.
function apiJobNames(workflow, id) {
  const job = workflow.jobs[id];
  const name = job.name ?? id;
  if (!job.uses) return [name];
  const called = workflows.find((each) => job.uses === `./.github/workflows/${each.file}`);
  assert.ok(called, `${workflow.file}: ${id} calls ${job.uses}, a workflow of this repository`);
  return Object.keys(called.jobs).flatMap((calledId) => apiJobNames(called, calledId).map((inner) => `${name} / ${inner}`));
}

test('every workflow and every ci job has a role under the name the API lists it by', () => {
  for (const workflow of workflows) {
    if (Object.keys(workflow.on).every((event) => event === 'workflow_call')) continue;
    assert.ok(Object.hasOwn(WORKFLOWS, workflow.name), `${workflow.file}: name "${workflow.name}" in WORKFLOWS (scripts/lib/ci-measures.mjs)`);
    if (WORKFLOWS[workflow.name] !== 'test') continue;
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job.uses !== './.github/workflows/pr-gate.yml') continue;
      for (const name of apiJobNames(workflow, id)) assert.equal(jobRole(workflow.name, name), 'plan', `${workflow.file}: the gate's job "${name}" plans`);
    }
  }
  const ci = workflows.find((workflow) => workflow.file === 'ci.yml');
  const ciNames = Object.keys(ci.jobs).flatMap((id) => apiJobNames(ci, id));
  assert.deepEqual(ciNames.filter((name) => jobRole('ci', name) === 'unclassified'), [], 'ci.yml jobs missing from CI_JOBS');
  for (const job of READY_ONLY_CI_JOBS) assert.ok(ciNames.includes(job), `${job} is the name of a ci.yml job`);
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

  // A run of an unknown workflow that started no job is listed too.
  const runs = [run({ name: 'quality', id: 1 }), run({ id: 2 }), run({ name: 'constructor', id: 3, conclusion: 'skipped' })];
  const jobs = new Map([[1, [job('lint', 7)]], [2, [job('site-build', 3), job('app-plan', 1)]]]);
  const minutes = minutesByRole(runs, jobs);
  assert.equal(minutes.total, 11);
  assert.equal(minutes.roles.unclassified, 10);
  assert.deepEqual(minutes.unclassified, [{ name: 'quality', minutes: 7 }, { name: 'ci: site-build', minutes: 3 }, { name: 'constructor', minutes: 0 }]);
  const text = measuresMarkdown(summarizeMeasures({ runs, jobs, pullRequests: [], deploys: [] }));
  assert.match(text, /plan 1, .*unclassified 10\./);
  assert.match(text, /- quality: 7 min\n- ci: site-build: 3 min\n- constructor: 0 min/);
});

let nextId = 100;
function run(fields = {}) {
  return { id: nextId++, name: 'ci', event: 'pull_request', conclusion: 'success', head_branch: 'feature', head_sha: 'f'.repeat(40), head_repository: 'neurodesk/webapps', pull_requests: [], created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:30:00Z', ...fields };
}
function job(name, minutes, conclusion = 'success') {
  const started = '2026-11-10T10:00:00Z';
  if (minutes === null) return { name, conclusion, started_at: null, completed_at: null, runner_name: null };
  return { name, conclusion, started_at: started, completed_at: new Date(Date.parse(started) + minutes * 60e3).toISOString(), runner_name: conclusion === 'skipped' ? null : 'GitHub Actions 1' };
}
// GitHub gives a job it cancelled before a runner took it a start time, but no runner.
const unstarted = (name) => ({ name, conclusion: 'cancelled', started_at: '2026-11-10T10:01:00Z', completed_at: '2026-11-10T10:01:00Z', runner_name: null });
const many = (count, name, minutes) => Array.from({ length: count }, () => job(name, minutes));

test('pull request ci runs are draft, ready, whole-catalogue or unknown by the jobs that took a runner', () => {
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('app-tests (a, a)', 2), job('composite-site', 0, 'skipped')]), 'draft');
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('full-plan', 0)]), 'ready');
  // Cancelled while planning: the ready-only jobs were cancelled before any took a runner.
  const markers = READY_ONLY_CI_JOBS.map(unstarted);
  assert.equal(ciPullRequestTier([job('app-plan', 1, 'cancelled'), ...markers], 'cancelled'), 'unknown');
  // Cancelled after the plan skipped them: a draft run.
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('workspace-contracts', 5, 'cancelled'), job('composite-site', 0, 'skipped')], 'cancelled'), 'draft');
  // Cancelled before the site job the plan selected took a runner: its plan does not show.
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('full-plan', 0, 'skipped'), unstarted('composite-site')], 'cancelled'), 'unknown');
  // Cancelled after the site job took a runner: a ready run.
  assert.equal(ciPullRequestTier([job('app-plan', 1), job('composite-site', 4, 'cancelled'), unstarted('full-plan')], 'cancelled'), 'ready');
  assert.equal(ciPullRequestTier(many(LARGE_RUN_JOBS, 'browser-e2e (x)', 1)), 'whole');
  assert.equal(ciPullRequestTier([...many(LARGE_RUN_JOBS - 1, 'browser-e2e (x)', 1), job('app-tests', 0, 'skipped')]), 'draft');
});

test('the fixed-job share counts plan and fixed jobs of pull request ci runs, per tier', () => {
  const draft = run();
  const ready = run();
  const cancelled = run({ conclusion: 'cancelled' });
  const push = run({ event: 'push', head_branch: 'main' });
  const jobs = new Map([
    [draft.id, [job('app-plan', 1), job('workspace-contracts', 10), job('homepage-easter-egg', 4), job('app-tests (a, a)', 5)]],
    [ready.id, [job('app-plan', 1), job('full-plan', 0), job('workspace-contracts', 10), job('composite-site', 30), job('browser-e2e (a, a, 1/1)', 19)]],
    [cancelled.id, [job('app-plan', 1, 'cancelled'), job('workspace-contracts', 2, 'cancelled'), ...READY_ONLY_CI_JOBS.map(unstarted)]],
    [push.id, [job('workspace-contracts', 10)]],
  ]);
  const share = fixedJobShare([draft, ready, cancelled, push], jobs);
  assert.deepEqual(share.draft, { runs: 1, minutes: 20, fixedMinutes: 15, share: 0.75 });
  assert.deepEqual(share.ready, { runs: 1, minutes: 60, fixedMinutes: 11, share: 11 / 60 });
  assert.deepEqual(share.unknown, { runs: 1, minutes: 3, fixedMinutes: 3, share: 1 });
  assert.deepEqual(share.all, { runs: 3, minutes: 83, fixedMinutes: 29, share: 29 / 83 });
  assert.equal(share.whole.share, null);
  assert.match(measuresMarkdown(summarizeMeasures({ runs: [cancelled], jobs, pullRequests: [], deploys: [] })), /\| Cancelled pull request ci runs of unknown tier \| 1 runs, 3 min: /);
});

test('ready to green times the green ready runs from the start of their latest attempt to completion', () => {
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
  // A re-run 21 hours after the run was created counts from the re-run.
  const rerun = run({ run_started_at: at(21 * 60), updated_at: at(21 * 60 + 30) });
  assert.equal(readyToGreen([rerun], new Map([[rerun.id, [job('composite-site', 1)]]])).ready.median, 30);
});

test('a push is live when a deploy of it or of a later commit succeeds', () => {
  const push = (sha, created_at) => run({ name: 'ci', event: 'push', head_branch: 'main', head_sha: sha, created_at });
  const deploy = (sha, created_at, updated_at, conclusion = 'success') => run({ name: DEPLOY_WORKFLOW.name, event: 'push', head_branch: 'main', head_sha: sha, created_at, updated_at, conclusion });
  const runs = [push('a', '2026-11-10T10:00:00Z'), run({ name: 'samsrf-native', event: 'push', head_branch: 'main', head_sha: 'a', created_at: '2026-11-10T10:00:05Z' }), push('b', '2026-11-10T10:05:00Z'), push('c', '2026-11-10T12:00:00Z'), push('d', '2026-11-10T23:50:00Z'), push('e', '2026-11-10T23:55:00Z')];
  const deploys = [
    deploy('a', '2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', 'cancelled'),
    deploy('b', '2026-11-10T10:05:00Z', '2026-11-10T10:25:00Z'),
    deploy('c', '2026-11-10T12:00:00Z', '2026-11-10T12:40:00Z'),
    // A deploy of a commit pushed after the window covers every push in it.
    deploy('later', '2026-11-11T00:10:00Z', '2026-11-11T00:30:00Z'),
  ];
  assert.deepEqual(mergeToLive(runs, deploys), { count: 5, median: 35, p90: 40, max: 40, pushes: 5, pending: [] });
  assert.deepEqual(mergeToLive(runs, deploys.slice(0, 3)).pending, ['d', 'e']);
});

test('only a deploy on main, of the push or of a commit created after it, puts a push live', () => {
  const pushes = [run({ event: 'push', head_branch: 'main', head_sha: 'a', created_at: '2026-11-10T10:00:00Z' })];
  const deploy = (fields) => run({ name: DEPLOY_WORKFLOW.name, event: 'workflow_dispatch', head_branch: 'main', ...fields });
  // Dispatched from another branch after the window: it deploys that branch, not main.
  assert.deepEqual(mergeToLive(pushes, [deploy({ head_branch: 'feature', head_sha: 'x', created_at: '2026-11-11T00:10:00Z', updated_at: '2026-11-11T00:30:00Z' })]).pending, ['a']);
  // A deploy on main runs main's head when it is created: after the push, it covers it.
  const unnamed = deploy({ head_sha: 'y', created_at: '2026-11-10T10:30:00Z', updated_at: '2026-11-10T10:50:00Z' });
  assert.equal(mergeToLive(pushes, [unnamed]).median, 50);
  assert.deepEqual(mergeToLive([{ ...pushes[0], head_sha: 'b', created_at: '2026-11-10T11:00:00Z' }], [unnamed]).pending, ['b']);
  // Created in the same second as the push, it may have run the commit before it.
  const same = deploy({ head_sha: 'z', created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:20:00Z' });
  assert.deepEqual(mergeToLive(pushes, [same]).pending, ['a']);
});

test('a pull request merged late in the window keeps the push runs its merge commit started after it', () => {
  const pullRequest = { number: 880, repository: 'neurodesk/webapps', branch: 'late', createdAt: '2026-11-10T20:00:00Z', mergedAt: '2026-11-10T23:58:00Z', mergeCommit: 'm'.repeat(40) };
  const inWindow = run({ event: 'push', head_branch: 'main', head_sha: 'm'.repeat(40), created_at: '2026-11-10T23:58:10Z' });
  const late = run({ name: 'ants-native', event: 'push', head_branch: 'main', head_sha: 'm'.repeat(40), created_at: '2026-11-11T00:01:00Z' });
  const jobs = new Map([[inWindow.id, [job('app-tests (a)', 5)]], [late.id, [job('portable / linux-x64', 7)]]]);
  const measures = summarizeMeasures({ runs: [inWindow], lateRuns: [late], jobs, pullRequests: [pullRequest], deploys: [] });
  assert.deepEqual(measures.perMergedPullRequest.largest, [{ number: 880, runs: 2, minutes: 12 }]);
  // The runs after the window count in the next report's totals, not this one's.
  assert.equal(measures.minutes.total, 5);
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
  const measures = summarizeMeasures({ runs: [], jobs: new Map(), pullRequests: [], deploys: [] });
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
    // The fixture leaves out skipped jobs and records a job cancelled before a runner took it as 0 minutes.
    jobs.set(each.id, compact.flatMap(([name, count, minutes, conclusion]) => Array.from({ length: count }, () => (conclusion === 'cancelled' && minutes === 0 ? unstarted(name) : job(name, minutes === null ? null : minutes / count, conclusion)))));
  }
  for (const [name, event, conclusion, kinds, count] of fixture.groups) {
    for (let index = 0; index < count; index += 1) {
      const each = run({ name, event, conclusion, created_at: '2026-11-17T00:00:00Z' });
      runs.push(each);
      jobs.set(each.id, kinds.map((kind) => job(kind, 0)));
    }
  }
  const until = '2026-11-18T11:00:00Z';
  const measures = summarizeMeasures({ runs, jobs, pullRequests: [], deploys: runs.filter((each) => each.name === DEPLOY_WORKFLOW.name), now: until });
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

// The report run through its CLI with a `gh` stub. One whole-catalogue ci
// run of one pull request keeps the window inside every budget; with
// GH_STUB_FAIL=jobs every job listing answers as a secondary rate limit does.
async function reportWith(t, { fail, args = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'ci-usage-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
if (args[0] === 'pr') console.log('[]');
else if (/\\/runs\\/\\d+\\/jobs\\?per_page=1&/.test(path)) console.log(120);
else if (/\\/runs\\/\\d+\\/jobs/.test(path)) {
  if (process.env.GH_STUB_FAIL === 'jobs') { process.stderr.write('gh: You have exceeded a secondary rate limit (HTTP 403)'); process.exit(1); }
  console.log(JSON.stringify({ name: 'composite-site', conclusion: 'success', started_at: '2026-11-18T09:00:00Z', completed_at: '2026-11-18T09:30:00Z', runner_name: 'r' }));
} else if (path.startsWith('repos/neurodesk/webapps/actions/runs?')) {
  console.log(JSON.stringify({ id: 1, name: 'ci', event: 'pull_request', status: 'completed', conclusion: 'success', head_branch: 'feature', head_sha: 'a'.repeat(40), created_at: '2026-11-18T09:00:00Z', run_started_at: '2026-11-18T09:00:00Z', updated_at: '2026-11-18T09:40:00Z', pull_requests: [864], head_repository: 'neurodesk/webapps' }));
} else if (!path.includes('/workflows/deploy-pages.yml/runs?')) { process.stderr.write('unexpected ' + args.join(' ')); process.exit(1); }
`);
  await chmod(join(bin, 'gh'), 0o755);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-usage-report.mjs', import.meta.url)), '--hours', '2', '--until', '2026-11-18T11:00:00Z', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_FAIL: fail ?? '', GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_STEP_SUMMARY: '' },
  });
  return result;
}

test('a refused job listing makes the measures that read jobs unavailable, after the budgets decided the exit code', async (t) => {
  const result = await reportWith(t, { fail: 'jobs' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /### Inside every budget/);
  assert.match(result.stdout, /- #864: aaaaaaaaa \(120 jobs, 40 min, success\)/);
  assert.match(result.stdout, /\| Ready to green, median and 90th percentile \| unavailable: gh: You have exceeded a secondary rate limit \(HTTP 403\) \| - \|/);
  assert.match(result.stdout, /\| Job minutes per merged pull request, median \| unavailable: gh: You have exceeded/);
  assert.match(result.stdout, /Job minutes by role unavailable: gh: You have exceeded/);
  // Merge to live reads no jobs.
  assert.match(result.stdout, /\| Merge to live, median and maximum \| - and - min over 0 of 0 pushes \| - \|/);
});

test('the request cap makes the measures unavailable without a request, and never fails the report', async (t) => {
  const result = await reportWith(t, { fail: 'jobs', args: ['--max-requests', '0'] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /### Inside every budget/);
  for (const row of ['Job minutes per merged pull request, median', 'Fixed-job share of draft pull request ci runs', 'Ready to green, median and 90th percentile', 'Merge to live, median and maximum', 'Job minutes of cancelled runs']) {
    assert.match(result.stdout, new RegExp(`\\| ${row} \\| unavailable: the request cap of 0 was reached \\| - \\|`));
  }
  assert.match(result.stdout, /and 0 for the measures \(cap 0\)/);
});
