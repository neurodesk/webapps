import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';
import { catalogApps, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { workerSites } from '../scripts/lib/catalog-sites.mjs';
import { moduleClosure } from '../scripts/lib/module-closure.mjs';
import {
  ANALYTICS_REFRESH_UTC,
  CHECK_DATA,
  DEPLOYED_CHECKS,
  DEPLOY_WORKFLOW,
  MARKER_PREFIX,
  analyticsStale,
  checkHashes,
  checkInputs,
  decideSite,
  deployOutputs,
  deploySites,
  deploySummary,
  lastAnalyticsRefresh,
  markerKey,
  planDeploy,
  planSiteDeploy,
  readMarker,
  siteDigest,
} from '../scripts/lib/site-deploy.mjs';
import { DIGEST_FILE, parseLiveRecord, readLiveRecord } from '../scripts/lib/site-record.mjs';

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
  const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: `${ANALYTICS_REFRESH_UTC.minute} ${ANALYTICS_REFRESH_UTC.hour} * * *` }]);
});

const digest = 'a'.repeat(64);
const C1 = 'fd08c1c20'.padEnd(40, '0');
const C2 = '77f026063'.padEnd(40, '0');
const record = (fields = {}) => ({ schema: 1, site: 'msk', digest, analyticsGeneratedAt: '2026-11-18T04:24:00Z', commit: C1, ...fields });
const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const missing = async () => new Response('Not found', { status: 404 });
// Check hashes as checkHashes gives them; CHECKS_2 after a check script changed.
const CHECKS = Object.fromEntries(deploySites(registry).map(({ site: id }) => [id, 'c'.repeat(64)]));
const CHECKS_2 = Object.fromEntries(deploySites(registry).map(({ site: id }) => [id, 'd'.repeat(64)]));
// A marker store holding `keys`, as readMarker answers.
const store = (keys = []) => {
  const markers = new Set(keys);
  return { markers, lookup: async (key) => ({ present: markers.has(key) }) };
};
const absent = store().lookup;

