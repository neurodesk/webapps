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
const GREEDY = '.github/workflows/greedy-native.yml';
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
  const events = new Map();
  const writes = [];
  const reads = [];
  let next = 1;
  const bot = { login: 'github-actions[bot]' };
  const latest = () => [...Object.values(Object.groupBy(runs, run => run.id))].map(each => each.reduce((a, b) => (a.run_attempt > b.run_attempt ? a : b)));
  return {
    runs, issues, comments, events, writes, reads,
    async list(path) {
      reads.push(path);
      if (path.startsWith('/issues?')) return [...issues].reverse();
      const comment = path.match(/^\/issues\/(\d+)\/comments(?:\?|$)/);
      if (comment) return comments.get(Number(comment[1])) ?? [];
      const event = path.match(/^\/issues\/(\d+)\/events(?:\?|$)/);
      if (event) return events.get(Number(event[1])) ?? [];
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
        const number = Number(issue[1]);
        const target = issues.find(each => each.number === number);
        const now = new Date().toISOString();
        const eventList = events.get(number) ?? [];
        if (options.body.state === 'closed' && target.state !== 'closed') {
          eventList.push({ event: 'closed', created_at: now });
          events.set(number, eventList);
        }
        if (options.body.state === 'open' && target.state === 'closed') {
          eventList.push({ event: 'reopened', created_at: now });
          events.set(number, eventList);
        }
        Object.assign(target, options.body);
        if (options.body.state === 'closed' && !options.body.closed_at) target.closed_at = now;
        if (options.body.state === 'open') target.closed_at = null;
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
  const files = (await readdir(workflows)).filter(file => /\.ya?ml$/.test(file) && file !== REPORTER_WORKFLOW).sort();
  const parsed = new Map(await Promise.all(files.map(async file => [file, { source: await readFile(new URL(file, workflows), 'utf8') }])));
  for (const entry of parsed.values()) entry.workflow = YAML.parse(entry.source);
  // A workflow notarizes when it, or a local workflow it calls through any number of calls, mentions notarization.
  const notarizes = (file, seen = []) => {
    const entry = parsed.get(file);
    if (!entry || seen.includes(file)) return false;
    if (/notar|APPLE_ID/i.test(entry.source)) return true;
    return Object.values(entry.workflow.jobs ?? {}).some(job => notarizes(job.uses?.match(/^\.\/\.github\/workflows\/(.+)$/)?.[1], [...seen, file]));
  };
  for (const file of files) {
    const { source, workflow } = parsed.get(file);
    const jobsContinuing = Object.values(workflow.jobs ?? {}).some(job => job['continue-on-error'] !== undefined);
    // A callable workflow's jobs run inside its callers, which the reports would then have to follow.
    if (Object.hasOwn(workflow.on ?? {}, 'workflow_call')) {
      assert.ok(!jobsContinuing, `${file}: a reusable workflow with a job that continues on error makes its callers' passing runs need reading`);
    }
    // One whose only trigger is workflow_call has no runs of its own; one native.yml calls keeps its pushes and dispatches.
    if (Object.keys(workflow.on ?? {}).every(event => event === 'workflow_call')) continue;
    if (jobsContinuing) expected.continuesOnError.push(`.github/workflows/${file}`);
    if (notarizes(file)) expected.notarizing.push(`.github/workflows/${file}`);
  }
  const facts = await workflowFacts(workflows);
  assert.deepEqual(facts, expected);
  // native.yml notarizes nothing itself, but runs native workflows whose macOS jobs can.
  for (const file of ['greedy-native', 'standalone', 'synthseg-portable', 'node-cli', 'bison-native', 'native']) assert.ok(facts.notarizing.includes(`.github/workflows/${file}.yml`), file);
  for (const file of ['ci', 'node-cli-portable', 'quality', 'workflow-reports']) assert.ok(!facts.notarizing.includes(`.github/workflows/${file}.yml`), file);
  assert.ok(facts.notarizing.length >= 39, 'every workflow the replaced alert listed');
  assert.deepEqual(facts.continuesOnError, ['.github/workflows/ci.yml', '.github/workflows/deploy-pages.yml', '.github/workflows/standalone.yml']);
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
  const failed = attempt({ id: 500, name: 'greedy-native', path: GREEDY, event: 'workflow_dispatch', head_branch: 'greedy-v1' });
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

test('a notarization failure inside a workflow native.yml called on schedule is alerted under native', async () => {
  const failed = attempt({ id: 600, name: 'native', path: '.github/workflows/native.yml', event: 'schedule' });
  const client = github({
    runs: [failed],
    jobs: { '600:1': [
      { id: 61, name: 'bison-native / portable / macos-arm64', conclusion: 'failure', labels: ['macos-15'] },
      { id: 62, name: 'bison-native / portable / linux-x64', conclusion: 'success', labels: ['ubuntu-22.04'] },
    ] },
    logs: { 61: AGREEMENT },
  });
  await tick(client, at(6.8));
  assert.deepEqual(reported(client), ['nightly 600:1', 'notarization 600:1']);
  const alert = client.issues.find(issue => issue.body.startsWith(ALERT_MARKER));
  assert.match(alert.body, /bison-native \/ portable \/ macos-arm64/);
});

test('a notarization failure is alerted whichever attempt the API qualifies with its ref', async () => {
  // The tag dispatch of the replayed release: attempt 1 fails notarization and attempt 2 passes.
  for (const [first, second] of [[GREEDY, `${GREEDY}@greedy-v1`], [`${GREEDY}@greedy-v1`, GREEDY]]) {
    const failed = attempt({ id: 500, name: 'greedy-native', path: first, event: 'workflow_dispatch', head_branch: 'greedy-v1' });
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
  // greedy-native.yml runs on push and workflow_dispatch today; an older tag declared release.
  const release = attempt({ id: 600, name: 'greedy-native', path: `${GREEDY}@greedy-v0`, event: 'release', head_branch: 'greedy-v0' });
  const pullRequest = attempt({ id: 601, name: 'greedy-native', path: GREEDY, event: 'pull_request', head_branch: 'feature' });
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
  // The reviewer's replay: greedy-native.yml became greedy-native.yaml, and the new workflow's
  // listing returns the failed run with its historical path.
  const directory = await mkdtemp(join(tmpdir(), 'renamed-'));
  await writeFile(join(directory, 'greedy-native.yaml'), 'name: greedy-native\non:\n  workflow_dispatch:\njobs:\n  build:\n    steps:\n      - run: xcrun notarytool submit\n');
  const failed = attempt({ id: 500, name: 'greedy-native', path: GREEDY, listed_under: `${GREEDY.replace(/\.yml$/, '.yaml')}`, event: 'workflow_dispatch', head_branch: 'greedy-v1' });
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
  const notarized = attempt({ id: 2, name: 'greedy-native', path: GREEDY, event: 'push' });
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
  const release = id => attempt({ id, name: 'greedy-native', path: GREEDY, event: 'workflow_dispatch', head_branch: 'greedy-v1', created_at: hours(-1), run_started_at: hours(-1), updated_at: hours(0) });
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
  const release = attempt({ id: 4, name: 'greedy-native', path: GREEDY, event: 'workflow_dispatch', head_branch: 'greedy-v1' });
  const pullRequest = attempt({ id: 5, name: 'greedy-native', path: GREEDY, event: 'pull_request', head_branch: 'feature' });
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

test('a clean passing scheduled run auto-closes its open workflow issue, stays quiet on repeat ticks, respects manual reopen, and reopens on a later failure', async () => {
  const failed = attempt({ id: 100, workflow_id: 7, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(2), updated_at: at(3) });
  const passed = attempt({ id: 101, workflow_id: 7, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'success', created_at: at(26), run_started_at: at(26), updated_at: at(27) });
  const clientWithPass = github({
    runs: [failed, passed],
    jobs: {
      '100:1': [{ id: 1001, name: 'report', conclusion: 'failure', steps: [] }],
      '101:1': [{ id: 1011, name: 'report', conclusion: 'success', steps: [] }],
    },
  });
  await tick(clientWithPass, at(7));
  assert.equal(clientWithPass.issues[0].state, 'open');
  const recovered = await tick(clientWithPass, at(28));
  assert.equal(clientWithPass.issues[0].state, 'closed');
  assert.equal(clientWithPass.issues[0].state_reason, 'completed');
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.results[0].kind, 'recovery');
  assert.deepEqual(recovered.results[0].result, { issue: 1, closed: true });
  assert.match(clientWithPass.comments.get(1)[0].body, /^<!-- nightly-recovery:101:attempt:1 -->/);

  // Repeated tick writes nothing.
  const writesBefore = clientWithPass.writes.length;
  const repeated = await tick(clientWithPass, at(30));
  assert.equal(clientWithPass.writes.length, writesBefore);
  assert.deepEqual(repeated.results, []);

  // A human manually reopens the issue: the same passing run does not re-close it.
  Object.assign(clientWithPass.issues[0], { state: 'open', closed_at: null });
  const reopenTick = await tick(clientWithPass, at(31));
  assert.equal(clientWithPass.issues[0].state, 'open');
  assert.deepEqual(reopenTick.results, []);
  assert.ok(reopenTick.marked.includes('recovery 101:1'));

  // A later scheduled failure after recovery reopens a closed issue cleanly.
  Object.assign(clientWithPass.issues[0], { state: 'closed', closed_at: new Date().toISOString() });
  clientWithPass.runs.push(attempt({ id: 102, workflow_id: 7, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'failure', created_at: at(50), run_started_at: at(50), updated_at: at(51) }));
  await tick(clientWithPass, at(52));
  assert.equal(clientWithPass.issues[0].state, 'open');
  assert.deepEqual(reported(clientWithPass), ['nightly 100:1', 'nightly 102:1']);
});

test('auto-close handles same-tick rerun recovery and dry-run previews without closing on stale reruns, failed continue-on-error jobs, or errored reports', async () => {
  // Same-tick recovery: attempt 1 fails at 03:00, attempt 2 passes at 05:00, tick runs at 06:47.
  const fail1 = attempt({ id: 200, workflow_id: 11, name: 'standalone-links', created_at: at(2), updated_at: at(3) });
  const pass2 = { ...fail1, run_attempt: 2, conclusion: 'success', run_started_at: at(4), updated_at: at(5) };
  const sameTick = github({
    runs: [fail1, pass2],
    jobs: {
      '200:1': [{ id: 2001, name: 'check', conclusion: 'failure', steps: [] }],
      '200:2': [{ id: 2002, name: 'check', conclusion: 'success', steps: [] }],
    },
  });
  const sameResult = await tick(sameTick, at(6.8));
  assert.deepEqual(reported(sameTick), ['nightly 200:1']);
  assert.equal(sameTick.issues[0].state, 'closed');
  assert.deepEqual(sameResult.results.map(entry => entry.kind), ['scheduled', 'recovery']);

  // Stale rerun passing after a newer run failed MUST NOT close the issue.
  const oldFail = attempt({ id: 300, workflow_id: 12, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(2), updated_at: at(3) });
  const newFail = attempt({ id: 301, workflow_id: 12, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(26), run_started_at: at(26), updated_at: at(27) });
  const oldRerunPass = { ...oldFail, run_attempt: 2, conclusion: 'success', run_started_at: at(28), updated_at: at(29) };
  const stale = github({
    runs: [oldFail, newFail, oldRerunPass],
    jobs: {
      '300:1': [{ id: 3001, name: 'report', conclusion: 'failure', steps: [] }],
      '301:1': [{ id: 3011, name: 'report', conclusion: 'failure', steps: [] }],
      '300:2': [{ id: 3002, name: 'report', conclusion: 'success', steps: [] }],
    },
  });
  await tick(stale, at(30));
  assert.equal(stale.issues[0].state, 'open');

  // Continue-on-error workflow whose passing run still had a failed job stays open.
  const ciFail = attempt({ id: 400, workflow_id: 13, name: 'ci', path: '.github/workflows/ci.yml', conclusion: 'failure', created_at: at(2), updated_at: at(3) });
  const ciSoftFail = attempt({ id: 401, workflow_id: 13, name: 'ci', path: '.github/workflows/ci.yml', conclusion: 'success', created_at: at(26), run_started_at: at(26), updated_at: at(27) });
  const soft = github({
    runs: [ciFail, ciSoftFail],
    jobs: {
      '400:1': [{ id: 4001, name: 'app-tests', conclusion: 'failure', steps: [] }],
      '401:1': [
        { id: 4011, name: 'app-tests', conclusion: 'success', steps: [] },
        { id: 4012, name: 'example-cache-retention', conclusion: 'failure', steps: [] },
      ],
    },
  });
  await tick(soft, at(28));
  assert.equal(soft.issues[0].state, 'open');

  // Dry-run previews closing an existing open issue without writing.
  const dryClient = github({
    runs: [attempt({ id: 501, workflow_id: 14, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'success', created_at: at(26), run_started_at: at(26), updated_at: at(27) })],
    jobs: { '501:1': [{ id: 5011, name: 'report', conclusion: 'success', steps: [] }] },
  });
  dryClient.issues.push({
    number: 810, state: 'open', user: { login: 'github-actions[bot]' }, created_at: at(4),
    body: `<!-- nightly-workflow:14 -->\n<!-- nightly-run:500:attempt:1 -->\n- Updated: ${at(3)}.`,
  });
  const dryTick = await tick(dryClient, at(28), { dryRun: true });
  assert.equal(dryTick.results.length, 1);
  assert.equal(dryTick.results[0].kind, 'recovery');
  assert.equal(dryTick.results[0].result.dryRun, true);
  assert.equal(dryTick.results[0].result.closed, true);
  assert.equal(dryTick.results[0].result.issue, 810);
  assert.equal(dryClient.issues[0].state, 'open');
  assert.deepEqual(dryClient.writes, []);
});

test('auto-close retries an interrupted close, waits when a newer attempt is in progress, and ignores an old rerun across the cutover', async () => {
  // 1. Interrupted close: recovery comment succeeds, PATCH fails on tick 1; tick 2 finishes closing without duplicating the comment.
  const failed = attempt({ id: 600, workflow_id: 21, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(2), updated_at: at(3) });
  const passed = attempt({ id: 601, workflow_id: 21, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'success', created_at: at(26), run_started_at: at(26), updated_at: at(27) });
  const retryBase = github({
    runs: [failed, passed],
    jobs: {
      '600:1': [{ id: 6001, name: 'report', conclusion: 'failure', steps: [] }],
      '601:1': [{ id: 6011, name: 'report', conclusion: 'success', steps: [] }],
    },
  });
  await tick(retryBase, at(7));
  let failPatchOnce = true;
  const flaky = {
    ...retryBase,
    request: async (path, options = {}) => {
      if (failPatchOnce && options.method === 'PATCH' && path === '/issues/1') {
        failPatchOnce = false;
        throw new Error('GitHub API PATCH /issues/1 returned 502');
      }
      return retryBase.request(path, options);
    },
  };
  const firstRecovery = await tick(flaky, at(28));
  assert.equal(firstRecovery.results.length, 1);
  assert.match(firstRecovery.results[0].error, /502/);
  assert.equal(retryBase.issues[0].state, 'open');
  assert.equal(retryBase.comments.get(1).length, 1);
  const secondRecovery = await tick(flaky, at(29));
  assert.equal(retryBase.issues[0].state, 'closed');
  assert.equal(retryBase.comments.get(1).length, 1, 'does not duplicate the recovery comment on retry');
  assert.deepEqual(secondRecovery.results[0].result, { issue: 1, closed: true });

  // 2. Passing attempt 1 must not close the issue while attempt 2 of the same run is in progress.
  const earlierFail = attempt({ id: 700, workflow_id: 22, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(2), updated_at: at(3) });
  const passAttempt1 = attempt({ id: 701, workflow_id: 22, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'success', created_at: at(26), run_started_at: at(26), updated_at: at(27) });
  const runningAttempt2 = { ...passAttempt1, run_attempt: 2, status: 'in_progress', conclusion: null, run_started_at: at(27.5), updated_at: at(28.5) };
  const inProgress = github({
    runs: [earlierFail, passAttempt1, runningAttempt2],
    jobs: {
      '700:1': [{ id: 7001, name: 'report', conclusion: 'failure', steps: [] }],
      '701:1': [{ id: 7011, name: 'report', conclusion: 'success', steps: [] }],
    },
  });
  await tick(inProgress, at(7));
  await tick(inProgress, at(28));
  assert.equal(inProgress.issues[0].state, 'open');

  // 3. Old rerun passing after cutover must not close an issue for a newer failure that happened before cutover.
  const preCutoverOldFail = attempt({ id: 800, workflow_id: 23, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(-48), run_started_at: at(-48), updated_at: at(-47) });
  const preCutoverNewFail = attempt({ id: 801, workflow_id: 23, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(-2), run_started_at: at(-2), updated_at: at(-1) });
  const postCutoverOldRerun = { ...preCutoverOldFail, run_attempt: 2, conclusion: 'success', run_started_at: at(1), updated_at: at(2) };
  const acrossCutover = github({
    runs: [preCutoverOldFail, preCutoverNewFail, postCutoverOldRerun],
    jobs: { '800:2': [{ id: 8002, name: 'report', conclusion: 'success', steps: [] }] },
  });
  acrossCutover.issues.push({
    number: 99, state: 'open', user: { login: 'github-actions[bot]' }, created_at: at(-0.5),
    body: `<!-- nightly-workflow:23 -->\n<!-- nightly-run:801:attempt:1 -->\n- Started: ${at(-2)}. Updated: ${at(-1)}.`,
  });
  await tick(acrossCutover, at(4), { cutover: at(0) });
  assert.equal(acrossCutover.issues[0].state, 'open');

  // 4. A stale successful rerun finishing last must not mask a newer valid recovery run.
  const oldRunFail = attempt({ id: 900, workflow_id: 24, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(1), run_started_at: at(1), updated_at: at(2) });
  const newerFail = attempt({ id: 901, workflow_id: 24, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', created_at: at(25), run_started_at: at(25), updated_at: at(26) });
  const validRecovery = attempt({ id: 902, workflow_id: 24, name: 'ci-usage', path: '.github/workflows/ci-usage.yml', conclusion: 'success', created_at: at(49), run_started_at: at(49), updated_at: at(50) });
  const lateOldRerunPass = { ...oldRunFail, run_attempt: 2, conclusion: 'success', run_started_at: at(51), updated_at: at(52) };
  const unmasked = github({
    runs: [oldRunFail, newerFail, validRecovery, lateOldRerunPass],
    jobs: {
      '900:1': [{ id: 9001, name: 'report', conclusion: 'failure', steps: [] }],
      '901:1': [{ id: 9011, name: 'report', conclusion: 'failure', steps: [] }],
      '902:1': [{ id: 9021, name: 'report', conclusion: 'success', steps: [] }],
      '900:2': [{ id: 9002, name: 'report', conclusion: 'success', steps: [] }],
    },
  });
  await tick(unmasked, at(28));
  assert.equal(unmasked.issues[0].state, 'open');
  const unmaskedResult = await tick(unmasked, at(54));
  assert.equal(unmasked.issues[0].state, 'closed');
  assert.equal(unmaskedResult.results.length, 1);
  assert.equal(unmaskedResult.results[0].run, 902);
});
