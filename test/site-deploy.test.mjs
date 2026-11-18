import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { workerSites } from '../scripts/lib/catalog-sites.mjs';
import {
  ANALYTICS_REFRESH_UTC,
  DIGEST_FILE,
  HISTORY_DAYS,
  HISTORY_MAX_RUNS,
  RERUN_LIMIT_DAYS,
  analyticsStale,
  decideSite,
  deployOutputs,
  deploySites,
  deploySummary,
  forcedReason,
  lastAnalyticsRefresh,
  parseLiveRecord,
  planDeploy,
  planSiteDeploy,
  previousDeploy,
  readDeployHistory,
  readLiveRecord,
  siteDigest,
} from '../scripts/lib/site-deploy.mjs';

const registry = await loadAppsRegistry();

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'site-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const report = (generatedAt, extra = {}) => JSON.stringify({ schemaVersion: 1, generatedAt, unavailable: false, totals: { users: 1 }, ...extra });

async function site(root, files = {}) {
  await put(root, 'index.html', '<!doctype html>');
  await put(root, 'app/index.html', '<!doctype html><title>app</title>');
  await put(root, 'app/assets/model.wasm', Buffer.from([0, 1, 2, 3]));
  await put(root, '.nojekyll', '');
  await put(root, 'analytics.json', report('2026-11-18T01:06:47.596Z'));
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  return root;
}

test('two builds of the same content have one digest, whatever their file times, usage report and digest record', async (t) => {
  const root = await tempDir(t);
  const first = await site(join(root, 'a'));
  const second = await site(join(root, 'b'), {
    'analytics.json': report('2026-11-18T04:24:04.998Z', { totals: { users: 9 } }),
    [DIGEST_FILE]: '{"schema":1}',
  });
  await utimes(join(second, 'index.html'), new Date(0), new Date(0));
  assert.equal(await siteDigest(first), await siteDigest(second));
  assert.match(await siteDigest(first), /^[0-9a-f]{64}$/);
});

test('any change to a file, a path, the file set or the Worker configuration changes the digest', async (t) => {
  const root = await tempDir(t);
  const base = await siteDigest(await site(join(root, 'base')));
  const variants = {
    bytes: async (dir) => put(dir, 'app/assets/model.wasm', Buffer.from([0, 1, 2, 4])),
    added: async (dir) => put(dir, 'app/new.js', ''),
    removed: async (dir) => rm(join(dir, '.nojekyll')),
    renamed: async (dir) => rename(join(dir, 'app/assets/model.wasm'), join(dir, 'app/assets/model2.wasm')),
    // Only the root usage report and digest record are left out: an app's file of the same name counts.
    nested: async (dir) => put(dir, `app/${DIGEST_FILE}`, '{}'),
    nestedReport: async (dir) => put(dir, 'app/analytics.json', '{}'),
    // A file named for a commit, such as calmar's build-info.json, redeploys its site when it changes.
    buildInfo: async (dir) => put(dir, 'app/build-info.json', '{"sha":"fd88968"}'),
  };
  const seen = new Set([base]);
  for (const [name, change] of Object.entries(variants)) {
    const dir = await site(join(root, name));
    await change(dir);
    const digest = await siteDigest(dir);
    assert.ok(!seen.has(digest), `${name} changes the digest`);
    seen.add(digest);
  }
  const dir = join(root, 'base');
  assert.notEqual(await siteDigest(dir, { config: '{"a":1}' }), await siteDigest(dir, { config: '{"a":2}' }));
  assert.notEqual(await siteDigest(dir, { config: '{"a":1}' }), base);
});

test('a path and the content of another file cannot be swapped without changing the digest', async (t) => {
  const root = await tempDir(t);
  const one = join(root, 'one');
  await put(one, 'a', 'x');
  await put(one, 'b', 'y');
  const two = join(root, 'two');
  await put(two, 'a', 'y');
  await put(two, 'b', 'x');
  assert.notEqual(await siteDigest(one), await siteDigest(two));
});

test('the usage report is refreshed once a day, by the first run after the scheduled refresh time', () => {
  assert.deepEqual(lastAnalyticsRefresh('2026-11-18T04:24:00Z').toISOString(), '2026-11-18T04:17:00.000Z');
  assert.deepEqual(lastAnalyticsRefresh('2026-11-18T04:16:59Z').toISOString(), '2026-11-17T04:17:00.000Z');
  assert.deepEqual(lastAnalyticsRefresh('2026-11-01T00:00:00Z').toISOString(), '2026-10-31T04:17:00.000Z');
  // The scheduled run at 04:22 refreshes a report a push published after the previous day's refresh.
  assert.equal(analyticsStale('2026-11-17T12:30:00Z', '2026-11-18T04:24:00Z'), true);
  // A push later that day finds the report the scheduled run published current.
  assert.equal(analyticsStale('2026-11-18T04:24:00Z', '2026-11-18T12:00:00Z'), false);
  assert.equal(analyticsStale('2026-11-18T01:06:00Z', '2026-11-18T04:10:00Z'), false, 'before the refresh time, the night\'s report is current');
  assert.equal(analyticsStale(null, '2026-11-18T04:24:00Z'), true, 'a live report GA4 could not fill is replaced');
  assert.equal(analyticsStale(undefined, '2026-11-18T04:24:00Z'), true);
  assert.equal(analyticsStale('garbage', '2026-11-18T04:24:00Z'), true);
  // 31 November is not 1 December: a live report from a date that does not exist is replaced.
  assert.equal(analyticsStale('2026-11-31T10:00:00Z', '2026-11-18T12:00:00Z'), true);
  assert.equal(analyticsStale('2026-11-01T00:00:00Z', null), false, 'a build without a report never replaces one');
});

test('the refresh time is the deploy workflow\'s daily schedule', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/deploy-pages.yml'), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: `${ANALYTICS_REFRESH_UTC.minute} ${ANALYTICS_REFRESH_UTC.hour} * * *` }]);
});

