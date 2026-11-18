import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { ALERT_MARKER } from '../scripts/lib/notarization-alert.mjs';
import {
  FIRST_TICK_MS, LISTING_MARGIN_MS, REPORTER_WORKFLOW, notarizingWorkflowPaths, reportWorkflowRuns, reporterStarts, runFilters, unseenAttempts,
} from '../scripts/lib/workflow-reports.mjs';

const workflows = new URL('../.github/workflows/', import.meta.url);
const repository = 'owner/repo';
const at = hour => new Date(Date.UTC(2026, 10, 17, hour)).toISOString();
const ms = hour => Date.parse(at(hour));
const AGREEMENT = 'Error: HTTP status code: 403. A required agreement is missing or has expired.';

function attempt(overrides = {}) {
  return {
    id: 100, run_attempt: 1, workflow_id: 7, name: 'ci', path: '.github/workflows/ci.yml', event: 'schedule', status: 'completed', conclusion: 'failure',
    head_branch: 'main', head_sha: 'a'.repeat(40), head_repository: { full_name: repository },
    created_at: at(2), run_started_at: at(2), updated_at: at(3), ...overrides,
  };
}

// The attempts endpoint, from a map of "run:attempt" to the attempt as GitHub returned it.
function attemptsClient(earlier = {}) {
  const calls = [];
  return {
    calls,
    async request(path) {
      calls.push(path);
      const [, id, number] = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
      return earlier[`${id}:${number}`];
    },
  };
}

// A stateful fake of the issues, jobs, logs and artifacts API both reports use.
function github({ jobs = {}, logs = {} } = {}) {
  const issues = [];
  const comments = new Map();
  const writes = [];
  let next = 1;
  const bot = { login: 'github-actions[bot]' };
  return {
    issues, comments, writes,
    async list(path) {
      if (path.startsWith('/issues?')) return [...issues].reverse();
      const comment = path.match(/^\/issues\/(\d+)\/comments$/);
      if (comment) return comments.get(Number(comment[1])) ?? [];
      const job = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
      if (job) return jobs[job[1]] ?? [];
      if (path.endsWith('/artifacts')) return [];
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, options = {}) {
      if (options.logs) return { text: logs[path.match(/jobs\/(\d+)/)[1]] ?? 'error: failed', truncated: false };
      writes.push({ path, method: options.method, body: options.body });
      if (path === '/issues' && options.method === 'POST') {
        const issue = { number: next++, state: 'open', user: bot, ...options.body };
        issues.push(issue);
        return issue;
      }
      const comment = path.match(/^\/issues\/(\d+)\/comments$/);
      if (comment && options.method === 'POST') {
        const list = comments.get(Number(comment[1])) ?? [];
        list.push({ user: bot, body: options.body.body, created_at: new Date().toISOString() });
        comments.set(Number(comment[1]), list);
        return {};
      }
      const issue = path.match(/^\/issues\/(\d+)$/);
      if (issue && options.method === 'PATCH') {
        Object.assign(issues.find(each => each.number === Number(issue[1])), options.body);
        return {};
      }
      if (/^\/issues\/\d+\/assignees$/.test(path)) return {};
      throw new Error(`Unexpected request ${options.method ?? 'GET'} ${path}`);
    },
  };
}

test('the reporter runs four times a day from trusted code, and nothing listens to workflow_run', async () => {
  const source = await readFile(new URL(REPORTER_WORKFLOW, workflows), 'utf8');
  const workflow = YAML.parse(source);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule, [{ cron: '47 */6 * * *' }]);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const [checkout, , report] = workflow.jobs.report.steps;
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(report.run, 'node scripts/report-workflow-failures.mjs');
  assert.doesNotMatch(source, /download-artifact|head_sha|continue-on-error/);
  for (const file of await readdir(workflows)) {
    if (!file.endsWith('.yml')) continue;
    const other = YAML.parse(await readFile(new URL(file, workflows), 'utf8'));
    assert.equal(other.on?.workflow_run, undefined, `${file}: a workflow_run trigger starts a run for every completion; read the API on a schedule`);
  }
  for (const file of ['nightly-failures.yml', 'notarization-alert.yml']) {
    await assert.rejects(readFile(new URL(file, workflows)), { code: 'ENOENT' }, `${file} is replaced by ${REPORTER_WORKFLOW}`);
  }
});