test('a site is skipped only when its host serves this digest, its marker exists, its report is current and the run was not dispatched', () => {
  const lives = { unreadable: { error: 'HTTP 404' }, same: { record: record() }, other: { record: record({ digest: 'b'.repeat(64) }) } };
  const markers = { present: { present: true }, absent: { present: false }, unknown: { error: 'GitHub API: HTTP 503' } };
  const events = { push: {}, schedule: { verifyAll: true }, dispatch: { deployAll: true } };
  const reports = { current: '2026-11-18T12:00:00Z', stale: '2026-11-19T04:30:00Z' };
  let cases = 0;
  for (const [liveName, live] of Object.entries(lives)) {
    for (const [markerName, marker] of Object.entries(markers)) {
      for (const [event, flags] of Object.entries(events)) {
        for (const [reportName, analytics] of Object.entries(reports)) {
          const name = `${liveName} live record, marker ${markerName}, ${event}, ${reportName} report`;
          const decision = decideSite({ digest, analytics, live, marker, ...flags });
          const skip = event !== 'dispatch' && liveName === 'same' && markerName === 'present' && reportName === 'current';
          assert.equal(decision.publish, !skip, name);
          // A published site is checked after the publish; the daily run checks every site.
          assert.equal(decision.verify, !skip || event === 'schedule', name);
          // The build's checks run whenever the content may not be what the host serves.
          assert.equal(decision.verifyBuild, event === 'dispatch' || liveName !== 'same', name);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 3 * 3 * 3 * 2);
  const analytics = '2026-11-18T12:00:00Z';
  const live = { record: record() };
  const reason = (fields) => decideSite({ digest, analytics, live, marker: { present: true }, ...fields }).reason;
  assert.equal(reason({}), 'verified: the host serves this content, checked by these checks, with a current usage report');
  assert.equal(reason({ deployAll: true }), 'dispatched run: every site deploys');
  assert.equal(reason({ live: { error: 'HTTP 404' } }), 'live digest unreadable (HTTP 404)');
  assert.equal(reason({ digest: 'b'.repeat(64) }), 'content changed');
  assert.equal(reason({ marker: { present: false } }), 'no verified marker for this content and these checks');
  assert.equal(reason({ marker: { error: 'GitHub API: HTTP 503' } }), 'marker unknown (GitHub API: HTTP 503)');
  assert.equal(reason({ analytics: '2026-11-19T04:30:00Z' }), 'usage report refresh (live report: 2026-11-18T04:24:00Z)');
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

async function sitesFixture(root) {
  for (const { site: id, hosting, host } of deploySites(registry)) {
    await site(join(root, id));
    // The hub has no usage report.
    if (id === 'hub') await rm(join(root, id, 'analytics.json'));
    if (hosting === 'worker') await put(root, `${id}.wrangler.json`, JSON.stringify({ name: host }));
  }
}

// Sites whose every digest is live and verified: the hosts serve the records a
// first plan wrote, and the marker store holds each site's marker.
async function verifiedFixture(t) {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, checks: CHECKS, lookup: absent, nonce: 'n', fetch: missing, write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = async (url) => json(records.get(new URL(url).host));
  const { markers, lookup } = store(first.map(({ key }) => key));
  const plan = (options = {}) => planDeploy({ registry, sitesDir: root, commit: C1, checks: CHECKS, lookup, nonce: 'n', fetch: served, write: writeFile, ...options });
  return { root, first, records, served, markers, lookup, plan };
}

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
  const { records, plan } = await verifiedFixture(t);
  const planned = await plan({ fetch: async (url) => json({ ...records.get(new URL(url).host), commit: { sha: C1 } }) });
  assert.ok(planned.every(({ publish, reason }) => publish && /^live digest unreadable \(commit is neither/.test(reason)));
  assert.match(deploySummary(planned), /\| msk \| mskapps\.sciget\.org \| publish \|/);
});

test('a site whose plan throws is published and checked, and the other sites are still planned', async (t) => {
  const { root, plan } = await verifiedFixture(t);
  await rm(join(root, 'microscopy.wrangler.json'));
  const planned = await plan();
  const decision = Object.fromEntries(planned.map(({ site: id, publish, reason }) => [id, publish ? reason : 'skip']));
  assert.match(decision.microscopy, /^plan failed \(ENOENT/);
  assert.deepEqual({ ...decision, microscopy: 'plan failed' }, { neuro: 'skip', msk: 'skip', microscopy: 'plan failed', preclinical: 'skip', hub: 'skip' });
  const outputs = deployOutputs(planned);
  assert.deepEqual(JSON.parse(outputs.workers), [{ site: 'microscopy', url: 'https://microscopyapps.sciget.org/' }]);
  assert.deepEqual(JSON.parse(outputs.verify), [{ site: 'microscopy', url: 'https://microscopyapps.sciget.org/' }]);
  assert.equal(outputs.verify_build, 'true');
  // With no digest there is no marker to save.
  assert.deepEqual(JSON.parse(outputs.markers), {});
  assert.match(deploySummary(planned), /\| microscopy \| microscopyapps\.sciget\.org \| publish \| after publish \| plan failed \(ENOENT[^|]*\| - \|/);
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
  assert.equal(requests[0].init.signal.aborted, true, 'the request is aborted once the read ends');
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

const KEY = markerKey('msk', digest, 'c'.repeat(64));
const cacheEntry = (fields = {}) => ({ id: 1, ref: 'refs/heads/main', key: KEY, version: 'f'.repeat(64), last_accessed_at: '2026-11-18T05:00:00Z', created_at: '2026-11-18T05:00:00Z', size_in_bytes: 230, ...fields });
const cacheList = (...entries) => ({ total_count: entries.length, actions_caches: entries });

test('a marker key names its site, digest and check hash, and nothing else', () => {
  assert.equal(KEY, `${MARKER_PREFIX}msk-${digest}-${'c'.repeat(64)}`);
  assert.equal(new Set([KEY, markerKey('msk', 'b'.repeat(64), 'c'.repeat(64)), markerKey('msk', digest, 'd'.repeat(64)), markerKey('preclinical', digest, 'c'.repeat(64))]).size, 4);
  // The Actions cache refuses a key longer than 512 characters or with a comma.
  assert.ok(KEY.length < 512 && !KEY.includes(','));
});

test('a marker exists only when the cache list has an entry of its exact key on this ref', async () => {
  const requests = [];
  const read = (answer, fields = {}) => readMarker({
    key: KEY,
    repository: 'neurodesk/webapps',
    ref: 'refs/heads/main',
    token: 't',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return typeof answer === 'function' ? answer() : json(answer);
    },
    ...fields,
  });
  assert.deepEqual(await read(cacheList(cacheEntry())), { present: true });
  const { searchParams, pathname, origin } = new URL(requests[0].url);
  assert.equal(`${origin}${pathname}`, 'https://api.github.com/repos/neurodesk/webapps/actions/caches');
  assert.deepEqual(Object.fromEntries(searchParams), { key: KEY, ref: 'refs/heads/main', per_page: '100' });
  assert.equal(requests[0].init.headers.authorization, 'Bearer t');
  assert.equal(requests[0].init.signal.aborted, true, 'the request is aborted once the read ends');
  // The API's key is a prefix: a longer key is another marker.
  assert.deepEqual(await read(cacheList(cacheEntry({ key: `${KEY}0` }))), { present: false });
  // A pull request's or another branch's entry is not main's.
  assert.deepEqual(await read(cacheList(cacheEntry({ ref: 'refs/pull/889/merge' }), cacheEntry({ ref: 'refs/heads/ci/deploy-changed-catalogues' }))), { present: false });
  assert.deepEqual(await read(cacheList()), { present: false });
  assert.deepEqual(await read(cacheList(cacheEntry({ key: `${KEY}0` }), cacheEntry())), { present: true });
  // Anything else is unknown, which publishes and checks the site.
  assert.deepEqual(await read({ total_count: 101, actions_caches: [cacheEntry({ key: `${KEY}0` })] }), { error: 'GitHub API: 101 caches match, more than one page' });
  assert.deepEqual(await read(() => json({ message: 'Resource not accessible by integration' }, { status: 403 })), { error: 'GitHub API: HTTP 403' });
  assert.deepEqual(await read(() => new Response('<html>', { status: 200 })), { error: 'Unexpected token \'<\', "<html>" is not valid JSON' });
  assert.deepEqual(await read({ total_count: '1', actions_caches: [cacheEntry()] }), { error: 'GitHub API: no cache list' });
  assert.deepEqual(await read({ total_count: 1, actions_caches: null }), { error: 'GitHub API: no cache list' });
  assert.deepEqual(await read(async () => { throw new TypeError('fetch failed'); }), { error: 'fetch failed' });
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.deepEqual(await readMarker({ key: KEY, repository: 'r', ref: 'refs/heads/main', token: 't', fetch: hang, timeoutMs: 20 }), { error: 'GitHub API: no complete answer in 0.02 s' });
  const before = requests.length;
  for (const field of ['key', 'repository', 'ref', 'token']) {
    assert.deepEqual(await read(cacheList(cacheEntry()), { [field]: undefined }), { error: 'no key, repository, ref or token' }, field);
  }
  assert.equal(requests.length, before, 'without a token or ref it asks nothing');
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

test('a live record or a marker list whose body arrives after the deadline, or never ends, is unreadable at the deadline', { timeout: 10_000 }, async (t) => {
  const prompt = await slowServer(t, 0);
  assert.equal((await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: prompt, timeoutMs: 2000 })).record.digest, digest, 'the server answers in time');
  for (const late of [3000, Infinity]) {
    const fetch = await slowServer(t, late);
    const { result, ms } = await elapsed(() => readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch, timeoutMs: 300 }));
    assert.deepEqual(result, { error: 'no complete answer in 0.3 s' }, `body after ${late} ms`);
    assert.ok(ms >= 290 && ms < 1500, `ended after ${ms} ms`);
    const marker = await elapsed(() => readMarker({ key: KEY, repository: 'r', ref: 'refs/heads/main', token: 't', fetch, timeoutMs: 300 }));
    assert.deepEqual(marker.result, { error: 'GitHub API: no complete answer in 0.3 s' }, `marker body after ${late} ms`);
    assert.ok(marker.ms >= 290 && marker.ms < 1500, `ended after ${marker.ms} ms`);
    assert.equal(decideSite({ digest, analytics: null, live: result, marker: marker.result }).publish, true);
  }
});

test('the plan returns its outputs by its deadlines when every read stalls, and publishes and checks everything', { timeout: 10_000 }, async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const fetch = await slowServer(t, Infinity);
  const env = { GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 't', GITHUB_SHA: C1 };
  const { result, ms } = await elapsed(() => planSiteDeploy({ registry, sitesDir: root, root: repoRoot, env, fetch, write: writeFile, timeouts: { record: 1200, marker: 800 } }));
  assert.ok(ms >= 1190 && ms < 2400, `the reads run at once and end at the longer deadline (${ms} ms)`);
  assert.equal(result.outputs.pages, 'true');
  assert.deepEqual(JSON.parse(result.outputs.workers).map(({ site: id }) => id), ['msk', 'microscopy', 'preclinical', 'hub']);
  assert.equal(result.outputs.verify_build, 'true');
  assert.equal(result.outputs.verify_hub, 'true');
  assert.ok(result.planned.every(({ publish, reason }) => publish && reason === 'live digest unreadable (no complete answer in 1.2 s)'));
  assert.ok(result.planned.every(({ marker }) => marker.error === 'GitHub API: no complete answer in 0.8 s'));
  assert.match(result.summary, /\| msk \| mskapps\.sciget\.org \| publish \| after publish \| live digest unreadable \(no complete answer in 1\.2 s\) \| unknown \(GitHub API: no complete answer in 0\.8 s\) \|/);
});

// A preload for a command under test: every https request goes to the
// loopback server at `port`, and every deadline of 10 s or more is divided by
// `scale`: by 100, a 30 s deadline ends at 0.3 s.
async function loopbackPreload(root, port, scale) {
  const preload = join(root, 'loopback.mjs');
  await writeFile(preload, [
    `const origin = 'http://127.0.0.1:${port}';`,
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = (url, init) => { const { pathname, search } = new URL(url); return realFetch(origin + pathname + search, init); };',
    'const realTimeout = globalThis.setTimeout;',
    `globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms >= 10_000 ? ms / ${scale} : ms, ...args);`,
    '',
  ].join('\n'));
  return preload;
}

// Run `script` with `args` under the preload; the outputs it writes to GITHUB_OUTPUT.
async function command(t, root, port, script, args, { env = {}, scale = 100 } = {}) {
  const output = join(root, 'output');
  await writeFile(output, '');
  const start = performance.now();
  const child = spawn(process.execPath, ['--import', await loopbackPreload(root, port, scale), join(repoRoot, script), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const killer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(killer);
  const outputs = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { code, signal, stdout, stderr, ms: performance.now() - start, outputs };
}

// A loopback server that answers every request with `status` and `type` at
// once, then sends `body` and, with `trickle`, a space every 100 ms forever,
// with `end` the end, or else nothing more.
async function answeringServer(t, { status, type, body = '{', trickle, end }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status, { 'content-type': type });
    response.flushHeaders();
    response.write(typeof body === 'function' ? body(request.url) : body);
    if (end) response.end();
    if (trickle) {
      const interval = setInterval(() => response.write(' '), 100);
      response.on('close', () => clearInterval(interval));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: server.address().port, requests };
}

const PLAN_ENV = { GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: C1, GITHUB_TOKEN: 'fixture' };

async function planCommand(t, answer) {
  const { port } = await answeringServer(t, answer);
  const root = await tempDir(t);
  await sitesFixture(join(root, 'sites'));
  return command(t, root, port, 'scripts/plan-site-deploy.mjs', ['--sites-dir', join(root, 'sites')], { env: PLAN_ENV });
}

test('the plan command exits by itself soon after its deadlines when answers trickle, are refused or stall', { timeout: 60_000 }, async (t) => {
  // Start-up, digests and outputs, with every answer complete at once.
  const prompt = await planCommand(t, { status: 404, type: 'text/plain', body: 'Not found', end: true });
  assert.equal(prompt.code, 0, prompt.stderr);
  for (const [name, answer] of [
    ['a trickling HTTP 502', { status: 502, type: 'text/html', trickle: true }],
    ['a trickling answer of the wrong content type', { status: 200, type: 'text/html', trickle: true }],
    ['a stalled JSON body', { status: 200, type: 'application/json' }],
  ]) {
    const { code, signal, stderr, ms, outputs } = await planCommand(t, answer);
    assert.equal(signal, null, `${name}: the process ended by itself (${stderr})`);
    assert.equal(code, 0, `${name}: ${stderr}`);
    // Each live record and marker read ends at 0.3 s under the preload.
    assert.ok(ms < prompt.ms + 300 + 1500, `${name}: exited after ${Math.round(ms)} ms, ${Math.round(prompt.ms)} ms with prompt answers`);
    assert.equal(outputs.pages, 'true', name);
    assert.deepEqual(JSON.parse(outputs.workers).map(({ site: id }) => id), ['msk', 'microscopy', 'preclinical', 'hub'], name);
    assert.equal(outputs.verify_hub, 'true', name);
    assert.equal(outputs.verify_build, 'true', name);
    assert.deepEqual(Object.keys(JSON.parse(outputs.markers)), ['neuro', 'msk', 'microscopy', 'preclinical', 'hub'], name);
  }
});

test('the confirm command marks a digest only when the host serves it, and never fails the job', { timeout: 60_000 }, async (t) => {
  const served = record({ site: 'msk' });
  const { port, requests } = await answeringServer(t, { status: 200, type: 'application/json', body: JSON.stringify(served), end: true });
  const root = await tempDir(t);
  // Prompt answers keep the real deadline.
  const confirm = (args) => command(t, root, port, 'scripts/confirm-site-digest.mjs', args, { env: { GITHUB_RUN_ID: '7', GITHUB_SHA: C2 }, scale: 1 });
  const marker = join(root, 'deploy-verified.json');
  const args = (value) => ['--url', 'https://mskapps.sciget.org/', '--site', 'msk', '--digest', value, '--marker', marker];

  const same = await confirm(args(digest));
  assert.deepEqual({ code: same.code, outputs: same.outputs }, { code: 0, outputs: { confirmed: 'true' } }, same.stderr);
  assert.match(requests.at(-1), new RegExp(`^/${DIGEST_FILE}\\?run=`));
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { ...JSON.parse(await readFile(marker, 'utf8')), site: 'msk', digest, run: '7', commit: C2 });
  await rm(marker);

  // Another digest, another site's record, no digest: no marker file, and the job goes on.
  for (const [name, values] of [
    ['an older digest', args('b'.repeat(64))],
    ['another site', ['--url', 'https://mskapps.sciget.org/', '--site', 'neuro', '--digest', digest, '--marker', marker]],
    ['no digest', ['--url', 'https://mskapps.sciget.org/', '--site', 'msk', '--digest', '', '--marker', marker]],
    ['no URL', ['--site', 'msk', '--digest', digest, '--marker', marker]],
  ]) {
    const result = await confirm(values);
    assert.deepEqual({ code: result.code, outputs: result.outputs }, { code: 0, outputs: { confirmed: 'false' } }, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /^::warning::.*no verified marker is saved\.$/m, name);
    await assert.rejects(access(marker), name);
  }

  // A host that stalls is unconfirmed by the deadline (0.3 s under the preload).
  const stalled = await answeringServer(t, { status: 200, type: 'application/json', trickle: true });
  const slow = await command(t, root, stalled.port, 'scripts/confirm-site-digest.mjs', args(digest));
  assert.deepEqual({ code: slow.code, signal: slow.signal, outputs: slow.outputs }, { code: 0, signal: null, outputs: { confirmed: 'false' } }, slow.stderr);
  // The message names the configured deadline; the preload ended it at 0.3 s.
  assert.match(slow.stdout, /no readable record \(no complete answer in 30 s\)/);
  assert.ok(slow.ms < 5000, `ended after ${Math.round(slow.ms)} ms`);
});

test('the confirm command loads only Node built-ins, so the hub check needs no install', async () => {
  const closure = moduleClosure(repoRoot, ['scripts/confirm-site-digest.mjs']);
  assert.deepEqual(closure, ['scripts/confirm-site-digest.mjs', 'scripts/lib/site-record.mjs']);
  for (const file of closure) {
    for (const [, specifier] of (await readFile(join(repoRoot, file), 'utf8')).matchAll(/\bfrom\s+'([^']+)'/g)) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
  const hub = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8')).jobs['verify-hub'];
  assert.deepEqual(hub.steps[0], { uses: 'actions/checkout@v7', with: { 'sparse-checkout': 'scripts' } });
});

// A copy of the files the deployed checks read, with the npm packages they
// import installed at `versions`, under a temporary root.
async function checksFixture(t, versions = { '@playwright/test': '1.64.0', yaml: '2.9.0', zod: '4.6.5' }) {
  const root = await tempDir(t);
  const inputs = checkInputs(repoRoot, registry);
  for (const path of new Set(Object.values(inputs).flatMap(({ files }) => files))) await cp(join(repoRoot, path), join(root, path));
  await mkdir(join(root, 'exes'), { recursive: true });
  for (const [name, version] of Object.entries(versions)) await put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  // pnpm links a workspace package into the node_modules of each package that depends on it.
  await mkdir(join(root, 'packages/desktop/node_modules/@neurodesk'), { recursive: true });
  await symlink('../../../components', join(root, 'packages/desktop/node_modules/@neurodesk/webapp-components'));
  return root;
}

test('the check hash covers every input of a site\'s deployed checks and nothing else', async (t) => {
  const root = await checksFixture(t);
  const base = checkHashes(root, registry);
  assert.deepEqual(Object.keys(base), ['hub', ...registry.site.catalogs.map(({ id }) => id)]);
  assert.ok(Object.values(base).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.deepEqual(checkHashes(root, registry), base, 'the same inputs give the same hash');
  assert.deepEqual(checkHashes(root, registry).msk, checkHashes(await checksFixture(t), registry).msk, 'a copy gives the same hash');
  const inputs = checkInputs(root, registry);
  assert.deepEqual(inputs.hub, { files: [DEPLOY_WORKFLOW], packages: [] }, 'the hub check is a step of the workflow');
  for (const path of [...DEPLOYED_CHECKS, ...CHECK_DATA, 'test-utils/site-catalog.mjs', 'scripts/lib/apps-registry.mjs', 'packages/components/package.json']) {
    assert.ok(inputs.msk.files.includes(path), `${path} is a check input`);
  }
  assert.deepEqual(inputs.msk.packages, ['@playwright/test@1.64.0', 'yaml@2.9.0', 'zod@4.6.5']);
  // An app served by one catalogue only.
  const single = registry.apps.find((app) => registry.site.catalogs.filter((catalog) => catalogApps(registry, findCatalog(registry, catalog.id)).includes(app)).length === 1);
  const changed = (hashes) => Object.keys(base).filter((id) => hashes[id] !== base[id]).join(' ');
  const catalogues = registry.site.catalogs.map(({ id }) => id).join(' ');
  for (const [name, change, expected] of [
    ['a check script', (dir) => put(dir, 'test/image-upload.smoke.mjs', '// changed\n'), catalogues],
    ['a module a check imports', (dir) => put(dir, 'test-utils/site-catalog.mjs', '// changed\n'), catalogues],
    ['the app registry', (dir) => put(dir, 'registry/apps.yml', '# changed\n'), catalogues],
    ['the standalone catalog', (dir) => put(dir, 'registry/standalone.json', '{}'), catalogues],
    ['the root scripts', (dir) => put(dir, 'package.json', '{}'), catalogues],
    [`the package.json of ${single.id}`, (dir) => put(dir, `apps/${single.id}/package.json`, '{}'), single.catalog],
    ['the installed Playwright', (dir) => put(dir, 'node_modules/@playwright/test/package.json', '{"version":"1.65.0"}'), catalogues],
    ['the workflow', (dir) => put(dir, DEPLOY_WORKFLOW, '# changed\n'), `hub ${catalogues}`],
    ['a deleted check script', (dir) => rm(join(dir, 'test/deployed-site.smoke.mjs')), catalogues],
    ['a file no check reads', (dir) => put(dir, 'apps/no-check/src/main.js', '// new\n'), ''],
  ]) {
    const dir = await checksFixture(t);
    await change(dir);
    assert.equal(changed(checkHashes(dir, registry)), expected, name);
  }
});

test('the check scripts the hash covers are the ones the workflow\'s check steps run', async () => {
  const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
  const scripts = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).scripts;
  for (const name of ['deploy', 'verify-sites']) {
    const steps = workflow.jobs[name].steps;
    const before = steps.findIndex(({ id }) => id === 'before');
    const after = steps.findIndex(({ id }) => id === 'after');
    const run = steps.slice(before + 1, after).map((step) => step.run.replace(/^pnpm (\S+)$/, (whole, script) => scripts[script]));
    assert.deepEqual(run.map((line) => line.replace(/^node /, '')).sort(), [...DEPLOYED_CHECKS].sort(), `${name} runs exactly the deployed checks between its confirmations`);
  }
});

test('the daily run checks every live site, published or not', async (t) => {
  const { plan } = await verifiedFixture(t);
  // GA4 was unavailable, so no usage report is refreshed and nothing is published.
  const daily = await plan({ verifyAll: true });
  assert.ok(daily.every(({ publish, verify }) => !publish && verify));
  const outputs = deployOutputs(daily);
  assert.deepEqual({ ...outputs, markers: undefined }, {
    pages: 'false',
    workers: '[]',
    verify: JSON.stringify(registry.site.catalogs.map(({ id, host }) => ({ site: id, url: `https://${host}/` }))),
    verify_hub: 'true',
    verify_build: 'false',
    markers: undefined,
  });
  // Each check job gets the digest it must confirm and the marker it saves or keeps.
  assert.deepEqual(JSON.parse(outputs.markers), Object.fromEntries(daily.map(({ site: id, url, digest: built, key }) => [id, { url, digest: built, key }])));
  assert.match(deploySummary(daily), /\| neuro \| webapps\.neurodesk\.org \| skip \| live site \| verified: [^|]* \| found \|/);
  // A push checks nothing it does not publish.
  const push = await plan();
  assert.deepEqual(deployOutputs(push), { pages: 'false', workers: '[]', verify: '[]', verify_hub: 'false', verify_build: 'false', markers: '{}' });
});

test('every catalogue and the hub is planned, and the Worker list is the one the registry declares', () => {
  assert.deepEqual(deploySites(registry).map(({ site }) => site), [...registry.site.catalogs.map(({ id }) => id), 'hub']);
  assert.deepEqual(deploySites(registry).filter(({ hosting }) => hosting === 'worker').map(({ site, host }) => ({ host, site })), workerSites(registry));
  assert.equal(deploySites(registry).filter(({ hosting }) => hosting === 'pages').length, 1);
});

test('a plan publishes only what differs from the live hosts or lacks a marker, and writes each site its record', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const written = new Map();
  const write = async (path, text) => { written.set(path, text); await writeFile(path, text); };
  // First deploy: nothing is live and no marker exists, so every site is published.
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, checks: CHECKS, lookup: absent, nonce: 'n', fetch: missing, write });
  assert.ok(first.every(({ publish, verifyBuild }) => publish && verifyBuild));
  assert.equal(written.size, deploySites(registry).length);
  const records = Object.fromEntries(first.map(({ site, record }) => [site, record]));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'msk', DIGEST_FILE), 'utf8')), records.msk);
  assert.equal(records.msk.analyticsGeneratedAt, '2026-11-18T01:06:47.596Z');
  assert.equal(records.hub.analyticsGeneratedAt, null);
  assert.equal(records.msk.commit, C1);
  assert.deepEqual(first.map(({ key }) => key), first.map(({ site: id, digest: built }) => markerKey(id, built, CHECKS[id])));

  // The hosts now serve those records and every check passed but preclinical's.
  // One app of msk changes, and microscopy's deploy had failed.
  const { lookup } = store(first.filter(({ site: id }) => id !== 'preclinical').map(({ key }) => key));
  const served = async (url) => {
    const id = deploySites(registry).find(({ host }) => url.startsWith(`https://${host}/`)).site;
    if (id === 'microscopy') return json({ ...records.microscopy, digest: 'f'.repeat(64) });
    return json(records[id]);
  };
  await put(join(root, 'msk'), 'app/assets/model.wasm', 'new model');
  const second = await planDeploy({ registry, sitesDir: root, commit: C2, checks: CHECKS, lookup, nonce: 'n', fetch: served, write });
  const decision = Object.fromEntries(second.map(({ site, publish, reason }) => [site, publish ? reason : 'skip']));
  assert.deepEqual(decision, {
    neuro: 'skip', msk: 'content changed', microscopy: 'content changed', preclinical: 'no verified marker for this content and these checks', hub: 'skip',
  });
  const outputs = deployOutputs(second);
  const sites = (ids) => JSON.stringify(ids.map((id) => ({ site: id, url: `https://${deploySites(registry).find(({ site: s }) => s === id).host}/` })));
  assert.deepEqual({ ...outputs, markers: undefined }, {
    pages: 'false',
    workers: sites(['msk', 'microscopy', 'preclinical']),
    verify: sites(['msk', 'microscopy', 'preclinical']),
    verify_hub: 'false',
    verify_build: 'true',
    markers: undefined,
  });
  assert.deepEqual(Object.keys(JSON.parse(outputs.markers)), ['msk', 'microscopy', 'preclinical']);
  // The record a site now carries does not change its digest.
  assert.equal(second.find(({ site: id }) => id === 'neuro').digest, records.neuro.digest);
  assert.equal(await siteDigest(join(root, 'neuro')), records.neuro.digest);

  const summary = deploySummary(second);
  for (const { site: id, host } of deploySites(registry)) assert.match(summary, new RegExp(`\\| ${id} \\| ${host} \\| (publish|skip) \\| `));
  assert.match(summary, /\| Site \| Host \| Decision \| Deployed checks \| Why \| Verified marker \| Build digest \| Live digest \| Live commit \|/);
  assert.match(summary, /\| neuro \| webapps\.neurodesk\.org \| skip \| - \| verified: [^|]* \| found \|/);
  assert.match(summary, /\| msk \| mskapps\.sciget\.org \| publish \| after publish \| content changed \| none \|/);
  assert.match(summary, /\| preclinical \| preclinicalapps\.sciget\.org \| publish \| after publish \| no verified marker for this content and these checks \| none \|/);
});