const digest = 'a'.repeat(64);
const C1 = 'fd08c1c20'.padEnd(40, '0');
const C2 = '77f026063'.padEnd(40, '0');
const record = (fields = {}) => ({ schema: 1, site: 'msk', digest, analyticsGeneratedAt: '2026-11-18T04:24:00Z', commit: C1, ...fields });
// Run histories as readDeployHistory returns them. This run, 100, started at
// NOW; run(id, minutesAgo, conclusion, options) is another run of the workflow
// whose latest attempt started that many minutes earlier and started `jobs` jobs.
const NOW = Date.parse('2026-11-18T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const instant = (time) => new Date(time).toISOString().replace('.000Z', 'Z');
const SINCE = instant(NOW - HISTORY_DAYS * DAY);
const THIS_RUN = { id: 100, run_attempt: 1, status: 'in_progress', conclusion: null, run_started_at: instant(NOW) };
const run = (id, minutesAgo, conclusion = 'success', { attempt = 1, status = 'completed', jobs = 5 } = {}) => ({
  id, run_attempt: attempt, status, conclusion: status === 'completed' ? conclusion : null, run_started_at: instant(NOW - minutesAgo * MINUTE), jobs,
});
const history = (...runs) => ({ runId: 100, attempt: 1, since: SINCE, runs: [THIS_RUN, ...runs] });
// The deploy run before this one finished green.
const green = history(run(99, 30));
const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

test('a site is published when its content changed, its live record is unreadable, its report is stale, or the run was dispatched', () => {
  const analytics = '2026-11-18T12:00:00Z';
  const live = { record: record() };
  assert.deepEqual(decideSite({ digest, analytics, live }), {
    publish: false, verifyBuild: false, reason: 'unchanged: the live site has this content and a current usage report',
  });
  assert.deepEqual(decideSite({ digest: 'b'.repeat(64), analytics, live }), { publish: true, verifyBuild: true, reason: 'content changed' });
  assert.deepEqual(decideSite({ digest, analytics, live: { error: 'HTTP 404' } }), {
    publish: true, verifyBuild: true, reason: 'live digest unreadable (HTTP 404)',
  });
  assert.deepEqual(decideSite({ digest, analytics: '2026-11-19T04:30:00Z', live }), {
    publish: true, verifyBuild: false, reason: 'usage report refresh (live report: 2026-11-18T04:24:00Z)',
  });
  assert.deepEqual(decideSite({ digest, analytics, live, deployAll: true }), { publish: true, verifyBuild: true, reason: 'dispatched run: every site deploys' });
  assert.deepEqual(decideSite({ digest, analytics, live, forced: 'previous deploy run 9 failure' }), {
    publish: true, verifyBuild: true, reason: 'forced: previous deploy run 9 failure',
  });
  // Content outranks the report: a changed site is verified before it is published.
  assert.equal(decideSite({ digest: 'b'.repeat(64), analytics: '2026-11-19T04:30:00Z', live }).verifyBuild, true);
});

test('a served record is trusted only when it is this schema\'s record of this site', () => {
  assert.deepEqual(parseLiveRecord(JSON.stringify(record()), 'msk'), { record: record() });
  assert.deepEqual(parseLiveRecord('<!doctype html>', 'msk'), { error: 'not JSON' });
  assert.deepEqual(parseLiveRecord('null', 'msk'), { error: 'not a JSON object' });
  assert.deepEqual(parseLiveRecord('[]', 'msk'), { error: 'not a JSON object' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record({ schema: 2 })), 'msk'), { error: 'schema 2, expected 1' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record()), 'neuro'), { error: 'it describes site "msk"' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record({ digest: 'abc' })), 'msk'), { error: 'no content digest' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record({ analyticsGeneratedAt: null, commit: null })), 'msk').error, undefined, 'a build without a report or a commit');
});

test('a served record of the wrong shape is unreadable, so its site is published instead of the plan throwing', async (t) => {
  const malformed = {
    digest: { digest: 7 },
    analyticsGeneratedAt: { analyticsGeneratedAt: { at: 1 } },
    analyticsText: { analyticsGeneratedAt: 'yesterday' },
    // Date.parse moves it to 3 March; a usage report from a date that does not exist is not read as current.
    analyticsImpossibleDate: { analyticsGeneratedAt: '2026-02-31T10:00:00Z' },
    analyticsHour24: { analyticsGeneratedAt: '2026-11-17T24:00:00Z' },
    commit: { commit: { sha: 'x' } },
    shortCommit: { commit: 'fd08c1c20' },
  };
  for (const [name, fields] of Object.entries(malformed)) {
    assert.ok(parseLiveRecord(JSON.stringify(record(fields)), 'msk').error, `${name} is refused`);
  }
  // End to end: the hosts serve their records with a commit that is an object.
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, { ...served, commit: { sha: C1 } }]));
  const plan = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async (url) => json(records.get(new URL(url).host)), write: writeFile });
  assert.ok(plan.every(({ publish, reason }) => publish && /^live digest unreadable \(commit is neither/.test(reason)));
  assert.match(deploySummary(plan), /\| msk \| mskapps\.sciget\.org \| publish \|/);
});

test('a site whose plan throws is published, and the other sites are still planned', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  await rm(join(root, 'microscopy.wrangler.json'));
  const plan = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async (url) => json(records.get(new URL(url).host)), write: writeFile });
  const decision = Object.fromEntries(plan.map(({ site: id, publish, reason }) => [id, publish ? reason : 'skip']));
  assert.match(decision.microscopy, /^plan failed \(ENOENT/);
  assert.deepEqual({ ...decision, microscopy: 'plan failed' }, { neuro: 'skip', msk: 'skip', microscopy: 'plan failed', preclinical: 'skip', hub: 'skip' });
  assert.deepEqual(JSON.parse(deployOutputs(plan).workers), [{ site: 'microscopy', url: 'https://microscopyapps.sciget.org/' }]);
  assert.equal(deployOutputs(plan).verify_build, 'true');
  assert.match(deploySummary(plan), /\| microscopy \| microscopyapps\.sciget\.org \| publish \| after publish \| plan failed/);
});

test('reading a live record bypasses caches and turns every failure into a reason to publish', async () => {
  const requests = [];
  const answer = (response) => async (url, init) => {
    requests.push({ url, init });
    return response;
  };
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'mskapps.sciget.org', nonce: '7-1', fetch: answer(json(record())) }), { record: record() });
  assert.equal(requests[0].url, `https://mskapps.sciget.org/${DIGEST_FILE}?run=7-1`);
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.headers['cache-control'], 'no-cache');
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: answer(new Response('Not found', { status: 404 })) }), { error: 'HTTP 404' });
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: async () => { throw new TypeError('fetch failed'); } }), { error: 'fetch failed' });
  // A fetch that never answers; its own timer keeps the event loop alive as a real socket would.
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: hang, timeoutMs: 20 }), { error: 'no complete answer in 0.02 s' });
  // A fetch that ignores its signal still ends at the deadline.
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: () => new Promise(() => setTimeout(() => {}, 100)), timeoutMs: 20 }), { error: 'no complete answer in 0.02 s' });
});