test('the notarizing workflows are derived from the workflow files, reusable ones left out', async () => {
  const expected = [];
  for (const file of (await readdir(workflows)).sort()) {
    if (!file.endsWith('.yml') || file === REPORTER_WORKFLOW) continue;
    const source = await readFile(new URL(file, workflows), 'utf8');
    if (YAML.parse(source).on?.workflow_call) continue;
    if (/notar|APPLE_ID|uses: \.\/\.github\/workflows\/node-cli-portable\.yml/i.test(source)) expected.push(`.github/workflows/${file}`);
  }
  const paths = await notarizingWorkflowPaths(workflows);
  assert.deepEqual(paths, expected);
  for (const file of ['syncro-native', 'standalone', 'synthseg-portable', 'node-cli']) assert.ok(paths.includes(`.github/workflows/${file}.yml`), file);
  for (const file of ['ci', 'node-cli-portable', 'quality', 'workflow-reports']) assert.ok(!paths.includes(`.github/workflows/${file}.yml`), file);
  assert.ok(paths.length >= 39, 'every workflow the replaced alert listed');
});

test('ticks count from successful reporter runs only; the first tick checks one day', () => {
  const now = new Date(at(12));
  const starts = reporterStarts([
    { status: 'completed', conclusion: 'success', run_started_at: at(6) },
    { status: 'completed', conclusion: 'failure', run_started_at: at(9) },
    { status: 'in_progress', conclusion: null, run_started_at: at(12) },
  ], { now });
  assert.deepEqual(starts, [ms(6)]);
  assert.deepEqual(reporterStarts([], { now }), [now.getTime() - FIRST_TICK_MS]);
  assert.deepEqual(runFilters('main'), [{ event: 'schedule', branch: 'main' }, { status: 'failure' }, { status: 'timed_out' }]);
});

test('an attempt is checked until a successful tick has listed it as finished and latest', async () => {
  const until = new Date(at(12));
  const earliest = new Date(ms(12) - 7 * 24 * 3600e3);
  const check = (runs, starts, client = attemptsClient()) => unseenAttempts(runs, { client, reporterStarts: starts, until, earliest });
  // Finished after the last successful tick, or before it: only the first is new.
  assert.deepEqual((await check([attempt({ updated_at: at(7) })], [ms(6)])).map(each => each.id), [100]);
  assert.deepEqual(await check([attempt({ updated_at: at(5) })], [ms(6)]), []);
  // The tick at 06:00 failed, so the run that finished at 05:00 is still checked.
  assert.deepEqual((await check([attempt({ updated_at: at(5) })], [ms(0)])).map(each => each.id), [100]);
  // Running, or finished after the end of the replayed window: not yet.
  assert.deepEqual(await check([attempt({ status: 'in_progress', updated_at: at(7) })], [ms(6)]), []);
  assert.deepEqual(await check([attempt({ updated_at: at(13) })], [ms(6)]), []);
});

test('a rerun that replaced a failed attempt between two ticks still has the replaced attempt reported', async () => {
  const until = new Date(at(12));
  const earliest = new Date(ms(12) - 7 * 24 * 3600e3);
  const first = attempt({ run_attempt: 1, run_started_at: at(2), updated_at: at(3) });
  // Attempt 1 finished at 03:00 and was rerun at 04:00, before the 06:00 tick; attempt 2 is still running.
  const running = attempt({ run_attempt: 2, status: 'in_progress', conclusion: null, run_started_at: at(4), updated_at: at(4) });
  const client = attemptsClient({ '100:1': first });
  assert.deepEqual(await unseenAttempts([running], { client, reporterStarts: [ms(0), ms(6)], until, earliest }), [first]);
  assert.deepEqual(client.calls, ['/actions/runs/100/attempts/1']);
  // Rerun after the 06:00 tick listed attempt 1: only the finished rerun is new.
  const rerun = attempt({ run_attempt: 2, conclusion: 'failure', run_started_at: at(8), updated_at: at(9) });
  assert.deepEqual(await unseenAttempts([rerun], { client: attemptsClient({ '100:1': first }), reporterStarts: [ms(6)], until, earliest }), [rerun]);
  // A rerun started while the tick was still listing hid attempt 1 from it.
  const racing = attempt({ run_attempt: 2, run_started_at: new Date(ms(6) + LISTING_MARGIN_MS - 1).toISOString(), updated_at: at(9) });
  assert.deepEqual((await unseenAttempts([racing], { client: attemptsClient({ '100:1': first }), reporterStarts: [ms(6)], until, earliest })).map(each => each.run_attempt), [1, 2]);
  // Replaced before the oldest tick the reporter knows: earlier reporters covered it
  // (standalone run 43551659048, rerun on 14 Nov, two days before the first tick of a replay).
  assert.deepEqual(await unseenAttempts([running], { client: attemptsClient({ '100:1': first }), reporterStarts: [ms(6)], until, earliest }), []);
  // Attempts that started before the lookback are not read.
  const old = attempt({ run_attempt: 3, run_started_at: new Date(earliest.getTime() - 1).toISOString(), updated_at: at(9) });
  const none = attemptsClient();
  assert.deepEqual(await unseenAttempts([old], { client: none, reporterStarts: [ms(6)], until, earliest }), [old]);
  assert.deepEqual(none.calls, []);
});