test('a deploy whose content is all live and verified publishes nothing and skips the build\'s browser checks', async (t) => {
  const { root, plan } = await verifiedFixture(t);
  assert.deepEqual(deployOutputs(await plan()), { pages: 'false', workers: '[]', verify: '[]', verify_hub: 'false', verify_build: 'false', markers: '{}' });
  // The next day's scheduled run refreshes every catalogue's usage report, not the hub, and needs no browser check.
  for (const { site: id } of deploySites(registry).filter(({ site: s }) => s !== 'hub')) await put(join(root, id), 'analytics.json', report('2026-11-19T04:24:00Z'));
  const daily = await plan();
  assert.deepEqual(daily.filter(({ publish }) => publish).map(({ site: id }) => id), registry.site.catalogs.map(({ id }) => id));
  assert.equal(deployOutputs(daily).verify_build, 'false');
  assert.equal(deployOutputs(daily).pages, 'true');
  // A dispatched run publishes and checks everything.
  const dispatched = await plan({ deployAll: true });
  assert.ok(dispatched.every(({ publish, verifyBuild, verify }) => publish && verifyBuild && verify));
});

// The deploy workflow over several runs, with the real plan: hosts that serve
// what the last successful publish of each site sent, and the marker store of
// main. A run publishes what its plan says (the Worker sites, then Pages only
// when every Worker deploy passed), runs the checks of each site it checks,
// and saves a site's marker as the check job does: when every check passed and
// the host served this build's digest before and after them. `failChecks`
// fail those sites' checks, `failDeploys` their deploys, and `lagging` sites
// keep serving their old bytes until the checks are over.
function deployWorld(root) {
  const hosts = new Map();
  const markers = new Set();
  const state = { storeDown: false };
  const fetch = async (url) => {
    const served = hosts.get(new URL(url).host);
    return served ? json(served) : new Response('Not found', { status: 404 });
  };
  const lookup = async (key) => (state.storeDown ? { error: 'GitHub API: HTTP 503' } : { present: markers.has(key) });
  // One check job: confirm, the checks, confirm, keep or save the marker.
  const check = ({ host, digest: built, key }, { fails = false } = {}) => {
    const before = hosts.get(host)?.digest === built;
    if (fails) return 'failure';
    if (key && before && hosts.get(host)?.digest === built) markers.add(key);
    return 'success';
  };
  async function run({ event = 'push', checks = CHECKS, failChecks = [], failDeploys = [], lagging = [] } = {}) {
    const planned = await planDeploy({ registry, sitesDir: root, commit: C1, deployAll: event === 'dispatch', verifyAll: event === 'schedule', checks, lookup, nonce: 'n', fetch, write: writeFile });
    const late = [];
    const publish = (entry) => (lagging.includes(entry.site) ? late.push(entry) : hosts.set(entry.host, entry.record));
    const workers = planned.filter(({ hosting, publish: published }) => hosting === 'worker' && published);
    for (const entry of workers) if (!failDeploys.includes(entry.site)) publish(entry);
    const workersPassed = workers.every(({ site: id }) => !failDeploys.includes(id));
    const pages = planned.find(({ hosting }) => hosting === 'pages');
    const pagesPassed = !(pages.publish && failDeploys.includes(pages.site));
    if (workersPassed && pages.publish && pagesPassed) publish(pages);
    const checked = {};
    if (workersPassed) {
      for (const entry of planned.filter(({ verify }) => verify)) {
        if (entry.hosting === 'pages' && entry.publish && !pagesPassed) continue;
        checked[entry.site] = check(entry, { fails: failChecks.includes(entry.site) });
      }
    }
    for (const entry of late) hosts.set(entry.host, entry.record);
    return { planned, checked, published: planned.filter(({ publish: published }) => published).map(({ site: id }) => id), rerunCheck: (id) => check(planned.find(({ site: s }) => s === id)) };
  }
  return { hosts, markers, state, run };
}
const everySite = deploySites(registry).map(({ site: id }) => id);