test('only a direct, uncached JSON answer of the host counts as its live record', async () => {
  const read = (response) => readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: async (url, init) => (init.redirect === 'manual' ? response : json(record())) });
  // A redirect to another path that holds an old matching record is not followed.
  assert.deepEqual(await read(new Response('', { status: 302, headers: { location: '/old/site-digest.json' } })), { error: 'HTTP 302' });
  assert.deepEqual(await read(json(record(), { status: 301 })), { error: 'HTTP 301' });
  assert.deepEqual(await read(json(record(), { status: 203 })), { error: 'HTTP 203' });
  // A cached copy, in spite of the fresh query string.
  assert.deepEqual(await read(json(record(), { headers: { age: '3600' } })), { error: 'a cached copy (Age: 3600)' });
  assert.deepEqual(await read(json(record(), { headers: { age: 'soon' } })), { error: 'a cached copy (Age: soon)' });
  // GitHub Pages answers a cache miss with Age: 0.
  assert.deepEqual(await read(json(record(), { headers: { age: '0' } })), { record: record() });
  assert.deepEqual(await read(new Response(JSON.stringify(record()), { headers: { 'content-type': 'text/html; charset=utf-8' } })), { error: 'content type "text/html"' });
  assert.deepEqual(await read(new Response(JSON.stringify(record()))), { error: 'content type "text/plain"' });
});

test('a re-run publishes and checks every site before it reads any history', async () => {
  // Run 99 published every site and failed a browser check; a person re-runs it. It keeps its id.
  const rerun = { runId: 99, attempt: 2, since: SINCE, runs: [run(98, 60), { ...run(99, 0, null, { status: 'in_progress', attempt: 2 }) }] };
  assert.deepEqual(previousDeploy(rerun), { green: false, reason: 're-run (attempt 2)' });
  assert.deepEqual(previousDeploy({ runId: 99, attempt: '3' }), { green: false, reason: 're-run (attempt 3)' }, 'with no history at all');
  assert.equal(previousDeploy({ ...green, attempt: undefined }).reason, 'this run\'s attempt is unknown (undefined)');
  assert.equal(previousDeploy({ ...green, attempt: '1.5' }).green, false);
  // The reader asks nothing of the API for a re-run.
  let requests = 0;
  const read = await readDeployHistory({ repository: 'o/r', workflowRef: 'o/r/.github/workflows/deploy-pages.yml@refs/heads/main', runId: '99', attempt: '2', token: 't', fetch: async () => { requests++; return json({}); } });
  assert.equal(requests, 0);
  assert.equal(forcedReason(read), 're-run (attempt 2)');
});

test('the run whose latest attempt started last decides, whatever its id', () => {
  // Run 98 is older than 99, but its re-run started after 99 and failed.
  assert.deepEqual(previousDeploy(history(run(99, 60), run(98, 20, 'failure', { attempt: 2 }))), { green: false, reason: 'previous deploy run 98 attempt 2 failure' });
  // Its re-run published and checked every site and passed, after 99 had failed.
  assert.deepEqual(previousDeploy(history(run(99, 60, 'failure'), run(98, 20, 'success', { attempt: 2 }))), { green: true, run: run(98, 20, 'success', { attempt: 2 }) });
  // The order the API lists them in does not matter.
  assert.deepEqual(previousDeploy(history(run(98, 20, 'failure', { attempt: 2 }), run(99, 60))).reason, 'previous deploy run 98 attempt 2 failure');
  assert.deepEqual(previousDeploy(history(run(99, 30), run(98, 31, 'failure'))), { green: true, run: run(99, 30) });
});

test('an earlier run that is still queued, waiting or in progress leaves the order unknown', () => {
  for (const status of ['queued', 'waiting', 'pending', 'requested', 'in_progress']) {
    assert.deepEqual(previousDeploy(history(run(99, 30), run(98, 10, null, { status }))), { green: false, reason: `run 98 is ${status} and started before this run` });
  }
  // A run that started after this one waits for it in the concurrency group and does not count.
  assert.equal(previousDeploy(history(run(99, 30), run(101, -5, null, { status: 'pending' }))).green, true);
  // One that started after this one and did work cannot have run before it.
  assert.deepEqual(previousDeploy(history(run(99, 30), run(101, -5, 'success'))), { green: false, reason: 'run 101 ran after this run started' });
});

