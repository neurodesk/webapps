import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { ALERT_MARKER } from '../scripts/lib/notarization-alert.mjs';
import {
  CUTOVER, LOOKBACK_MS, REPORTER_WORKFLOW, listCreated, reportWorkflowRuns, runTick, workflowFacts,
} from '../scripts/lib/workflow-reports.mjs';

const workflows = new URL('../.github/workflows/', import.meta.url);
const repository = 'owner/repo';
// Hours after 20 Nov 2026 00:00 UTC, after the cutover.
const at = hours => new Date(Date.UTC(2026, 10, 20) + hours * 3600e3).toISOString();
const AGREEMENT = 'Error: HTTP status code: 403. A required agreement is missing or has expired.';
const SYNCRO = '.github/workflows/syncro-native.yml';
const LINKS = '.github/workflows/standalone-links.yml';

function attempt(overrides = {}) {
  return {
    id: 100, run_attempt: 1, workflow_id: 7, name: 'standalone-links', path: LINKS, event: 'schedule', status: 'completed', conclusion: 'failure',
    head_branch: 'main', head_sha: 'a'.repeat(40), head_repository: { full_name: repository },
    created_at: at(2), run_started_at: at(2), updated_at: at(3), ...overrides,
  };
}

// A stateful fake of the runs, attempts, jobs, logs and issues API. `runs` holds every attempt;
// the listings return each run's highest attempt, as GitHub does, and a workflow's listing every
// run of its file from any ref (`listed_under` names that file when a rename separates it from the path). `jobs` and `logs` are keyed by
// "run:attempt" and job id; a run without jobs has one failed job.
function github({ runs = [], jobs = {}, logs = {} } = {}) {
  const issues = [];
  const comments = new Map();
  const writes = [];
  const reads = [];
  let next = 1;
  const bot = { login: 'github-actions[bot]' };
  const latest = () => [...Object.values(Object.groupBy(runs, run => run.id))].map(each => each.reduce((a, b) => (a.run_attempt > b.run_attempt ? a : b)));
  return {
    runs, issues, comments, writes, reads,
    async list(path) {
      reads.push(path);
      if (path.startsWith('/issues?')) return [...issues].reverse();
      const comment = path.match(/^\/issues\/(\d+)\/comments(?:\?|$)/);
      if (comment) return comments.get(Number(comment[1])) ?? [];
      const job = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
      if (job) return jobs[`${job[1]}:${job[2]}`] ?? [{ id: Number(job[1]) * 10 + Number(job[2]), name: 'check', conclusion: 'failure', steps: [] }];
      if (path.endsWith('/artifacts')) return [];
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, options = {}) {
      if (options.logs) return { text: logs[path.match(/jobs\/(\d+)/)[1]] ?? 'error: failed', truncated: false };
      if ((options.method ?? 'GET') === 'GET') reads.push(path);
      const listing = path.match(/^\/actions\/(?:workflows\/([^/]+)\/)?runs\?(.*)$/);
      if (listing) {
        const query = new URLSearchParams(listing[2]);
        const [from, to] = query.get('created').split('..').map(Date.parse);
        const matching = latest()
          .filter(run => !listing[1] || (run.listed_under ?? run.path.replace(/@.*$/, '')) === `.github/workflows/${decodeURIComponent(listing[1])}`)
          .filter(run => !query.get('event') || run.event === query.get('event'))
          .filter(run => !query.get('branch') || run.head_branch === query.get('branch'))
          // A status filter matches the latest attempt's conclusion, as GitHub's does.
          .filter(run => !query.get('status') || run.conclusion === query.get('status'))
          .filter(run => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= to)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const page = Number(query.get('page'));
        return { total_count: matching.length, workflow_runs: matching.slice(0, 1000).slice((page - 1) * 100, page * 100) };
      }
      const earlier = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
      if (earlier) return runs.find(run => run.id === Number(earlier[1]) && run.run_attempt === Number(earlier[2]));
      writes.push({ path, method: options.method, body: options.body });
      if (path === '/issues' && options.method === 'POST') {
        const issue = { number: next++, state: 'open', user: bot, created_at: new Date().toISOString(), ...options.body };
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

const tick = (client, until, options = {}) => runTick({ client, repository, defaultBranch: 'main', workflows, until: new Date(until), cutover: at(0), ...options });
const reported = client => [...client.issues.map(issue => issue.body), ...[...client.comments.values()].flat().map(comment => comment.body)]
  .flatMap(body => [...body.matchAll(/<!-- (nightly|notarization)-run:(\d+):attempt:(\d+) -->/g)].map(([, kind, run, number]) => `${kind} ${run}:${number}`))
  .sort();

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
    if (!/\.ya?ml$/.test(file)) continue;
    const other = YAML.parse(await readFile(new URL(file, workflows), 'utf8'));
    assert.equal(other.on?.workflow_run, undefined, `${file}: a workflow_run trigger starts a run for every completion; read the API on a schedule`);
  }
  for (const file of ['nightly-failures.yml', 'notarization-alert.yml']) {
    await assert.rejects(readFile(new URL(file, workflows)), { code: 'ENOENT' }, `${file} is replaced by ${REPORTER_WORKFLOW}`);
  }
});

test('the notarizing workflows and the workflows with a job that continues on error come from the workflow files', async () => {
  const expected = { notarizing: [], continuesOnError: [] };
  for (const file of (await readdir(workflows)).sort()) {
    if (!/\.ya?ml$/.test(file) || file === REPORTER_WORKFLOW) continue;
    const source = await readFile(new URL(file, workflows), 'utf8');
    const workflow = YAML.parse(source);
    const jobsContinuing = Object.values(workflow.jobs ?? {}).some(job => job['continue-on-error'] !== undefined);
    // A reusable workflow's jobs run inside its callers, which the reports would then have to follow.
    if (workflow.on?.workflow_call) {
      assert.ok(!jobsContinuing, `${file}: a reusable workflow with a job that continues on error makes its callers' passing runs need reading`);
      continue;
    }
    if (jobsContinuing) expected.continuesOnError.push(`.github/workflows/${file}`);
    if (/notar|APPLE_ID|uses: \.\/\.github\/workflows\/node-cli-portable\.yml/i.test(source)) expected.notarizing.push(`.github/workflows/${file}`);
  }
  const facts = await workflowFacts(workflows);
  assert.deepEqual(facts, expected);
  for (const file of ['syncro-native', 'standalone', 'synthseg-portable', 'node-cli']) assert.ok(facts.notarizing.includes(`.github/workflows/${file}.yml`), file);
  for (const file of ['ci', 'node-cli-portable', 'quality', 'workflow-reports']) assert.ok(!facts.notarizing.includes(`.github/workflows/${file}.yml`), file);
  assert.ok(facts.notarizing.length >= 39, 'every workflow the replaced alert listed');
  assert.deepEqual(facts.continuesOnError, ['.github/workflows/ci.yml', '.github/workflows/deploy-pages.yml']);
});

test('a .yaml workflow file counts like a .yml one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-facts-'));
  await writeFile(join(directory, 'release.yaml'), 'on:\n  release:\njobs:\n  build:\n    continue-on-error: true\n    steps:\n      - run: xcrun notarytool submit\n');
  assert.deepEqual(await workflowFacts(pathToFileURL(`${directory}/`)), {
    notarizing: ['.github/workflows/release.yaml'], continuesOnError: ['.github/workflows/release.yaml'],
  });
});