test('a site whose check failed is checked again by the next run, and skipped once a check passed', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  // The first run after the merge: nothing is verified, so everything is published and checked.
  const first = await world.run({ failChecks: ['msk'] });
  assert.deepEqual(first.published, everySite);
  assert.equal(first.checked.msk, 'failure');
  // No change: the sites that passed are skipped; msk is published and checked again.
  const second = await world.run();
  assert.deepEqual(second.published, ['msk']);
  assert.deepEqual(second.checked, { msk: 'success' });
  assert.equal(second.planned.find(({ site: id }) => id === 'msk').verifyBuild, false, 'its bytes passed the build\'s checks when they were first published');
  // No change, and every check has passed: nothing runs.
  assert.deepEqual((await world.run()).published, []);
});

test('a re-run of an older run\'s hub check cannot hide a newer failed check', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  await world.run();
  // Run A changes the hub; its hub check fails.
  await put(join(root, 'hub'), 'index.html', '<!doctype html><title>hub 2</title>');
  const a = await world.run({ failChecks: ['hub'] });
  assert.deepEqual(a.published, ['hub']);
  assert.deepEqual(a.checked, { hub: 'failure' });
  // Run B changes msk; msk's check fails, and the hub, still unverified, is published and checked again and fails.
  await put(join(root, 'msk'), 'app/new.js', '');
  const b = await world.run({ failChecks: ['msk', 'hub'] });
  assert.deepEqual(b.published, ['msk', 'hub']);
  assert.deepEqual(b.checked, { msk: 'failure', hub: 'failure' });
  // Someone re-runs only A's hub check, and it passes: it marks the hub at A's digest, which the host still serves.
  assert.equal(a.rerunCheck('hub'), 'success');
  // The next run skips the hub but still publishes and checks msk.
  const c = await world.run();
  assert.deepEqual(c.published, ['msk']);
  assert.deepEqual(c.checked, { msk: 'success' });
  assert.deepEqual((await world.run()).published, []);
});