test('a malformed or missing field, or a date that is not a real instant, is a doubt', () => {
  const mutations = {
    'record null': () => null,
    'id string': (r) => ({ ...r, id: '99' }),
    'id zero': (r) => ({ ...r, id: 0 }),
    'attempt zero': (r) => ({ ...r, run_attempt: 0 }),
    'attempt string': (r) => ({ ...r, run_attempt: '1' }),
    'status missing': (r) => ({ ...r, status: undefined }),
    'conclusion number': (r) => ({ ...r, conclusion: 7 }),
    'start missing': (r) => ({ ...r, run_started_at: undefined }),
    'start text': (r) => ({ ...r, run_started_at: 'yesterday' }),
    'start 31 February': (r) => ({ ...r, run_started_at: '2026-02-31T10:00:00Z' }),
    'start 24:00': (r) => ({ ...r, run_started_at: '2026-11-17T24:00:00Z' }),
    'start with offset': (r) => ({ ...r, run_started_at: '2026-11-18T11:30:00+00:00' }),
    'jobs negative': (r) => ({ ...r, jobs: -1 }),
    'jobs string': (r) => ({ ...r, jobs: '5' }),
    'jobs null': (r) => ({ ...r, jobs: null }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const decision = previousDeploy(history(mutate(run(99, 30))));
    assert.equal(decision.green, false, name);
    assert.match(decision.reason, /^malformed run history \(/, name);
  }
  assert.deepEqual(previousDeploy({ ...green, runs: 'none' }), { green: false, reason: 'no run history' });
  assert.deepEqual(previousDeploy({ ...green, since: '2026-10-16' }), { green: false, reason: 'no run history' });
  assert.deepEqual(previousDeploy({ ...green, runId: '100' }), { green: false, reason: 'no run history' });
  assert.deepEqual(previousDeploy({ ...green, runs: [run(99, 30)] }), { green: false, reason: 'run 100 is not in the run history' });
  assert.deepEqual(previousDeploy({ ...green, runs: [{ ...THIS_RUN, run_attempt: 2 }, run(99, 30)] }), { green: false, reason: 'the run history has run 100 at attempt 2' });
});

test('two runs that started at the same instant leave the order unknown', () => {
  assert.deepEqual(previousDeploy(history(run(99, 30), run(98, 30, 'failure'))), { green: false, reason: 'run 99 started at the same instant as another run' });
  // A run that started when this one did.
  assert.equal(previousDeploy(history(run(99, 30), run(101, 0, 'cancelled', { jobs: 0 }))).reason, 'run 101 started at the same instant as another run');
});

test('a deciding run the history cannot be certain of publishes everything', () => {
  // The history lists runs created since SINCE; a run created before can have a re-run up to 30 days later.
  const certain = (HISTORY_DAYS - RERUN_LIMIT_DAYS - 1) * 24 * 60;
  assert.equal(previousDeploy(history(run(99, certain))).green, true);
  assert.deepEqual(previousDeploy(history(run(99, certain + 1))), { green: false, reason: `run 99 started ${instant(NOW - (certain + 1) * MINUTE)}, before the run history read is certain` });
  assert.deepEqual(previousDeploy(history()), { green: false, reason: 'no earlier deploy run that started a job' });
  assert.deepEqual(previousDeploy(history(run(99, 30, 'cancelled', { jobs: 0 }))), { green: false, reason: 'no earlier deploy run that started a job' });
});

test('a run that started no job is passed over, unless an earlier attempt of it may have', () => {
  // Cancelled while it waited in the concurrency group, or a startup failure: it did nothing.
  assert.deepEqual(previousDeploy(history(run(99, 30, 'cancelled', { jobs: 0 }), run(98, 31, 'startup_failure', { jobs: 0 }), run(97, 60))), { green: true, run: run(97, 60) });
  assert.equal(previousDeploy(history(run(99, 30, 'cancelled', { jobs: 0 }), run(97, 60, 'failure'))).reason, 'previous deploy run 97 failure');
  // A run cancelled part-way did work and may have left a site half deployed or unchecked.
  assert.equal(previousDeploy(history(run(99, 30, 'cancelled', { jobs: 3 }), run(97, 60))).reason, 'previous deploy run 99 cancelled');
  assert.equal(previousDeploy(history(run(99, 30, 'timed_out'), run(97, 60))).reason, 'previous deploy run 99 timed_out');
  // A re-run cancelled while it waited leaves its first attempt's outcome unaccounted for.
  assert.deepEqual(previousDeploy(history(run(99, 30, 'cancelled', { attempt: 2, jobs: 0 }), run(97, 60))), { green: false, reason: 'run 99 attempt 2 started no job after an earlier attempt' });
  // A job count the reader has not fetched is asked for, newest start first.
  const { jobs, ...unread } = run(99, 30, 'cancelled');
  assert.equal(jobs, 5);
  assert.deepEqual(previousDeploy(history(unread, run(97, 60))), { need: 99 });
  assert.equal(forcedReason(history(unread, run(97, 60))), 'deploy history incomplete (no job count for run 99)');
});

// The API as the reader sees it: `runs` newest first, served `perPage` at a time.
function githubApi(runs, { jobs = {}, totals = [], perPage = 100 } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const { pathname, searchParams } = new URL(url);
    const listing = pathname.match(/^\/repos\/neurodesk\/webapps\/actions\/workflows\/deploy-pages\.yml\/runs$/);
    if (listing) {
      const page = Number(searchParams.get('page'));
      return json({ total_count: totals[page - 1] ?? runs.length, workflow_runs: runs.slice((page - 1) * perPage, page * perPage) });
    }
    const counted = pathname.match(/^\/repos\/neurodesk\/webapps\/actions\/runs\/(\d+)\/jobs$/);
    if (counted && searchParams.get('filter') === 'latest' && Number(counted[1]) in jobs) return json({ total_count: jobs[counted[1]], jobs: [] });
    return json({ message: 'Not Found' }, { status: 404 });
  };
  return { fetch, requests };
}
const READER = { repository: 'neurodesk/webapps', workflowRef: 'neurodesk/webapps/.github/workflows/deploy-pages.yml@refs/heads/main', runId: '1000', attempt: '1', token: 't', now: NOW };
// 150 runs as the API lists them, newest first: this run (1000), a run cancelled
// while it waited, a failed dispatch from a branch, then green pushes.
const listed = [
  { ...THIS_RUN, id: 1000, event: 'push', head_branch: 'main' },
  { ...run(999, 30, 'cancelled'), event: 'push', head_branch: 'main' },
  { ...run(998, 60, 'failure'), event: 'workflow_dispatch', head_branch: 'fix/site' },
  ...Array.from({ length: 147 }, (_, index) => run(997 - index, 90 + index * 30)),
].map((record) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'jobs')));

test('the history is every run of the workflow on every ref created in the last 33 days, then the job counts the decision asks for', async () => {
  const api = githubApi(listed, { jobs: { 999: 0, 998: 4 } });
  const read = await readDeployHistory({ ...READER, fetch: api.fetch });
  assert.equal(read.since, SINCE);
  assert.equal(read.runs.length, 150);
  assert.equal(forcedReason(read), 'previous deploy run 998 failure', 'the failed dispatch from a branch decides');
  const paths = api.requests.map(({ url }) => decodeURIComponent(new URL(url).pathname + new URL(url).search));
  const listing = `/repos/neurodesk/webapps/actions/workflows/deploy-pages.yml/runs?per_page=100&page=PAGE&exclude_pull_requests=true&created=>=${SINCE}`;
  assert.deepEqual(paths, [
    listing.replace('PAGE', '1'),
    listing.replace('PAGE', '2'),
    '/repos/neurodesk/webapps/actions/runs/999/jobs?filter=latest&per_page=1',
    '/repos/neurodesk/webapps/actions/runs/998/jobs?filter=latest&per_page=1',
  ], 'no branch filter, and a job count only for the runs it passes on the way');
  assert.ok(paths.every((path) => !path.includes('branch=')));
  assert.equal(api.requests[0].init.headers.authorization, 'Bearer t');
  // With the dispatch green, the history is green.
  const passing = listed.map((record) => (record.id === 998 ? { ...record, conclusion: 'success' } : record));
  assert.equal(forcedReason(await readDeployHistory({ ...READER, fetch: githubApi(passing, { jobs: { 999: 0, 998: 4 } }).fetch })), null);
});