test('each unseen attempt gets the scheduled report and the notarization alert it qualifies for, once', async () => {
  const notarizing = ['.github/workflows/syncro-native.yml'];
  const scheduled = attempt({ id: 1, name: 'ci' });
  const branch = attempt({ id: 2, head_branch: 'feature' });
  const fork = attempt({ id: 3, head_repository: { full_name: 'fork/repo' } });
  const release = attempt({ id: 4, name: 'syncro-native', path: '.github/workflows/syncro-native.yml', event: 'workflow_dispatch', head_branch: 'syncro-v1' });
  const pullRequest = attempt({ id: 5, name: 'syncro-native', path: '.github/workflows/syncro-native.yml', event: 'pull_request', head_branch: 'feature' });
  const passed = attempt({ id: 6, conclusion: 'success' });
  const client = github({
    jobs: {
      1: [{ id: 11, name: 'browser', conclusion: 'failure', steps: [] }],
      4: [{ id: 41, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }],
      6: [{ id: 61, name: 'browser', conclusion: 'success', steps: [] }],
    },
    logs: { 41: AGREEMENT },
  });
  const attempts = [scheduled, branch, fork, release, pullRequest, passed];
  const options = { attempts, repository, defaultBranch: 'main', notarizing, client };
  const results = await reportWorkflowRuns(options);
  assert.deepEqual(results.map(({ kind, run, result }) => [kind, run, Object.keys(result).sort().join()]), [
    ['scheduled', 1, 'created,issue'],
    ['notarization', 4, 'created,issue'],
    ['scheduled', 6, 'skipped'],
  ]);
  assert.equal(client.issues.length, 2);
  assert.ok(client.issues.some(issue => issue.body.startsWith(ALERT_MARKER)));
  // Rerunning the tick, or the next tick overlapping it, writes nothing.
  const before = client.writes.length;
  const again = await reportWorkflowRuns(options);
  assert.deepEqual(again.filter(each => each.result.duplicate).map(each => each.run), [1, 4]);
  assert.equal(client.writes.length, before);
  // A new attempt of the scheduled run is a comment on the same issue.
  await reportWorkflowRuns({ ...options, attempts: [{ ...scheduled, run_attempt: 2 }] });
  assert.equal(client.issues.length, 2);
  assert.equal(client.comments.get(client.issues[0].number).length, 1);
});

test('a report that fails is recorded without stopping the others, and a dry run never writes', async () => {
  const client = github({ jobs: { 1: [{ id: 11, name: 'browser', conclusion: 'failure', steps: [] }], 2: [{ id: 21, name: 'native', conclusion: 'failure', steps: [] }] } });
  const broken = { ...client, list: async (path) => { if (path.includes('/runs/1/')) throw new Error('GitHub API GET returned 502'); return client.list(path); } };
  const attempts = [attempt({ id: 1 }), attempt({ id: 2, workflow_id: 8, name: 'standalone' })];
  const results = await reportWorkflowRuns({ attempts, repository, defaultBranch: 'main', notarizing: [], client: broken });
  assert.deepEqual(results.map(each => [each.run, each.error ?? Object.keys(each.result).sort().join()]), [[1, 'GitHub API GET returned 502'], [2, 'created,issue']]);

  const dry = github({ jobs: { 1: [{ id: 11, name: 'browser', conclusion: 'failure', steps: [] }] } });
  const [preview] = await reportWorkflowRuns({ attempts: [attempt({ id: 1 })], repository, defaultBranch: 'main', notarizing: [], client: dry, dryRun: true });
  assert.equal(preview.result.create, true);
  assert.match(preview.result.title, /Scheduled workflow: ci requires attention/);
  assert.deepEqual(dry.writes, []);
});