test('"Re-run failed jobs" after a failed check saves its marker, and the next run skips the site', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  await world.run();
  await put(join(root, 'preclinical'), 'app/new.js', '');
  const failed = await world.run({ failChecks: ['preclinical'] });
  assert.deepEqual(failed.checked, { preclinical: 'failure' });
  assert.equal(failed.rerunCheck('preclinical'), 'success');
  assert.deepEqual((await world.run()).published, []);
});

test('a failed deploy, a check that saw older bytes or a lost marker is published and checked again', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  await world.run();
  // msk's Worker deploy fails: no check runs, and the next run publishes msk again.
  await put(join(root, 'msk'), 'app/new.js', '');
  const failedDeploy = await world.run({ failDeploys: ['msk'] });
  assert.deepEqual(failedDeploy.checked, {});
  const retried = await world.run();
  assert.deepEqual(retried.published, ['msk']);
  assert.deepEqual(retried.checked, { msk: 'success' });
  // preclinical's host still serves its old bytes while the checks run: they pass, but mark nothing.
  await put(join(root, 'preclinical'), 'app/new.js', '');
  const lag = await world.run({ lagging: ['preclinical'] });
  assert.deepEqual(lag.checked, { preclinical: 'success' });
  const after = await world.run();
  assert.deepEqual(after.published, ['preclinical'], 'its digest is live now, but unverified');
  assert.equal(after.planned.find(({ site: id }) => id === 'preclinical').reason, 'no verified marker for this content and these checks');
  // The cache evicts neuro's marker: the next run publishes and checks neuro once.
  world.markers.delete(after.planned.find(({ site: id }) => id === 'neuro').key);
  assert.deepEqual((await world.run()).published, ['neuro']);
  assert.deepEqual((await world.run()).published, []);
});