test('a history the reader cannot read whole, or an API that fails, is a doubt', async () => {
  const cases = {
    'no token': [{ token: undefined }, 'no repository, workflow, run id or token'],
    'HTTP 403': [{ fetch: async () => json({ message: 'Forbidden' }, { status: 403 }) }, /HTTP 403$/],
    'a body that is not JSON': [{ fetch: async () => new Response('<html>', { headers: { 'content-type': 'application/json' } }) }, /JSON/],
    'no workflow runs': [{ fetch: async () => json({ total_count: 1 }) }, 'GitHub API: no workflow runs'],
    'too many runs': [{ fetch: githubApi(listed, { totals: [HISTORY_MAX_RUNS + 1] }).fetch }, `${HISTORY_MAX_RUNS + 1} runs since ${SINCE}, more than the ${HISTORY_MAX_RUNS} the plan reads`],
    'a run added between pages': [{ fetch: githubApi(listed, { totals: [150, 151] }).fetch }, 'the run history changed while it was read'],
    'a run listed twice': [{ fetch: githubApi([...listed.slice(0, 100), ...listed.slice(99, 149)]).fetch }, 'the run history lists 149 distinct runs of 150'],
    'a job count missing': [{ fetch: githubApi(listed, { jobs: { 999: 0 } }).fetch }, /actions\/runs\/998\/jobs\?filter=latest&per_page=1: HTTP 404$/],
    'a network failure': [{ fetch: async () => { throw new TypeError('fetch failed'); } }, 'fetch failed'],
  };
  for (const [name, [options, error]] of Object.entries(cases)) {
    const read = await readDeployHistory({ ...READER, fetch: githubApi(listed, { jobs: { 999: 0, 998: 4 } }).fetch, ...options });
    assert.equal(read.runs, undefined, name);
    if (typeof error === 'string') assert.equal(read.error, error, name);
    else assert.match(read.error, error, name);
    assert.equal(forcedReason(read), `deploy history unreadable (${read.error})`, name);
  }
  // A job count that is not a count.
  const odd = await readDeployHistory({ ...READER, fetch: githubApi(listed, { jobs: { 999: 'none' } }).fetch });
  assert.equal(forcedReason(odd), 'malformed run history (run 999: job count "none")');
});

test('after a re-run, a failed run before this one or an unreadable history, every site is published and checked, though its digest is live', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = async (url) => json(records.get(new URL(url).host));
  const plan = (state) => planDeploy({ registry, sitesDir: root, commit: C1, history: state, nonce: 'n', fetch: served, write: writeFile });
  assert.ok((await plan(green)).every(({ publish }) => !publish), 'every digest is live');
  assert.ok((await plan(Promise.resolve(green))).every(({ publish }) => !publish), 'the history can still be on its way');
  for (const [state, reason] of [
    [{ runId: 100, attempt: '2' }, 'forced: re-run (attempt 2)'],
    [history(run(99, 30, 'cancelled', { jobs: 0 }), run(98, 60, 'failure'), run(97, 90)), 'forced: previous deploy run 98 failure'],
    [{ error: 'HTTP 403' }, 'forced: deploy history unreadable (HTTP 403)'],
    [undefined, 'forced: deploy history unreadable (not read)'],
    // A history read that rejects, as a thenable so the rejection waits for its reader.
    [{ then: (resolve, reject) => reject(new Error('lost')) }, 'forced: deploy history unreadable (lost)'],
  ]) {
    const planned = await plan(state);
    assert.ok(planned.every((site) => site.publish && site.verifyBuild && site.verify && site.reason === reason), reason);
    const outputs = deployOutputs(planned);
    assert.equal(outputs.pages, 'true');
    assert.deepEqual(JSON.parse(outputs.workers).map(({ site: id }) => id), ['msk', 'microscopy', 'preclinical', 'hub']);
    // The Pages deploy job checks neuro; the verify jobs check the rest.
    assert.deepEqual(JSON.parse(outputs.verify).map(({ site: id }) => id), ['msk', 'microscopy', 'preclinical']);
    assert.equal(outputs.verify_hub, 'true');
    assert.match(deploySummary(planned), new RegExp(`\\| msk \\| mskapps\\.sciget\\.org \\| publish \\| after publish \\| ${reason.replace(/[()]/g, '\\$&')} \\|`));
  }
});

test('red, then green, then a skip; red, then a part-way cancellation, then everything again', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = async (url) => json(records.get(new URL(url).host));
  const published = async (state) => (await planDeploy({ registry, sitesDir: root, commit: C1, history: state, nonce: 'n', fetch: served, write: writeFile })).filter(({ publish }) => publish).length;
  const all = deploySites(registry).length;
  // Run 98 failed: run 99 publishes everything. It passes: run 100 skips what is live.
  assert.equal(await published({ runId: 99, attempt: 1, since: SINCE, runs: [{ ...THIS_RUN, id: 99 }, run(98, 30, 'failure')] }), all);
  assert.equal(await published(history(run(99, 10), run(98, 30, 'failure'))), 0);
  // Run 99 is cancelled part-way through that republish: run 100 publishes everything again.
  assert.equal(await published(history(run(99, 10, 'cancelled', { jobs: 2 }), run(98, 30, 'failure'))), all);
});

// A loopback server that answers every request with JSON headers at once and
// then the body `late` ms later, or never when `late` is Infinity.
async function slowServer(t, late) {
  const timers = new Set();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"schema":1,');
    if (late !== Infinity) timers.add(setTimeout(() => response.end(`"site":"msk","digest":"${digest}","analyticsGeneratedAt":null,"commit":null}`), late));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Every https URL the plan asks for goes to the server instead.
  return (url, init) => globalThis.fetch(url.replace(/^https:\/\/[^/]+/, origin), init);
}

const elapsed = async (work) => {
  const start = performance.now();
  const result = await work();
  return { result, ms: performance.now() - start };
};

test('a live record whose body arrives after the deadline, or never ends, is unreadable at the deadline', { timeout: 10_000 }, async (t) => {
  const prompt = await slowServer(t, 0);
  assert.equal((await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: prompt, timeoutMs: 2000 })).record.digest, digest, 'the server answers in time');
  for (const late of [3000, Infinity]) {
    const fetch = await slowServer(t, late);
    const { result, ms } = await elapsed(() => readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch, timeoutMs: 300 }));
    assert.deepEqual(result, { error: 'no complete answer in 0.3 s' }, `body after ${late} ms`);
    assert.ok(ms >= 290 && ms < 1500, `ended after ${ms} ms`);
    assert.equal(decideSite({ digest, analytics: null, live: result }).publish, true);
  }
});