test('a listing larger than the API returns is split until every run is read', async () => {
  const runs = Array.from({ length: 2500 }, (_, index) => attempt({ id: index + 1, created_at: new Date(Date.parse(at(0)) + index * 60e3).toISOString() }));
  const client = github({ runs });
  const listed = await listCreated(client, { event: 'schedule', branch: 'main' }, Date.parse(at(0)), Date.parse(at(48)));
  assert.equal(new Set(listed.map(run => run.id)).size, 2500);
});

test('a listing that fills two adjacent seconds is split per second, and a full second fails visibly', async () => {
  const second = Date.parse(at(0));
  const runs = Array.from({ length: 1001 }, (_, index) => attempt({ id: index + 1, created_at: new Date(second + (index % 2) * 1000).toISOString() }));
  const listed = await listCreated(github({ runs }), { event: 'schedule' }, second, second + 1000);
  assert.equal(new Set(listed.map(run => run.id)).size, 1001);
  const crowded = Array.from({ length: 1001 }, (_, index) => attempt({ id: index + 1, created_at: at(0) }));
  await assert.rejects(listCreated(github({ runs: crowded }), { event: 'schedule' }, second, second + 999), /More than 1000 runs .* were created at 2026-11-20T00:00:00Z/);
});

test('a notarization failure whose rerun passed before the next tick is still alerted', async () => {
  // A release dispatch fails notarization at 03:00 and its rerun passes at 05:00; the tick runs at 06:47.
  const failed = attempt({ id: 500, name: 'syncro-native', path: SYNCRO, event: 'workflow_dispatch', head_branch: 'syncro-v1' });
  const passed = { ...failed, run_attempt: 2, conclusion: 'success', run_started_at: at(4), updated_at: at(5) };
  const client = github({
    runs: [failed, passed],
    jobs: { '500:1': [{ id: 51, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 51: AGREEMENT },
  });
  await tick(client, at(6.8));
  assert.deepEqual(reported(client), ['notarization 500:1']);
  assert.ok(client.issues[0].body.startsWith(ALERT_MARKER));
  assert.ok(client.reads.every(path => !path.includes('/runs/500/attempts/2/')), 'the passing attempt needs no jobs listing');
});

test('a notarization failure is alerted whichever attempt the API qualifies with its ref', async () => {
  // The tag dispatch of the replayed release: attempt 1 fails notarization and attempt 2 passes.
  for (const [first, second] of [[SYNCRO, `${SYNCRO}@syncro-v1`], [`${SYNCRO}@syncro-v1`, SYNCRO]]) {
    const failed = attempt({ id: 500, name: 'syncro-native', path: first, event: 'workflow_dispatch', head_branch: 'syncro-v1' });
    const passed = { ...failed, path: second, run_attempt: 2, conclusion: 'success', run_started_at: at(4), updated_at: at(5) };
    const client = github({
      runs: [failed, passed],
      jobs: { '500:1': [{ id: 51, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
      logs: { 51: AGREEMENT },
    });
    await tick(client, at(6.8));
    assert.deepEqual(reported(client), ['notarization 500:1'], `listed as ${second}, attempt 1 as ${first}`);
  }
});

test('a failed notarizing run of an event its current workflow file does not declare is alerted', async () => {
  // syncro-native.yml runs on push and workflow_dispatch today; an older tag declared release.
  const release = attempt({ id: 600, name: 'syncro-native', path: `${SYNCRO}@syncro-v0`, event: 'release', head_branch: 'syncro-v0' });
  const pullRequest = attempt({ id: 601, name: 'syncro-native', path: SYNCRO, event: 'pull_request', head_branch: 'feature' });
  const client = github({
    runs: [release, pullRequest],
    jobs: { '600:1': [{ id: 61, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 61: AGREEMENT },
  });
  const { candidates } = await tick(client, at(7));
  assert.equal(candidates, 1, 'pull request runs are not candidates');
  assert.deepEqual(reported(client), ['notarization 600:1']);
});

test('a notarization failure is alerted when its workflow file was renamed after the run', async () => {
  // The reviewer's replay: syncro-native.yml became syncro-native.yaml, and the new workflow's
  // listing returns the failed run with its historical path.
  const directory = await mkdtemp(join(tmpdir(), 'renamed-'));
  await writeFile(join(directory, 'syncro-native.yaml'), 'name: syncro-native\non:\n  workflow_dispatch:\njobs:\n  build:\n    steps:\n      - run: xcrun notarytool submit\n');
  const failed = attempt({ id: 500, name: 'syncro-native', path: SYNCRO, listed_under: `${SYNCRO.replace(/\.yml$/, '.yaml')}`, event: 'workflow_dispatch', head_branch: 'syncro-v1' });
  const client = github({
    runs: [failed],
    jobs: { '500:1': [{ id: 51, name: 'mac', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 51: AGREEMENT },
  });
  await tick(client, at(7), { workflows: pathToFileURL(`${directory}/`) });
  assert.deepEqual(reported(client), ['notarization 500:1']);
});

test('a rerun that starts while a tick runs leaves the failed attempt reported', async () => {
  // Attempt 1 failed at 05:00. The tick starts at 06:00, the rerun at 06:18, and the tick lists runs at 06:24.
  const first = attempt({ id: 100, updated_at: at(5) });
  const rerun = { ...first, run_attempt: 2, status: 'in_progress', conclusion: null, run_started_at: at(6.3), updated_at: at(6.3) };
  const client = github({ runs: [first, rerun] });
  await tick(client, at(6.4));
  assert.deepEqual(reported(client), ['nightly 100:1']);
  // The rerun fails too: the next tick reports attempt 2 only.
  Object.assign(rerun, { status: 'completed', conclusion: 'failure', updated_at: at(8) });
  await tick(client, at(12.8));
  assert.deepEqual(reported(client), ['nightly 100:1', 'nightly 100:2']);
});

test('the first tick after a long gap reports every failure in the lookback', async () => {
  // A failure in hour 1 and no successful tick until hour 26.
  const early = attempt({ id: 1, created_at: at(0.5), run_started_at: at(0.5), updated_at: at(1) });
  const client = github({ runs: [early] });
  await tick(client, at(26));
  assert.deepEqual(reported(client), ['nightly 1:1']);
  // Thirteen days without a tick: the hour-1 failure is still in the lookback, and a later one is reported too.
  const until = Date.parse(at(13 * 24 + 2));
  client.runs.push(attempt({ id: 2, workflow_id: 8, name: 'standalone', created_at: at(13 * 24), run_started_at: at(13 * 24), updated_at: at(13 * 24 + 1) }));
  // Created before the lookback: not listed, so a rerun of it is not reported (docs/development/ci-audit.md).
  client.runs.push(attempt({ id: 3, workflow_id: 9, created_at: new Date(until - LOOKBACK_MS - 3600e3).toISOString(), run_attempt: 2, updated_at: at(13 * 24 + 1) }));
  const fresh = github({ runs: client.runs });
  await tick(fresh, until);
  assert.deepEqual(reported(fresh), ['nightly 1:1', 'nightly 2:1']);
});

test('a repeated tick writes nothing and runs no report again', async () => {
  const failed = attempt({ id: 1 });
  const notarized = attempt({ id: 2, name: 'syncro-native', path: SYNCRO, event: 'push' });
  const client = github({
    runs: [failed, notarized],
    jobs: { '2:1': [{ id: 21, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 21: AGREEMENT },
  });
  const first = await tick(client, at(7));
  assert.equal(first.results.length, 2);
  const writes = client.writes.length;
  const second = await tick(client, at(7));
  assert.deepEqual(second.results, []);
  assert.deepEqual(second.marked, ['scheduled 1:1', 'notarization 2:1']);
  assert.equal(client.writes.length, writes);
});

test('an issue a person closed after a report stays closed', async () => {
  // Attempt 1 opens the issue and attempt 2 comments on it; then a person closes it.
  const client = github({ runs: [attempt({ id: 1 })] });
  await tick(client, at(7));
  client.runs.push(attempt({ id: 1, run_attempt: 2, run_started_at: at(8), updated_at: at(9) }));
  await tick(client, at(10));
  assert.deepEqual(reported(client), ['nightly 1:1', 'nightly 1:2']);
  Object.assign(client.issues[0], { state: 'closed', closed_at: new Date(Date.now() + 1000).toISOString() });
  const writes = client.writes.length;
  await tick(client, at(13));
  assert.equal(client.writes.length, writes);
  assert.equal(client.issues[0].state, 'closed');
  // A new failed attempt reopens it.
  client.runs.push(attempt({ id: 1, run_attempt: 3, run_started_at: at(14), updated_at: at(15) }));
  await tick(client, at(19));
  assert.equal(client.issues[0].state, 'open');
});

test('the cutover compares when an attempt completed, not when its run started', async () => {
  const cutover = Date.parse(CUTOVER);
  const hours = value => new Date(cutover + value * 3600e3).toISOString();
  // Run 1 completed a second before the cutover. Run 2 started two hours before it and completed at it.
  // Run 3's attempt 1 completed before the cutover and its rerun after it.
  const before = attempt({ id: 1, created_at: hours(-2), run_started_at: hours(-2), updated_at: new Date(cutover - 1000).toISOString() });
  const across = attempt({ id: 2, workflow_id: 8, name: 'standalone', created_at: hours(-2), run_started_at: hours(-2), updated_at: CUTOVER });
  const rerunBefore = attempt({ id: 3, workflow_id: 9, name: 'ci-usage', created_at: hours(-3), run_started_at: hours(-3), updated_at: hours(-1) });
  const rerunAfter = { ...rerunBefore, run_attempt: 2, run_started_at: hours(-0.5), updated_at: hours(0.5) };
  const client = github({ runs: [before, across, rerunBefore, rerunAfter] });
  await runTick({ client, repository, defaultBranch: 'main', workflows, until: new Date(cutover + 3600e3) });
  assert.deepEqual(reported(client), ['nightly 2:1', 'nightly 3:2']);
});

// The handoff (docs/development/ci-audit.md): from the cutover on, the workflow_run reporters marked
// every attempt they reported, so the first tick reports exactly the unmarked ones, whatever happened
// to an old reporter's run. These attempts completed at 12:00 on 18 November, before the cutover the
// previous round chose (13:00) and an hour before the merge could have been.
const HANDOFF = Date.parse('2026-11-18T12:00:00Z');
function handoff() {
  const hours = value => new Date(HANDOFF + value * 3600e3).toISOString();
  const nightly = id => attempt({ id, workflow_id: id, name: `nightly-${id}`, created_at: hours(-0.5), run_started_at: hours(-0.5), updated_at: hours(0) });
  const release = id => attempt({ id, name: 'syncro-native', path: SYNCRO, event: 'workflow_dispatch', head_branch: 'syncro-v1', created_at: hours(-1), run_started_at: hours(-1), updated_at: hours(0) });
  const client = github({
    runs: [nightly(1), release(2)],
    jobs: { '2:1': [{ id: 21, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 21: AGREEMENT },
  });
  const firstTick = () => runTick({ client, repository, defaultBranch: 'main', workflows, until: new Date(HANDOFF + 6 * 3600e3) });
  return { client, hours, firstTick };
}

test('the first tick reports the attempts after the cutover that the replaced reporters never marked', async () => {
  // Their workflow_run runs never started, or broke when the merge removed their scripts.
  assert.ok(Date.parse(CUTOVER) < HANDOFF);
  const { client, firstTick } = handoff();
  await firstTick();
  assert.deepEqual(reported(client), ['nightly 1:1', 'notarization 2:1']);
});

test('the first tick does not report again an attempt the replaced reporters marked', async () => {
  const { client, hours, firstTick } = handoff();
  const bot = { login: 'github-actions[bot]' };
  // What nightly-failures.yml and notarization-alert.yml wrote a minute after the attempts completed.
  client.issues.push(
    { number: 336, state: 'open', user: bot, created_at: hours(0.02), updated_at: hours(0.02), body: '<!-- nightly-workflow:1 -->\n<!-- nightly-run:1:attempt:1 -->\n## Scheduled failure: nightly-1' },
    { number: 340, state: 'open', user: bot, created_at: hours(-48), updated_at: hours(0.02), body: `${ALERT_MARKER}\n<!-- notarization-run:9:attempt:1 -->\nApple refused a notarization.` },
  );
  client.comments.set(340, [{ user: bot, created_at: hours(0.02), body: '<!-- notarization-run:2:attempt:1 -->\nApple refused a notarization.' }]);
  const { results, marked } = await firstTick();
  assert.deepEqual(results, []);
  assert.deepEqual(marked, ['scheduled 1:1', 'notarization 2:1']);
  assert.deepEqual(client.writes, []);
});

test('the reporter reports its own failed scheduled ticks', async () => {
  const client = github({ runs: [attempt({ id: 9, name: 'workflow failure reports', path: `.github/workflows/${REPORTER_WORKFLOW}` })] });
  await tick(client, at(7));
  assert.deepEqual(reported(client), ['nightly 9:1']);
});

test('a passing scheduled attempt is read only when a job of its workflow continues on error', async () => {
  const passed = attempt({ id: 1, conclusion: 'success' });
  const ci = attempt({ id: 2, workflow_id: 9, name: 'ci', path: '.github/workflows/ci.yml', conclusion: 'success' });
  const client = github({
    runs: [passed, ci],
    jobs: { '2:1': [{ id: 21, name: 'example-cache-retention', conclusion: 'failure', steps: [] }] },
  });
  await tick(client, at(7));
  assert.deepEqual(reported(client), ['nightly 2:1']);
  assert.ok(client.reads.every(path => !path.startsWith('/actions/runs/1/')), 'no read of the passing run without such a job');
});

test('a passing ci run with a failed job is reported when the API qualifies its path with a ref', async () => {
  const listed = attempt({ id: 2, workflow_id: 9, name: 'ci', path: '.github/workflows/ci.yml@main', conclusion: 'success', run_attempt: 2, run_started_at: at(4), updated_at: at(5) });
  const earlier = { ...listed, run_attempt: 1, run_started_at: at(2), updated_at: at(3) };
  const client = github({
    runs: [earlier, listed],
    jobs: {
      '2:1': [{ id: 21, name: 'example-cache-retention', conclusion: 'failure', steps: [] }],
      '2:2': [{ id: 22, name: 'example-cache-retention', conclusion: 'failure', steps: [] }],
    },
  });
  await tick(client, at(7));
  assert.deepEqual(reported(client), ['nightly 2:1', 'nightly 2:2']);
});

test('each attempt gets the scheduled report and the notarization alert it qualifies for', async () => {
  const notarizingRuns = new Set([3, 4, 5]);
  const scheduled = attempt({ id: 1 });
  const branch = attempt({ id: 2, head_branch: 'feature' });
  const fork = attempt({ id: 3, head_repository: { full_name: 'fork/repo' } });
  const release = attempt({ id: 4, name: 'syncro-native', path: SYNCRO, event: 'workflow_dispatch', head_branch: 'syncro-v1' });
  const pullRequest = attempt({ id: 5, name: 'syncro-native', path: SYNCRO, event: 'pull_request', head_branch: 'feature' });
  const running = attempt({ id: 6, status: 'in_progress', conclusion: null });
  const client = github({
    jobs: { '4:1': [{ id: 41, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] }] },
    logs: { 41: AGREEMENT },
  });
  const { results } = await reportWorkflowRuns({ attempts: [scheduled, branch, fork, release, pullRequest, running], repository, defaultBranch: 'main', notarizingRuns, cutover: at(0), client });
  assert.deepEqual(results.map(({ kind, run, result }) => [kind, run, Object.keys(result).sort().join()]), [
    ['scheduled', 1, 'created,issue'],
    ['notarization', 4, 'created,issue'],
  ]);
});

test('a report that fails is recorded without stopping the others, and a dry run never writes', async () => {
  const client = github();
  const broken = { ...client, list: async (path) => { if (path.includes('/runs/1/')) throw new Error('GitHub API GET returned 502'); return client.list(path); } };
  const attempts = [attempt({ id: 1 }), attempt({ id: 2, workflow_id: 8, name: 'standalone' })];
  const { results } = await reportWorkflowRuns({ attempts, repository, defaultBranch: 'main', cutover: at(0), client: broken });
  assert.deepEqual(results.map(each => [each.run, each.error ?? Object.keys(each.result).sort().join()]), [[1, 'GitHub API GET returned 502'], [2, 'created,issue']]);

  const dry = github({ runs: [attempt({ id: 1 })] });
  const { results: [preview] } = await tick(dry, at(7), { dryRun: true });
  assert.equal(preview.result.create, true);
  assert.match(preview.result.title, /Scheduled workflow: standalone-links requires attention/);
  assert.deepEqual(dry.writes, []);
});

test('a dry run of the command writes no step summary', async () => {
  // Every API answer is empty: no runs and no issues.
  const stub = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async url => new Response(JSON.stringify(/\\/runs\\?/.test(String(url)) ? { total_count: 0, workflow_runs: [] } : []), { status: 200 });")}`;
  const directory = await mkdtemp(join(tmpdir(), 'workflow-reports-'));
  const run = (summary, ...args) => promisify(execFile)(process.execPath, ['--import', stub, new URL('../scripts/report-workflow-failures.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, GH_TOKEN: 'test', GITHUB_REPOSITORY: repository, DEFAULT_BRANCH: 'main', GITHUB_STEP_SUMMARY: join(directory, summary) },
  });
  const { stdout } = await run('dry.md', '--dry-run');
  assert.match(stdout, /\(dry run\): 0 runs listed/);
  await assert.rejects(stat(join(directory, 'dry.md')), { code: 'ENOENT' });
  await run('tick.md');
  assert.match(await readFile(join(directory, 'tick.md'), 'utf8'), /0 runs listed/);
});