test('changed check scripts check every site again, and an unreachable marker store publishes and checks every site', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  await world.run();
  assert.deepEqual((await world.run()).published, []);
  const changed = await world.run({ checks: CHECKS_2 });
  assert.deepEqual(changed.published, everySite);
  assert.deepEqual(Object.keys(changed.checked), everySite);
  assert.ok(changed.planned.every(({ verifyBuild }) => !verifyBuild), 'the content is what the hosts serve');
  assert.deepEqual((await world.run({ checks: CHECKS_2 })).published, []);
  // The cache API fails.
  world.state.storeDown = true;
  const down = await world.run({ checks: CHECKS_2 });
  assert.deepEqual(down.published, everySite);
  assert.deepEqual(Object.keys(down.checked), everySite);
  assert.ok(down.planned.every(({ reason }) => reason === 'marker unknown (GitHub API: HTTP 503)'));
});

test('the daily run checks every live site and restores the markers it lacks; a dispatch publishes and checks every site', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = deployWorld(root);
  await world.run();
  const keys = [...world.markers];
  world.markers.delete(keys[1]);
  const daily = await world.run({ event: 'schedule' });
  assert.deepEqual(Object.keys(daily.checked), everySite);
  assert.deepEqual(daily.published, [everySite[1]], 'only the site without a marker is published');
  assert.deepEqual([...world.markers].sort(), [...keys].sort());
  const dispatched = await world.run({ event: 'dispatch' });
  assert.deepEqual(dispatched.published, everySite);
  assert.deepEqual(Object.keys(dispatched.checked), everySite);
});