test('a run history whose body stalls is unreadable at the deadline', { timeout: 10_000 }, async (t) => {
  for (const late of [3000, Infinity]) {
    const fetch = await slowServer(t, late);
    const { result, ms } = await elapsed(() => readDeployHistory({ ...READER, fetch, timeoutMs: 300 }));
    assert.deepEqual(result, { error: 'GitHub API: no complete answer in 0.3 s' });
    assert.ok(ms >= 290 && ms < 1500, `ended after ${ms} ms`);
  }
});

test('the plan returns its outputs by its deadlines when every read stalls, and publishes and checks everything', { timeout: 10_000 }, async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const fetch = await slowServer(t, Infinity);
  const env = { GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_WORKFLOW_REF: READER.workflowRef, GITHUB_RUN_ID: '1000', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 't', GITHUB_SHA: C1 };
  const all = { pages: 'true', workers: JSON.stringify(['msk', 'microscopy', 'preclinical', 'hub'].map((id) => ({ site: id, url: `https://${deploySites(registry).find(({ site: s }) => s === id).host}/` }))) };
  const { result, ms } = await elapsed(() => planSiteDeploy({ registry, sitesDir: root, env, fetch, write: writeFile, timeouts: { record: 1200, history: 1500 }, now: NOW }));
  // One after the other they would take 2.7 s.
  assert.ok(ms >= 1490 && ms < 2400, `the reads run at once and end at the longer deadline (${ms} ms)`);
  assert.deepEqual({ pages: result.outputs.pages, workers: result.outputs.workers }, all);
  assert.equal(result.outputs.verify_build, 'true');
  assert.equal(result.outputs.verify_hub, 'true');
  assert.match(result.summary, /^Every site is published: deploy history unreadable \(GitHub API: no complete answer in 1\.5 s\)\.\n/);
  // With a readable green history, each stalled record publishes its own site.
  const api = githubApi(listed.map((record) => (record.id === 998 ? { ...record, conclusion: 'success' } : record)), { jobs: { 999: 0, 998: 4 } });
  const split = (url, init) => (url.startsWith('https://api.github.com/') ? api.fetch(url, init) : fetch(url, init));
  const green2 = await planSiteDeploy({ registry, sitesDir: root, env, fetch: split, write: writeFile, timeouts: { record: 300 }, now: NOW });
  assert.ok(green2.planned.every(({ publish, reason }) => publish && reason === 'live digest unreadable (no complete answer in 0.3 s)'));
  assert.doesNotMatch(green2.summary, /^Every site is published/);
  assert.deepEqual({ pages: green2.outputs.pages, workers: green2.outputs.workers }, all);
});

test('the daily run checks every live site, published or not', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = async (url) => json(records.get(new URL(url).host));
  // GA4 was unavailable, so no usage report is refreshed and nothing is published.
  const daily = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, verifyAll: true, nonce: 'n', fetch: served, write: writeFile });
  assert.ok(daily.every(({ publish, verify }) => !publish && verify));
  assert.deepEqual(deployOutputs(daily), {
    pages: 'false',
    workers: '[]',
    verify: JSON.stringify(registry.site.catalogs.map(({ id, host }) => ({ site: id, url: `https://${host}/` }))),
    verify_hub: 'true',
    verify_build: 'false',
  });
  assert.match(deploySummary(daily), /\| neuro \| webapps\.neurodesk\.org \| skip \| live site \| unchanged/);
  // A push checks nothing it does not publish.
  const push = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: served, write: writeFile });
  assert.deepEqual(deployOutputs(push), { pages: 'false', workers: '[]', verify: '[]', verify_hub: 'false', verify_build: 'false' });
});

test('every catalogue and the hub is planned, and the Worker list is the one the registry declares', () => {
  assert.deepEqual(deploySites(registry).map(({ site }) => site), [...registry.site.catalogs.map(({ id }) => id), 'hub']);
  assert.deepEqual(deploySites(registry).filter(({ hosting }) => hosting === 'worker').map(({ site, host }) => ({ host, site })), workerSites(registry));
  assert.equal(deploySites(registry).filter(({ hosting }) => hosting === 'pages').length, 1);
});

async function sitesFixture(root) {
  for (const { site: id, hosting, host } of deploySites(registry)) {
    await site(join(root, id));
    // The hub has no usage report.
    if (id === 'hub') await rm(join(root, id, 'analytics.json'));
    if (hosting === 'worker') await put(root, `${id}.wrangler.json`, JSON.stringify({ name: host }));
  }
}

test('a plan publishes only what differs from the live hosts and writes each site its record', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const written = new Map();
  const write = async (path, text) => { written.set(path, text); await writeFile(path, text); };
  // First deploy: nothing is live yet, so every site is published.
  const missing = async () => new Response('Not found', { status: 404 });
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: missing, write });
  assert.ok(first.every(({ publish, verifyBuild }) => publish && verifyBuild));
  assert.equal(written.size, deploySites(registry).length);
  const records = Object.fromEntries(first.map(({ site, record }) => [site, record]));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'msk', DIGEST_FILE), 'utf8')), records.msk);
  assert.equal(records.msk.analyticsGeneratedAt, '2026-11-18T01:06:47.596Z');
  assert.equal(records.hub.analyticsGeneratedAt, null);
  assert.equal(records.msk.commit, C1);

  // The hosts now serve those records. One app of msk changes, and preclinical's deploy had failed.
  const served = async (url) => {
    const id = deploySites(registry).find(({ host }) => url.startsWith(`https://${host}/`)).site;
    if (id === 'preclinical') return json({ ...records.preclinical, digest: 'f'.repeat(64) });
    return json(records[id]);
  };
  await put(join(root, 'msk'), 'app/assets/model.wasm', 'new model');
  const second = await planDeploy({ registry, sitesDir: root, commit: C2, history: green, nonce: 'n', fetch: served, write });
  const decision = Object.fromEntries(second.map(({ site, publish, reason }) => [site, publish ? reason : 'skip']));
  assert.deepEqual(decision, {
    neuro: 'skip', msk: 'content changed', microscopy: 'skip', preclinical: 'content changed', hub: 'skip',
  });
  assert.deepEqual(deployOutputs(second), {
    pages: 'false',
    workers: JSON.stringify([
      { site: 'msk', url: 'https://mskapps.sciget.org/' },
      { site: 'preclinical', url: 'https://preclinicalapps.sciget.org/' },
    ]),
    verify: JSON.stringify([
      { site: 'msk', url: 'https://mskapps.sciget.org/' },
      { site: 'preclinical', url: 'https://preclinicalapps.sciget.org/' },
    ]),
    verify_hub: 'false',
    verify_build: 'true',
  });
  // The record a site now carries does not change its digest.
  assert.equal(second.find(({ site: id }) => id === 'neuro').digest, records.neuro.digest);
  assert.equal(await siteDigest(join(root, 'neuro')), records.neuro.digest);

  const summary = deploySummary(second);
  for (const { site: id, host } of deploySites(registry)) assert.match(summary, new RegExp(`\\| ${id} \\| ${host} \\| (publish|skip) \\| `));
  assert.match(summary, /\| neuro \| webapps\.neurodesk\.org \| skip \| - \| unchanged: the live site has this content and a current usage report \|/);
  assert.match(summary, /\| msk \| mskapps\.sciget\.org \| publish \| after publish \| content changed \|/);
});