const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
// A GitHub expression of `needs`, `steps`, `matrix` and status functions, evaluated as JavaScript.
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
  // The plan looks up markers with the run's token. Its reads end by their deadlines; the step limit is a backstop.
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
  assert.deepEqual(workflow.jobs.build.outputs, Object.fromEntries(['pages', 'workers', 'verify', 'verify_hub', 'markers'].map((key) => [key, `\${{ steps.plan.outputs.${key} }}`])));
});

// The jobs that check a site against its host, and the site each checks: verify-sites one per matrix entry.
const CHECK_JOBS = { deploy: registry.site.catalogs.find(({ hosting }) => hosting === 'pages').id, 'verify-hub': 'hub', 'verify-sites': null };

test('each check job confirms the digest before and after its checks, and only then keeps or saves the marker', () => {
  for (const [name, fixed] of Object.entries(CHECK_JOBS)) {
    const job = workflow.jobs[name];
    const site = fixed ?? 'msk';
    const index = (id) => job.steps.findIndex((step) => step.id === id);
    const [before, after, kept] = ['before', 'after', 'kept'].map(index);
    const save = job.steps.findIndex((step) => step.uses === 'actions/cache/save@v6');
    assert.ok(before >= 0 && before < after && after < kept && kept < save && save === job.steps.length - 1, `${name}: confirm, checks, confirm, keep, save`);
    const checks = job.steps.slice(before + 1, after);
    assert.ok(checks.length > 0, `${name} checks between its confirmations`);
    // Every check runs for every site; only a status function could let a later step run after a failed one.
    for (const step of checks) assert.ok(step.if === undefined && step['continue-on-error'] === undefined, `${name}: ${step.name} always runs and can fail the job`);
    for (const step of job.steps.slice(after)) assert.doesNotMatch(String(step.if), /\b(always|failure|cancelled)\(\)/, `${name}: ${step.name} runs only after every check passed`);
    for (const step of job.steps.slice(0, before)) assert.doesNotMatch(String(step.run ?? ''), /test:|smoke/, `${name}: no check runs before the first confirmation`);
    const confirm = (step) => step.run.match(/^node scripts\/confirm-site-digest\.mjs --url "\$(\w+)" --site (\S+) --digest "\$SITE_DIGEST"( --marker deploy-verified\.json)?$/);
    const [, urlVariable, siteArgument, beforeMarker] = confirm(job.steps[before]);
    const [, afterUrl, afterSite, afterMarker] = confirm(job.steps[after]);
    assert.deepEqual([afterUrl, afterSite, beforeMarker, afterMarker], [urlVariable, siteArgument, undefined, ' --marker deploy-verified.json']);
    assert.equal(siteArgument, name === 'verify-hub' ? 'hub' : '"$SITE_CATALOG"');
    assert.equal(job.steps[before].if, "env.SITE_MARKER != ''");
    assert.equal(job.steps[after].if, "steps.before.outputs.confirmed == 'true'");
    assert.equal(job.steps[kept].if, "steps.after.outputs.confirmed == 'true'");
    assert.equal(job.steps[save].if, "steps.after.outputs.confirmed == 'true' && steps.kept.outputs.cache-hit != 'true'");
    assert.equal(job.steps[kept].uses, 'actions/cache/restore@v6');
    for (const step of [job.steps[kept], job.steps[save]]) {
      assert.deepEqual(step.with, { path: 'deploy-verified.json', key: '${{ env.SITE_MARKER }}' }, `${name}: ${step.name}`);
      assert.equal(step['continue-on-error'], true, `${name}: ${step.name} cannot fail checks that passed`);
    }
    // The digest and key come from the build's plan for this job's site.
    const lookup = fixed ? `.${fixed}` : '[matrix.site]';
    assert.equal(job.env.SITE_DIGEST, `\${{ fromJSON(needs.build.outputs.markers)${lookup}.digest }}`);
    assert.equal(job.env.SITE_MARKER, `\${{ fromJSON(needs.build.outputs.markers)${lookup}.key }}`);
    const markers = { [site]: { url: 'https://h/', digest, key: KEY } };
    const context = { needs: { build: { outputs: { markers: JSON.stringify(markers) } } }, matrix: { site } };
    assert.equal(expression(job.env.SITE_DIGEST, context), digest);
    assert.equal(expression(job.env.SITE_MARKER, context), KEY);
  }
  assert.equal(workflow.jobs['verify-hub'].env.SITE_URL, '${{ fromJSON(needs.build.outputs.markers).hub.url }}');
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
      // Each check job gets its site's digest and marker key.
      if (name === 'verify-sites') {
        for (const entry of matrix) assert.ok(expression(job.env.SITE_MARKER, { ...context, matrix: entry }).startsWith(MARKER_PREFIX), `${entry.site} has a marker key`);
      }
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
  const { root, markers, served, lookup, plan } = await verifiedFixture(t);
  const withoutMsk = async (key) => (key.startsWith(`${MARKER_PREFIX}msk-`) ? { present: false } : lookup(key));
  const unreadable = (host) => async (url) => (new URL(url).host === host ? missing() : served(url));
  const cases = {
    'nothing changed, markers present': await plan(),
    'nothing changed, msk marker absent': await plan({ lookup: withoutMsk }),
    'one site changed': await (async () => {
      await put(join(root, 'msk'), 'app/new.js', '');
      const planned = await plan();
      await rm(join(root, 'msk', 'app/new.js'));
      return planned;
    })(),
    'scheduled run, every digest live and verified': await plan({ verifyAll: true }),
    'dispatched run': await plan({ deployAll: true }),
    'unreadable record for one site': await plan({ fetch: unreadable('webapps.neurodesk.org') }),
    'marker store unreachable': await plan({ lookup: async () => ({ error: 'GitHub API: HTTP 503' }) }),
    'first run after the merge': await plan({ fetch: missing, lookup: absent }),
  };
  assert.ok(markers.size === deploySites(registry).length);
  const table = Object.fromEntries(Object.entries(cases).map(([name, planned]) => {
    const outputs = deployOutputs(planned);
    const results = simulate(outputs);
    assert.ok(greenRun(results), name);
    return [name, { outputs: `pages=${outputs.pages} workers=${JSON.parse(outputs.workers).map(({ site: id }) => id)} verify=${JSON.parse(outputs.verify).map(({ site: id }) => id)} hub=${outputs.verify_hub} startup=${outputs.verify_build}`, ran: ran(results) }];
  }));
  const all = { outputs: 'pages=true workers=msk,microscopy,preclinical,hub verify=msk,microscopy,preclinical hub=true startup=true', ran: JOB_ORDER.join(' ') };
  assert.deepEqual(table, {
    'nothing changed, markers present': { outputs: 'pages=false workers= verify= hub=false startup=false', ran: 'build turbo-cache-retention' },
    'nothing changed, msk marker absent': { outputs: 'pages=false workers=msk verify=msk hub=false startup=false', ran: 'build turbo-cache-retention deploy-workers verify-sites' },
    'one site changed': { outputs: 'pages=false workers=msk verify=msk hub=false startup=true', ran: 'build turbo-cache-retention deploy-workers verify-sites' },
    'scheduled run, every digest live and verified': { outputs: 'pages=false workers= verify=neuro,msk,microscopy,preclinical hub=true startup=false', ran: 'build turbo-cache-retention verify-hub verify-sites' },
    'dispatched run': all,
    'unreadable record for one site': { outputs: 'pages=true workers= verify= hub=false startup=true', ran: 'build turbo-cache-retention deploy' },
    'marker store unreachable': { ...all, outputs: all.outputs.replace('startup=true', 'startup=false') },
    'first run after the merge': all,
  });
  // "Re-run failed jobs" after msk's check failed: the build is not re-run and keeps its
  // outputs, so the check runs again on the sites the first attempt published, with the same marker key.
  const outputs = deployOutputs(cases['one site changed']);
  const firstAttempt = simulate(outputs, ['verify-sites']);
  assert.equal(greenRun(firstAttempt), false);
  const rerun = rerunFailed(outputs, firstAttempt);
  assert.equal(rerun.ran, 'verify-sites');
  assert.equal(greenRun(rerun.results), true);
  assert.deepEqual(JSON.parse(outputs.verify).map(({ site: id }) => id), ['msk']);
  assert.equal(JSON.parse(outputs.markers).msk.key, cases['one site changed'].find(({ site: id }) => id === 'msk').key);
  // A failed Worker deploy re-runs with every job that waited for it.
  const workersFailed = simulate(outputs, ['deploy-workers']);
  assert.equal(rerunFailed(outputs, workersFailed).ran, 'deploy-workers verify-sites');
});

test('a failed Worker deploy holds back the Pages deploy and every check, and a failed build stops everything', () => {
  const outputs = { pages: 'true', workers: '[{"site":"msk"},{"site":"hub"}]', verify: '[{"site":"msk"}]', verify_hub: 'true', verify_build: 'true', markers: JSON.stringify({ msk: { key: KEY } }) };
  assert.equal(ran(simulate(outputs, ['deploy-workers'])), 'build turbo-cache-retention deploy-workers');
  assert.equal(ran(simulate(outputs, ['build'])), 'build');
  // The checks of the live hosts do not wait for the Pages deploy, which checks neuro itself.
  assert.deepEqual(workflow.jobs['verify-sites'].needs, ['build', 'deploy-workers']);
  assert.deepEqual(workflow.jobs['verify-hub'].needs, ['build', 'deploy-workers']);
  assert.deepEqual(workflow.jobs.deploy.needs, ['build', 'deploy-workers']);
  assert.deepEqual(Object.keys(workflow.jobs['verify-sites'].env), ['BASE_URL', 'SITE_CATALOG', 'SITE_DIGEST', 'SITE_MARKER']);
  assert.deepEqual({ BASE_URL: workflow.jobs['verify-sites'].env.BASE_URL, SITE_CATALOG: workflow.jobs['verify-sites'].env.SITE_CATALOG }, { BASE_URL: '${{ matrix.url }}', SITE_CATALOG: '${{ matrix.site }}' });
});