test('a deploy whose content is all live publishes nothing and skips the build\'s browser checks', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const write = writeFile;
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => new Response('', { status: 404 }), write });
  const records = new Map(first.map(({ host, record }) => [host, record]));
  const served = async (url) => json(records.get(new URL(url).host));
  const again = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: served, write });
  assert.deepEqual(deployOutputs(again), { pages: 'false', workers: '[]', verify: '[]', verify_hub: 'false', verify_build: 'false' });
  // The next day's scheduled run refreshes every catalogue's usage report, not the hub, and needs no browser check.
  for (const { site: id } of deploySites(registry).filter(({ site: s }) => s !== 'hub')) await put(join(root, id), 'analytics.json', report('2026-11-19T04:24:00Z'));
  const daily = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: served, write });
  assert.deepEqual(daily.filter(({ publish }) => publish).map(({ site: id }) => id), registry.site.catalogs.map(({ id }) => id));
  assert.equal(deployOutputs(daily).verify_build, 'false');
  assert.equal(deployOutputs(daily).pages, 'true');
  // A dispatched run publishes and checks everything.
  const dispatched = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: served, write, deployAll: true });
  assert.ok(dispatched.every(({ publish, verifyBuild }) => publish && verifyBuild));
});

const workflow = parse(await readFile(join(repoRoot, '.github/workflows/deploy-pages.yml'), 'utf8'));
// A GitHub expression of `needs`, `steps` and status functions, evaluated as JavaScript.
const expression = (source, context) => runInNewContext(
  source.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\.(\w+-[\w-]+)/g, '["$1"]').replace(/\bfromJSON\(/g, 'JSON.parse('),
  { cancelled: () => false, success: () => true, ...context },
);

test('the build plans the deploy after its checks of the projected sites and before anything is uploaded', () => {
  const steps = workflow.jobs.build.steps;
  const at = (match) => {
    const index = steps.findIndex(match);
    assert.ok(index >= 0, `missing step ${match}`);
    return index;
  };
  const plan = at((step) => step.id === 'plan');
  assert.match(steps[plan].run, /^node scripts\/plan-site-deploy\.mjs \$\{\{ github\.event_name == 'workflow_dispatch' && '--deploy-all' \|\| github\.event_name == 'schedule' && '--verify-all' \|\| '' \}\}$/);
  for (const [event, flag] of [['workflow_dispatch', '--deploy-all'], ['schedule', '--verify-all'], ['push', '']]) {
    assert.equal(expression(steps[plan].run.replace(/^node scripts\/plan-site-deploy\.mjs /, ''), { github: { event_name: event } }), flag);
  }
  // The plan reads this workflow's earlier runs. Its reads end by their deadlines; the step limit is a backstop.
  assert.equal(steps[plan].env.GITHUB_TOKEN, '${{ github.token }}');
  assert.equal(steps[plan]['timeout-minutes'], 10);
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.jobs.build.permissions, undefined, 'the build job holds the workflow permissions');
  for (const [name, match] of [
    ['build', (step) => step.run === 'pnpm build'],
    ['usage report', (step) => step.run?.startsWith('node scripts/write-analytics.mjs')],
    ['artifact audit', (step) => step.run === 'pnpm audit:artifacts'],
    ['site check', (step) => step.run === 'node --test test/catalog-sites.test.mjs'],
  ]) assert.ok(at(match) < plan, `${name} runs before the plan`);
  const browser = [at((step) => step.name === 'Install runtime startup test browser'), at((step) => step.run?.includes('pnpm test:runtime-startup'))];
  for (const index of browser) {
    assert.ok(index > plan);
    assert.equal(steps[index].if, "steps.plan.outputs.verify_build == 'true'", `${steps[index].name} runs whenever content may be new`);
  }
  for (const [match, condition] of [
    [(step) => step.uses?.startsWith('actions/configure-pages'), "steps.plan.outputs.pages == 'true'"],
    [(step) => step.uses?.startsWith('actions/upload-pages-artifact'), "steps.plan.outputs.pages == 'true'"],
    [(step) => step.with?.name === 'worker-sites', "steps.plan.outputs.workers != '[]'"],
  ]) {
    const index = at(match);
    assert.ok(index > plan, 'the site records are written before the upload');
    assert.equal(steps[index].if, condition);
  }
  assert.deepEqual(workflow.jobs.build.outputs, Object.fromEntries(['pages', 'workers', 'verify', 'verify_hub'].map((key) => [key, `\${{ steps.plan.outputs.${key} }}`])));
});

// The jobs GitHub runs for a build's outputs: a job whose `if` has no status
// function runs only when every job it needs succeeded. A matrix job must get
// a non-empty matrix, and a run is green when no job failed.
const JOB_ORDER = ['build', 'turbo-cache-retention', 'deploy-workers', 'deploy', 'verify-hub', 'verify-sites'];
const STATUS_FUNCTION = /\b(always|cancelled|failure|success)\(\)/;
function simulate(outputs, failing = [], kept = {}) {
  const results = {};
  for (const name of JOB_ORDER) {
    if (name in kept) {
      results[name] = kept[name];
      continue;
    }
    const job = workflow.jobs[name];
    const needs = [job.needs ?? []].flat();
    assert.ok(needs.every((need) => need in results), `${name} runs after what it needs`);
    const context = { needs: Object.fromEntries(needs.map((need) => [need, { result: results[need], outputs: need === 'build' ? outputs : {} }])) };
    const condition = job.if === undefined || expression(String(job.if), context);
    const gated = job.if !== undefined && STATUS_FUNCTION.test(String(job.if));
    const runs = condition && (gated || needs.every((need) => results[need] === 'success'));
    if (runs && job.strategy) {
      const matrix = expression(job.strategy.matrix.include, context);
      assert.ok(Array.isArray(matrix) && matrix.length > 0, `${name} never runs with an empty matrix`);
    }
    results[name] = !runs ? 'skipped' : failing.includes(name) ? 'failure' : 'success';
  }
  return results;
}
const ran = (results) => JOB_ORDER.filter((name) => results[name] !== 'skipped').join(' ');
// "Re-run failed jobs": GitHub re-runs each failed job and every job that needs
// one; the others keep their results and outputs from the attempt before.
function rerunFailed(outputs, previous) {
  const rerun = new Set();
  for (const name of JOB_ORDER) {
    const needs = [workflow.jobs[name].needs ?? []].flat();
    if (previous[name] === 'failure' || needs.some((need) => rerun.has(need))) rerun.add(name);
  }
  const results = simulate(outputs, [], Object.fromEntries(JOB_ORDER.filter((name) => !rerun.has(name)).map((name) => [name, previous[name]])));
  return { results, ran: JOB_ORDER.filter((name) => rerun.has(name) && results[name] !== 'skipped').join(' ') };
}
const greenRun = (results) => Object.values(results).every((result) => result !== 'failure');

test('every job of the workflow is in the simulated order', () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...JOB_ORDER].sort());
});

test('each case runs exactly the deploy and check jobs it needs, and leaves the run green', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: async () => json({}, { status: 404 }), write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = (unreadable) => async (url) => (new URL(url).host === unreadable ? new Response('Not found', { status: 404 }) : json(records.get(new URL(url).host)));
  const failed = history(run(99, 30, 'failure'));
  const plan = (options) => planDeploy({ registry, sitesDir: root, commit: C1, history: green, nonce: 'n', fetch: served(), write: writeFile, ...options });
  const cases = {
    'nothing changed, previous run green': await plan({}),
    'nothing changed, previous run failed': await plan({ history: failed }),
    'one site changed': await (async () => {
      await put(join(root, 'msk'), 'app/new.js', '');
      const planned = await plan({});
      await rm(join(root, 'msk', 'app/new.js'));
      return planned;
    })(),
    'scheduled run, every digest live': await plan({ verifyAll: true }),
    'dispatched run': await plan({ deployAll: true }),
    'unreadable record for one site': await plan({ fetch: served('webapps.neurodesk.org') }),
    // Run 100 published msk and its browser check failed; a person re-runs every job of it.
    'full re-run after a failed check': await plan({ history: { runId: 100, attempt: '2' } }),
  };
  const table = Object.fromEntries(Object.entries(cases).map(([name, planned]) => {
    const outputs = deployOutputs(planned);
    const results = simulate(outputs);
    assert.ok(greenRun(results), name);
    return [name, { outputs: `pages=${outputs.pages} workers=${JSON.parse(outputs.workers).map(({ site: id }) => id)} verify=${JSON.parse(outputs.verify).map(({ site: id }) => id)} hub=${outputs.verify_hub} startup=${outputs.verify_build}`, ran: ran(results) }];
  }));
  const all = { outputs: 'pages=true workers=msk,microscopy,preclinical,hub verify=msk,microscopy,preclinical hub=true startup=true', ran: JOB_ORDER.join(' ') };
  assert.deepEqual(table, {
    'nothing changed, previous run green': { outputs: 'pages=false workers= verify= hub=false startup=false', ran: 'build turbo-cache-retention' },
    'nothing changed, previous run failed': all,
    'one site changed': { outputs: 'pages=false workers=msk verify=msk hub=false startup=true', ran: 'build turbo-cache-retention deploy-workers verify-sites' },
    'scheduled run, every digest live': { outputs: 'pages=false workers= verify=neuro,msk,microscopy,preclinical hub=true startup=false', ran: 'build turbo-cache-retention verify-hub verify-sites' },
    'dispatched run': all,
    'unreadable record for one site': { outputs: 'pages=true workers= verify= hub=false startup=true', ran: 'build turbo-cache-retention deploy' },
    'full re-run after a failed check': all,
  });
  // "Re-run failed jobs" after msk's check failed: the build is not re-run and keeps its
  // outputs, so the check runs again on the sites the first attempt published.
  const firstAttempt = simulate(deployOutputs(cases['one site changed']), ['verify-sites']);
  assert.equal(greenRun(firstAttempt), false);
  const rerun = rerunFailed(deployOutputs(cases['one site changed']), firstAttempt);
  assert.equal(rerun.ran, 'verify-sites');
  assert.equal(greenRun(rerun.results), true);
  assert.deepEqual(JSON.parse(deployOutputs(cases['one site changed']).verify).map(({ site: id }) => id), ['msk']);
  // A failed Worker deploy re-runs with every job that waited for it.
  const workersFailed = simulate(deployOutputs(cases['one site changed']), ['deploy-workers']);
  assert.equal(rerunFailed(deployOutputs(cases['one site changed']), workersFailed).ran, 'deploy-workers verify-sites');
});

test('a failed Worker deploy holds back the Pages deploy and every check, and a failed build stops everything', () => {
  const outputs = { pages: 'true', workers: '[{"site":"msk"},{"site":"hub"}]', verify: '[{"site":"msk"}]', verify_hub: 'true', verify_build: 'true' };
  assert.equal(ran(simulate(outputs, ['deploy-workers'])), 'build turbo-cache-retention deploy-workers');
  assert.equal(ran(simulate(outputs, ['build'])), 'build');
  // The checks of the live hosts do not wait for the Pages deploy, which checks neuro itself.
  assert.deepEqual(workflow.jobs['verify-sites'].needs, ['build', 'deploy-workers']);
  assert.deepEqual(workflow.jobs['verify-hub'].needs, ['build', 'deploy-workers']);
  assert.deepEqual(workflow.jobs.deploy.needs, ['build', 'deploy-workers']);
  for (const step of workflow.jobs['verify-sites'].steps.filter(({ run }) => /test:|smoke/.test(run ?? ''))) assert.equal(step.if, undefined, `${step.name} runs for every listed site`);
  assert.deepEqual(workflow.jobs['verify-sites'].env, { BASE_URL: '${{ matrix.url }}', SITE_CATALOG: '${{ matrix.site }}' });
});
