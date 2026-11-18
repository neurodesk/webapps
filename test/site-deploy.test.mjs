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
  HUB_CHECKS,
  MARKER_PREFIX,
  SITE_PROBE,
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
  siteDigest,
} from '../scripts/lib/site-deploy.mjs';
import { deleteMarker, readMarker } from '../scripts/lib/site-marker.mjs';
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
  // With no digest there is nothing to confirm and no marker to save.
  assert.deepEqual(JSON.parse(outputs.verify), [{ site: 'microscopy', url: 'https://microscopyapps.sciget.org/', digest: '', key: '', published: true }]);
  assert.equal(outputs.verify_build, 'true');
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
  // More than one page is unknown even with the marker on the first page.
  assert.deepEqual(await read({ total_count: 101, actions_caches: [cacheEntry()] }), { error: 'GitHub API: 101 caches match, more than one page' });
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
  assert.deepEqual(JSON.parse(result.outputs.hub).map(({ site: id }) => id), ['hub']);
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
    assert.deepEqual(JSON.parse(outputs.hub).map(({ site: id, published }) => [id, published]), [['hub', true]], name);
    assert.equal(outputs.verify_build, 'true', name);
    // Each check leg gets its site's digest and marker key.
    assert.deepEqual(JSON.parse(outputs.verify).map(({ site: id, digest: built, key }) => [id, /^[0-9a-f]{64}$/.test(built), key.startsWith(MARKER_PREFIX)]), registry.site.catalogs.map(({ id }) => [id, true, true]), name);
  }
});

test('the confirm command marks a digest only when the host serves it, flags a publish that did not take, and never fails the step', { timeout: 60_000 }, async (t) => {
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

  // This run published the site: a host that does not serve the build flags the
  // publish as untaken, and the leg fails once its checks have run.
  const untaken = await confirm([...args('b'.repeat(64)), '--published', 'true']);
  assert.deepEqual({ code: untaken.code, outputs: untaken.outputs }, { code: 0, outputs: { untaken: 'true', confirmed: 'false' } }, untaken.stderr);
  assert.match(untaken.stdout, /^::error::mskapps\.sciget\.org serves digest a{64}, not msk at b{64}: this run published it, so the publish did not take\.$/m);
  const taken = await confirm([...args(digest), '--published', 'true']);
  assert.deepEqual(taken.outputs, { confirmed: 'true' });
  await rm(marker);
  // Without a digest (the site's plan failed) there is nothing to confirm.
  assert.deepEqual((await confirm(['--url', 'https://mskapps.sciget.org/', '--site', 'msk', '--digest', '', '--published', 'true'])).outputs, { confirmed: 'false' });
  assert.deepEqual((await confirm([...args('b'.repeat(64)), '--published', 'false'])).outputs, { confirmed: 'false' });

  // A host that stalls is unconfirmed by the deadline (0.3 s under the preload).
  const stalled = await answeringServer(t, { status: 200, type: 'application/json', trickle: true });
  const slow = await command(t, root, stalled.port, 'scripts/confirm-site-digest.mjs', args(digest));
  assert.deepEqual({ code: slow.code, signal: slow.signal, outputs: slow.outputs }, { code: 0, signal: null, outputs: { confirmed: 'false' } }, slow.stderr);
  // The message names the configured deadline; the preload ended it at 0.3 s.
  assert.match(slow.stdout, /no readable record \(no complete answer in 30 s\)/);
  assert.ok(slow.ms < 5000, `ended after ${Math.round(slow.ms)} ms`);
});

test('the confirm and delete commands load only Node built-ins, so the hub check needs no install', async () => {
  const closure = moduleClosure(repoRoot, ['scripts/confirm-site-digest.mjs', 'scripts/revoke-site-marker.mjs']);
  assert.deepEqual(closure, ['scripts/confirm-site-digest.mjs', 'scripts/lib/site-marker.mjs', 'scripts/lib/site-record.mjs', 'scripts/revoke-site-marker.mjs']);
  for (const file of closure) {
    for (const [, specifier] of (await readFile(join(repoRoot, file), 'utf8')).matchAll(/\bfrom\s+'([^']+)'/g)) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
  const hub = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8')).jobs['verify-hub'];
  assert.deepEqual(hub.steps[0], { uses: 'actions/checkout@v7', with: { 'sparse-checkout': 'scripts', 'persist-credentials': false } });
});

// Install npm package `name` at `version` in pnpm's layout: its files in the
// store directory `store` under node_modules/.pnpm, and each dependency linked
// beside it. Returns the package's directory in the store.
async function storePackage(root, { name, version, store = `${name.replace('/', '+')}@${version}`, dependencies = {}, optional = {} }) {
  const dir = join(root, 'node_modules/.pnpm', store, 'node_modules', name);
  await put(dir, 'package.json', JSON.stringify({ name, version, dependencies: Object.fromEntries(Object.keys(dependencies).map((dependency) => [dependency, '*'])), optionalDependencies: optional }));
  for (const [dependency, target] of Object.entries(dependencies)) {
    const link = join(root, 'node_modules/.pnpm', store, 'node_modules', dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link);
  }
  return dir;
}

// A copy of the files the deployed checks read, with the npm packages they
// import installed in pnpm's layout, under a temporary root. `playwrightCore`
// is the store directory of the playwright-core that playwright links.
async function checksFixture(t, { playwrightCore = 'playwright-core@1.64.0' } = {}) {
  const root = await tempDir(t);
  const inputs = checkInputs(repoRoot, registry);
  for (const path of new Set(Object.values(inputs).flatMap(({ files }) => files))) await cp(join(repoRoot, path), join(root, path));
  await mkdir(join(root, 'exes'), { recursive: true });
  const [core, coreVersion] = [playwrightCore, playwrightCore.match(/@([\d.]+)/)[1]];
  const coreDir = await storePackage(root, { name: 'playwright-core', version: coreVersion, store: core });
  const playwright = await storePackage(root, { name: 'playwright', version: '1.64.0', dependencies: { 'playwright-core': coreDir }, optional: { fsevents: '2.3.2' } });
  const test = await storePackage(root, { name: '@playwright/test', version: '1.64.0', dependencies: { playwright } });
  await mkdir(join(root, 'node_modules/@playwright'), { recursive: true });
  await symlink(test, join(root, 'node_modules/@playwright/test'));
  for (const [name, version] of [['yaml', '2.9.0'], ['zod', '4.6.5']]) await symlink(await storePackage(root, { name, version }), join(root, 'node_modules', name));
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
  assert.deepEqual(inputs.hub, { files: [DEPLOY_WORKFLOW, ...HUB_CHECKS].sort(), packages: [] }, 'the hub\'s checks are the probe and a step of the workflow');
  for (const path of [...DEPLOYED_CHECKS, ...CHECK_DATA, 'test-utils/site-catalog.mjs', 'scripts/lib/apps-registry.mjs', 'packages/components/package.json']) {
    assert.ok(inputs.msk.files.includes(path), `${path} is a check input`);
  }
  // The packages the checks import, and what they depend on, by store directory; fsevents is optional and absent.
  assert.deepEqual(inputs.msk.packages, [
    '@playwright/test@1.64.0 (@playwright+test@1.64.0)',
    'playwright-core@1.64.0 (playwright-core@1.64.0)',
    'playwright@1.64.0 (playwright@1.64.0)',
    'yaml@2.9.0 (yaml@2.9.0)',
    'zod@4.6.5 (zod@4.6.5)',
  ]);
  // An app served by one catalogue only.
  const single = registry.apps.find((app) => registry.site.catalogs.filter((catalog) => catalogApps(registry, findCatalog(registry, catalog.id)).includes(app)).length === 1);
  const changed = (hashes) => Object.keys(base).filter((id) => hashes[id] !== base[id]).join(' ');
  const catalogues = registry.site.catalogs.map(({ id }) => id).join(' ');
  for (const [name, change, expected, options] of [
    ['a check script', (dir) => put(dir, 'test/image-upload.smoke.mjs', '// changed\n'), catalogues],
    ['a module a check imports', (dir) => put(dir, 'test-utils/site-catalog.mjs', '// changed\n'), catalogues],
    ['the landing page probe', (dir) => put(dir, SITE_PROBE, '// changed\n'), `hub ${catalogues}`],
    // The digest confirmation and the marker steps decide which marker is saved, not whether a check passes.
    ['the record reader', (dir) => put(dir, 'scripts/lib/site-record.mjs', '// changed\n'), ''],
    ['the app registry', (dir) => put(dir, 'registry/apps.yml', '# changed\n'), catalogues],
    ['the standalone catalog', (dir) => put(dir, 'registry/standalone.json', '{}'), catalogues],
    ['the root scripts', (dir) => put(dir, 'package.json', '{}'), catalogues],
    [`the package.json of ${single.id}`, (dir) => put(dir, `apps/${single.id}/package.json`, '{}'), single.catalog],
    ['the installed @playwright/test', async (dir) => put(dir, 'node_modules/.pnpm/@playwright+test@1.64.0/node_modules/@playwright/test/package.json', '{"version":"1.65.0","dependencies":{"playwright":"*"}}'), catalogues],
    ['an override of playwright-core', async () => {}, catalogues, { playwrightCore: 'playwright-core@1.64.1' }],
    ['a patch of playwright-core', async () => {}, catalogues, { playwrightCore: 'playwright-core@1.64.0_patch_hash=4f2c' }],
    ['the workflow', (dir) => put(dir, DEPLOY_WORKFLOW, '# changed\n'), `hub ${catalogues}`],
    ['a deleted check script', (dir) => rm(join(dir, 'test/deployed-site.smoke.mjs')), catalogues],
    ['a file no check reads', (dir) => put(dir, 'apps/no-check/src/main.js', '// new\n'), ''],
  ]) {
    const dir = await checksFixture(t, options);
    await change(dir);
    assert.equal(changed(checkHashes(dir, registry)), expected, name);
  }
});

test('the check scripts the hash covers are the ones the workflow\'s check steps run', async () => {
  const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
  const scripts = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).scripts;
  const between = (name) => {
    const steps = workflow.jobs[name].steps;
    const before = steps.findIndex(({ id }) => id === 'before');
    const after = steps.findIndex(({ id }) => id === 'after');
    return steps.slice(before + 1, after);
  };
  const script = (run) => run.replace(/^pnpm (\S+)$/, (whole, name) => scripts[name]).match(/^(?:node|bash) (\S+)/)?.[1];
  assert.deepEqual(between('verify-sites').map(({ run }) => script(run)).sort(), [...DEPLOYED_CHECKS].sort(), 'verify-sites runs exactly the deployed checks between its confirmations');
  // The hub's checks: the probe, then the hub check, a step of the workflow the hash covers.
  const hub = between('verify-hub');
  assert.deepEqual(hub.map(({ id }) => id), ['answers', 'links']);
  assert.deepEqual(hub.map(({ run }) => script(run)).filter(Boolean), HUB_CHECKS);
});

// The landing page probe of the base workflow, whose flags the probe keeps.
const BASE_PROBE = 'curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 15 --output /dev/null';

test('one probe, the base\'s curl command with a deadline per try, checks a landing page after each publish and in every check leg', async () => {
  const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
  const probes = Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps.filter(({ run }) => run?.includes(SITE_PROBE) || (/curl/.test(run ?? '') && !/hub does not link/.test(run))).map((step) => [job, step]));
  assert.deepEqual(probes.map(([job, step]) => [job, step.id, step.run]), [
    ['deploy', 'answers', `bash ${SITE_PROBE} "$SITE_URL"`],
    ['deploy-workers', 'answers', `bash ${SITE_PROBE} "$SITE_URL"`],
    ['verify-hub', 'answers', `bash ${SITE_PROBE} "$SITE_URL"`],
    ['verify-sites', 'answers', `bash ${SITE_PROBE} "$BASE_URL"`],
  ]);
  assert.ok(probes.every(([, step]) => step['timeout-minutes'] === undefined), 'curl\'s own limits end the probe, so a failure is a failed step');
  assert.equal(workflow.jobs['deploy-workers'].steps.find(({ id }) => id === 'answers').env.SITE_URL, '${{ matrix.url }}');
  assert.equal(workflow.jobs.deploy.steps.find(({ id }) => id === 'answers').env.SITE_URL, '${{ steps.deployment.outputs.page_url }}');
  assert.equal(workflow.jobs['verify-sites'].env.BASE_URL, '${{ matrix.url }}');
  assert.equal(workflow.jobs['verify-hub'].env.SITE_URL, '${{ matrix.url }}');
  const command = (await readFile(join(repoRoot, SITE_PROBE), 'utf8')).split('\n').filter((line) => line.startsWith('exec '));
  assert.deepEqual(command, [`exec ${BASE_PROBE.replace(' --output', ' --max-time 30 --output')} "\${1:?usage: check-site-answers.sh <site URL>}"`]);
});

// A loopback server that answers its requests in turn with `answers`
// ({ status, headers }), repeating the last one.
async function answersServer(t, answers) {
  const requests = [];
  const server = createServer((request, response) => {
    const { status, headers = {} } = answers[Math.min(requests.length, answers.length - 1)];
    requests.push(performance.now());
    response.writeHead(status, { 'content-type': 'text/html', ...headers });
    response.end('<!doctype html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, requests };
}

const probeCommand = async (url) => {
  const child = spawn('bash', [join(repoRoot, SITE_PROBE), ...(url ? [url] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stderr };
};

test('the probe passes on an answer below HTTP 400, retries as the host asks, and fails the step when the site keeps failing', { timeout: 60_000 }, async (t) => {
  const up = await answersServer(t, [{ status: 200 }]);
  assert.deepEqual(await probeCommand(up.url), { code: 0, stderr: '' });
  assert.equal(up.requests.length, 1);
  // curl --fail counts a redirect as an answer and does not follow it.
  const moved = await answersServer(t, [{ status: 302, headers: { location: '/elsewhere' } }]);
  assert.equal((await probeCommand(moved.url)).code, 0);
  assert.equal(moved.requests.length, 1);
  // curl waits as long as Retry-After asks before its next try.
  const recovering = await answersServer(t, [{ status: 503, headers: { 'retry-after': '1' } }, { status: 200 }]);
  assert.equal((await probeCommand(recovering.url)).code, 0);
  assert.equal(recovering.requests.length, 2);
  assert.ok(recovering.requests[1] - recovering.requests[0] >= 900, 'it waited for the host');
  // Eleven tries, then the step fails with curl's error.
  const down = await answersServer(t, [{ status: 503, headers: { 'retry-after': '1' } }]);
  const failed = await probeCommand(down.url);
  assert.equal(failed.code, 22);
  assert.match(failed.stderr, /The requested URL returned error: 503/);
  assert.equal(down.requests.length, 11);
  assert.notEqual((await probeCommand()).code, 0, 'a missing URL fails');
});

test('a marker delete removes the exact key on this ref, and anything it cannot confirm is an error', async () => {
  const requests = [];
  const api = (...answers) => async (url, init) => {
    requests.push({ url, init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return typeof next === 'function' ? next() : json(next.body, { status: next.status ?? 200 });
  };
  const remove = (fetch, fields = {}) => deleteMarker({ key: KEY, repository: 'neurodesk/webapps', ref: 'refs/heads/main', token: 't', fetch, ...fields });
  assert.deepEqual(await remove(api({ body: cacheList(cacheEntry()) })), { deleted: 1 });
  const { searchParams, pathname } = new URL(requests[0].url);
  assert.equal(requests[0].init.method, 'DELETE');
  assert.equal(pathname, '/repos/neurodesk/webapps/actions/caches');
  assert.deepEqual(Object.fromEntries(searchParams), { key: KEY, ref: 'refs/heads/main' });
  assert.equal(requests[0].init.signal.aborted, true, 'the request is aborted once the read ends');
  // The API documents only 200. A 404 is "nothing to delete" only when a lookup then finds no marker.
  assert.deepEqual(await remove(api({ status: 404, body: { message: 'Not Found' } }, { body: cacheList() })), { deleted: 0 });
  assert.deepEqual(await remove(api({ status: 404, body: { message: 'Not Found' } }, { body: cacheList(cacheEntry()) })), { error: 'HTTP 404, but the marker is still listed' });
  assert.deepEqual(await remove(api({ status: 404, body: {} }, { status: 500, body: {} })), { error: 'HTTP 404, then the marker could not be looked up (GitHub API: HTTP 500)' });
  assert.deepEqual(await remove(api({ status: 403, body: { message: 'Resource not accessible by integration' } })), { error: 'GitHub API: HTTP 403' });
  assert.deepEqual(await remove(api({ body: { message: 'no list' } })), { error: 'GitHub API: no list of deleted caches' });
  assert.deepEqual(await remove(async () => { throw new TypeError('fetch failed'); }), { error: 'fetch failed' });
  assert.deepEqual(await remove(api({ body: cacheList() }), { token: undefined }), { error: 'no key, repository, ref or token' });
});

test('the delete command reports its result in the job summary and fails the step when the delete fails', { timeout: 60_000 }, async (t) => {
  const root = await tempDir(t);
  const summary = join(root, 'summary.md');
  const revoke = async (status, body) => {
    const server = await answeringServer(t, { status, type: 'application/json', body: JSON.stringify(body), end: true });
    await writeFile(summary, '');
    const env = { ...PLAN_ENV, GITHUB_STEP_SUMMARY: summary, GITHUB_API_URL: 'https://api.github.com' };
    const result = await command(t, root, server.port, 'scripts/revoke-site-marker.mjs', ['--key', KEY], { env, scale: 1 });
    return { code: result.code, summary: await readFile(summary, 'utf8'), requests: server.requests };
  };
  const deleted = await revoke(200, cacheList(cacheEntry()));
  assert.equal(deleted.code, 0);
  assert.equal(deleted.summary, `Deleted the verified marker \`${KEY}\` of refs/heads/main: a check failed, so the next run checks this site again.\n`);
  assert.match(deleted.requests[0], new RegExp(`^/repos/neurodesk/webapps/actions/caches\\?key=${KEY}&ref=refs%2Fheads%2Fmain$`));
  const failed = await revoke(500, { message: 'Server Error' });
  assert.equal(failed.code, 1);
  assert.equal(failed.summary, `Could not delete the verified marker \`${KEY}\` of refs/heads/main: GitHub API: HTTP 500. A check failed in this run; the marker may remain until it is deleted by hand.\n`);
});

test('the daily run checks every live site, published or not', async (t) => {
  const { plan } = await verifiedFixture(t);
  // GA4 was unavailable, so no usage report is refreshed and nothing is published.
  const daily = await plan({ verifyAll: true });
  assert.ok(daily.every(({ publish, verify }) => !publish && verify));
  // Each check leg gets its site, the digest it must confirm and the marker it saves, keeps or deletes.
  const legs = daily.map(({ site: id, url, digest: built, key }) => ({ site: id, url, digest: built, key, published: false }));
  assert.deepEqual(deployOutputs(daily), {
    pages: 'false',
    workers: '[]',
    verify: JSON.stringify(legs.filter(({ site: id }) => id !== 'hub')),
    hub: JSON.stringify(legs.filter(({ site: id }) => id === 'hub')),
    verify_build: 'false',
  });
  assert.match(deploySummary(daily), /\| neuro \| webapps\.neurodesk\.org \| skip \| live site \| verified: [^|]* \| found \|/);
  // A push checks nothing it does not publish.
  const push = await plan();
  assert.deepEqual(deployOutputs(push), { pages: 'false', workers: '[]', verify: '[]', hub: '[]', verify_build: 'false' });
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
  const ids = ['msk', 'microscopy', 'preclinical'];
  const entry = (id) => second.find(({ site: s }) => s === id);
  assert.deepEqual(deployOutputs(second), {
    pages: 'false',
    workers: JSON.stringify(ids.map((id) => ({ site: id, url: entry(id).url }))),
    verify: JSON.stringify(ids.map((id) => ({ site: id, url: entry(id).url, digest: entry(id).digest, key: markerKey(id, entry(id).digest, CHECKS[id]), published: true }))),
    hub: '[]',
    verify_build: 'true',
  });
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
  assert.deepEqual(deployOutputs(await plan()), { pages: 'false', workers: '[]', verify: '[]', hub: '[]', verify_build: 'false' });
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

const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
// A GitHub expression of `needs`, `steps`, `matrix`, `env` and status functions, evaluated as JavaScript.
const expression = (source, context) => runInNewContext(
  String(source).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\.(\w+-[\w-]+)/g, '["$1"]').replace(/\bfromJSON\(/g, 'JSON.parse('),
  { cancelled: () => false, success: () => true, ...context },
);
const STATUS_FUNCTION = /\b(always|cancelled|failure|success)\(\)/;
const JOB_ORDER = ['build', 'turbo-cache-retention', 'deploy-workers', 'deploy', 'verify-hub', 'verify-sites'];
const CHECK_JOBS = ['verify-hub', 'verify-sites'];
const PAGES_SITE = registry.site.catalogs.find(({ hosting }) => hosting === 'pages').id;
// The steps that assert something about a site's public host, by id.
const ASSERTIONS = new Set(['answers', 'isolation', 'downloads', 'uploads', 'links']);

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
  assert.deepEqual(workflow.jobs.build.outputs, Object.fromEntries(['pages', 'workers', 'verify', 'hub'].map((key) => [key, `\${{ steps.plan.outputs.${key} }}`])));
});

// GitHub's text of a value in `env`: null and undefined are empty.
const text = (value) => (value === null || value === undefined ? '' : String(value));
const jobEnv = (job, context) => Object.fromEntries(Object.entries(job.env ?? {}).map(([name, value]) => [name, text(String(value).includes('${{') ? expression(value, { secrets: {}, ...context }) : value)]));

// Whether GitHub starts a job: its `if`, plus the implicit success() of every
// job it needs when the `if` has no status function.
function jobRuns(name, results, outputs, { cancelled = false } = {}) {
  const job = workflow.jobs[name];
  const needs = [job.needs ?? []].flat();
  const context = { cancelled: () => cancelled, needs: Object.fromEntries(needs.map((need) => [need, { result: results[need], outputs: need === 'build' ? outputs : {} }])) };
  const condition = job.if === undefined ? !cancelled : expression(String(job.if), context);
  const gated = job.if !== undefined && STATUS_FUNCTION.test(String(job.if));
  return { runs: Boolean(condition) && (gated || (!cancelled && needs.every((need) => results[need] === 'success'))), context };
}

// The steps GitHub runs in one job or matrix leg. A step whose `if` has no
// status function runs only when no earlier step failed and nothing was
// cancelled; a step that may continue on error fails nothing. `act(step)`
// performs a step and says whether it failed or was cancelled, and its outputs.
function runSteps(job, { env = {}, act = () => ({}) } = {}) {
  const steps = {};
  const ran = [];
  let failed = false;
  let cancelled = false;
  for (const step of job.steps) {
    const id = step.id ?? step.name ?? step.uses;
    const status = { success: () => !failed && !cancelled, failure: () => failed, always: () => true, cancelled: () => cancelled };
    const condition = step.if === undefined || expression(String(step.if), { env, steps, ...status });
    const runs = Boolean(condition) && (STATUS_FUNCTION.test(String(step.if ?? '')) || (!failed && !cancelled));
    if (!runs) {
      steps[id] = { outcome: 'skipped', outputs: {} };
      continue;
    }
    ran.push(id);
    const { fail = false, cancel = false, outputs = {} } = act(step) ?? {};
    steps[id] = { outcome: cancel ? 'cancelled' : fail ? 'failure' : 'success', outputs };
    if (cancel) cancelled = true;
    else if (fail && !step['continue-on-error']) failed = true;
  }
  return { result: cancelled ? 'cancelled' : failed ? 'failure' : 'success', ran, steps };
}

// One run of the workflow after its plan, job by job and leg by leg, with the
// workflow's own job and step conditions; only what each step does is a model.
// `world.hosts` maps each host to the record it serves and `world.markers` is
// the marker store. A scenario fails some sites' publishes (`failPublish`) or
// assertions (`failing`: site → step ids, or true for all of them), keeps
// `lagging` sites serving their old bytes until the checks are over, cancels
// every check leg at step `cancelAt`, or fails every marker delete
// (`deleteFails`). `previous`, a run's result, makes this "Re-run failed jobs"
// of it: the failed legs and every job after a re-run one run again.
function runWorkflow(planned, world, { failPublish = [], failing = {}, lagging = [], cancelAt, deleteFails = false } = {}, previous) {
  const outputs = deployOutputs(planned);
  const bySite = Object.fromEntries(planned.map((entry) => [entry.site, entry]));
  const results = { build: 'success' };
  const legs = previous ? structuredClone(previous.legs) : {};
  const summary = [];
  const late = new Map();
  const rerun = new Set();
  const serves = (site) => world.hosts.get(bySite[site].host);
  const publish = (site) => (lagging.includes(site) ? late.set(site, bySite[site].record) : world.hosts.set(bySite[site].host, bySite[site].record));
  const fails = (site, id) => failing[site] === true || (failing[site] ?? []).includes(id);
  for (const name of JOB_ORDER.slice(1)) {
    const job = workflow.jobs[name];
    const needs = [job.needs ?? []].flat();
    if (previous && previous.results[name] !== 'failure' && !needs.some((need) => rerun.has(need))) {
      results[name] = previous.results[name];
      continue;
    }
    if (previous) rerun.add(name);
    const { runs, context } = jobRuns(name, results, outputs);
    if (!runs) {
      results[name] = 'skipped';
      continue;
    }
    const matrix = job.strategy ? expression(job.strategy.matrix.include, context) : [{ site: name === 'deploy' ? PAGES_SITE : undefined }];
    assert.ok(Array.isArray(matrix) && matrix.length > 0, `${name} never runs with an empty matrix`);
    legs[name] ??= {};
    for (const leg of matrix) {
      const site = leg.site;
      if (previous && previous.results[name] === 'failure' && !needs.some((need) => rerun.has(need)) && legs[name][site]?.result !== 'failure') continue;
      const env = jobEnv(job, { ...context, matrix: leg });
      const act = (step) => {
        if (cancelAt && step.id === cancelAt && CHECK_JOBS.includes(name)) return { cancel: true };
        switch (step.id) {
          case 'deployment':
          case 'publish':
            if (failPublish.includes(site)) return { fail: true };
            publish(site);
            return {};
          case 'before': {
            const confirmed = env.SITE_DIGEST !== '' && serves(site)?.digest === env.SITE_DIGEST;
            return { outputs: { confirmed: String(confirmed), ...(!confirmed && env.SITE_PUBLISHED === 'true' && env.SITE_DIGEST !== '' ? { untaken: 'true' } : {}) } };
          }
          case 'after':
            return { outputs: { confirmed: String(env.SITE_DIGEST !== '' && serves(site)?.digest === env.SITE_DIGEST) } };
          case 'kept':
            return { outputs: { 'cache-hit': String(world.markers.has(env.SITE_MARKER)) } };
          case 'save':
            world.markers.add(env.SITE_MARKER);
            return {};
          case 'revoke':
            if (deleteFails) {
              summary.push(`${site}: could not delete its marker`);
              return { fail: true };
            }
            world.markers.delete(env.SITE_MARKER);
            summary.push(`${site}: deleted its marker`);
            return {};
          case 'untaken':
            return { fail: true };
          default:
            return ASSERTIONS.has(step.id) ? { fail: fails(site, step.id) } : {};
        }
      };
      legs[name][site] = runSteps(job, { env, act });
    }
    const legResults = Object.values(legs[name]).map(({ result }) => result);
    results[name] = legResults.includes('failure') ? 'failure' : legResults.includes('cancelled') ? 'cancelled' : 'success';
  }
  for (const [site, record] of late) world.hosts.set(bySite[site].host, record);
  const green = Object.values(results).every((result) => result === 'success' || result === 'skipped');
  return { outputs, results, legs, summary, green, ran: JOB_ORDER.filter((name) => results[name] !== 'skipped').join(' ') };
}

// Sites at C1 content, hosts that serve nothing yet and an empty marker store.
async function deployWorld(t) {
  const root = await tempDir(t);
  await sitesFixture(root);
  const world = { hosts: new Map(), markers: new Set(), storeDown: false };
  const fetch = async (url) => {
    const served = world.hosts.get(new URL(url).host);
    return served ? json(served) : missing();
  };
  const lookup = async (key) => (world.storeDown ? { error: 'GitHub API: HTTP 503' } : { present: world.markers.has(key) });
  const run = async ({ event = 'push', checks = CHECKS, ...scenario } = {}) => {
    const planned = await planDeploy({ registry, sitesDir: root, commit: C1, deployAll: event === 'dispatch', verifyAll: event === 'schedule', checks, lookup, nonce: 'n', fetch, write: writeFile });
    const result = runWorkflow(planned, world, scenario);
    const rerunFailed = (rescenario = {}) => runWorkflow(planned, world, rescenario, result);
    return { planned, published: planned.filter(({ publish }) => publish).map(({ site: id }) => id), key: (id) => planned.find(({ site: s }) => s === id).key, rerunFailed, ...result };
  };
  const change = (id) => put(join(root, id), 'app/new.js', `// ${Math.random()}\n`);
  return { root, world, run, change };
}
const everySite = deploySites(registry).map(({ site: id }) => id);
// The steps of one check leg that assert something about its site's host.
const assertionsOf = (name) => workflow.jobs[name].steps.filter(({ id }) => ASSERTIONS.has(id)).map(({ id }) => id);
const checkJobOf = (id) => (id === 'hub' ? 'verify-hub' : 'verify-sites');
// Every site the plan checked ran every assertion of its site in its own leg,
// except `failed`, whose leg stops at its first failed assertion.
function assertEverySiteFullyChecked(run, sites, failed) {
  for (const id of sites) {
    const leg = run.legs[checkJobOf(id)]?.[id];
    assert.ok(leg, `${id} has a check leg`);
    const assertions = assertionsOf(checkJobOf(id));
    const expected = id === failed ? assertions.slice(0, assertions.findIndex((step) => leg.steps[step].outcome === 'failure') + 1) : assertions;
    assert.ok(expected.length > 0, `${id} ran an assertion`);
    for (const step of expected) assert.ok(leg.ran.includes(step), `${id} ran ${step}`);
  }
}

test('the model knows every step of the publish and check jobs, and each check job deletes its marker on any of its assertions', () => {
  const modelled = new Set([...ASSERTIONS, 'deployment', 'publish', 'before', 'after', 'kept', 'save', 'revoke', 'untaken']);
  for (const name of ['deploy', 'deploy-workers', ...CHECK_JOBS]) {
    for (const step of workflow.jobs[name].steps) {
      const acts = Boolean(step.run) || /^actions\/(deploy-pages|cache)/.test(step.uses ?? '');
      const setup = /^(actions\/(checkout|setup-node|download-artifact)|pnpm\/action-setup)/.test(step.uses ?? '') || /^(pnpm install|sudo rm)/.test(step.run ?? '');
      assert.ok(setup || (acts && modelled.has(step.id)), `${name}: "${step.name ?? step.uses}" is a set-up step or one the model performs`);
    }
  }
  for (const name of CHECK_JOBS) {
    const steps = workflow.jobs[name].steps;
    const index = (id) => steps.findIndex((step) => step.id === id);
    const between = steps.slice(index('before') + 1, index('after'));
    assert.deepEqual(between.map(({ id }) => id), assertionsOf(name), `${name}: only assertions run between the confirmations`);
    const revoke = steps[index('revoke')];
    const listed = [...String(revoke.if).matchAll(/steps\.(\w+)\.outcome == 'failure'/g)].map(([, id]) => id);
    assert.deepEqual(listed, assertionsOf(name), `${name} deletes its marker when any of its assertions failed`);
  }
});

test('every check job starts once every publish has ended, whatever its result, whenever the plan selects a site', () => {
  const entry = (id) => ({ site: id, url: `https://${id}/`, digest, key: KEY, published: true });
  const outputs = { pages: 'true', workers: JSON.stringify([entry('msk')]), verify: JSON.stringify([entry('neuro'), entry('msk')]), hub: JSON.stringify([entry('hub')]), verify_build: 'true' };
  const publishes = ['success', 'failure', 'skipped'];
  for (const name of CHECK_JOBS) {
    for (const workers of publishes) {
      for (const pages of publishes) {
        const results = { build: 'success', 'turbo-cache-retention': 'success', 'deploy-workers': workers, deploy: pages };
        assert.equal(jobRuns(name, results, outputs).runs, true, `${name} after deploy-workers ${workers} and deploy ${pages}`);
      }
    }
    const done = { build: 'success', 'turbo-cache-retention': 'success', 'deploy-workers': 'success', deploy: 'success' };
    assert.equal(jobRuns(name, { ...done, build: 'failure' }, outputs).runs, false, 'a failed plan checks nothing');
    assert.equal(jobRuns(name, done, { ...outputs, verify: '[]', hub: '[]' }).runs, false, 'an empty matrix never starts');
    assert.equal(jobRuns(name, done, outputs, { cancelled: true }).runs, false, 'a cancelled run starts no check');
    assert.equal(workflow.jobs[name].strategy['fail-fast'], false, `${name}: one leg per site, none cancels another`);
    assert.deepEqual(workflow.jobs[name].permissions, { contents: 'read', actions: 'write' }, `${name} may delete markers`);
  }
  // Each check job waits for the publishes of the sites it checks.
  assert.deepEqual(workflow.jobs['verify-sites'].needs, ['build', 'deploy-workers', 'deploy']);
  assert.deepEqual(workflow.jobs['verify-hub'].needs, ['build', 'deploy-workers']);
  assert.equal(workflow.jobs['verify-sites'].strategy.matrix.include, '${{ fromJSON(needs.build.outputs.verify) }}');
  assert.equal(workflow.jobs['verify-hub'].strategy.matrix.include, '${{ fromJSON(needs.build.outputs.hub) }}');
  // The Pages deploy still waits for the Worker sites, so the neuro 404 page never redirects to a host that is not live.
  assert.equal(jobRuns('deploy', { build: 'success', 'deploy-workers': 'failure' }, outputs).runs, false);
  assert.equal(jobRuns('deploy', { build: 'success', 'deploy-workers': 'skipped' }, outputs).runs, true);
  // Only the check jobs may delete markers; the token reaches the delete step alone, and no checkout keeps it.
  // turbo-cache-retention, as at the base, deletes the superseded turbo-pages- caches and nothing else.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (CHECK_JOBS.includes(name) || job.permissions?.actions !== 'write') continue;
    assert.equal(name, 'turbo-cache-retention');
    assert.match(job.steps.map(({ run }) => run).join('\n'), /gh cache list --ref "\$CACHE_REF" --key turbo-pages- /);
  }
  assert.equal(workflow.permissions.actions, 'read');
  for (const name of CHECK_JOBS) {
    for (const step of workflow.jobs[name].steps) {
      if (step.uses?.startsWith('actions/checkout')) assert.equal(step.with['persist-credentials'], false, `${name} keeps no token in its checkout`);
      if (JSON.stringify(step).includes('github.token')) assert.equal(step.id, 'revoke', `${name}: only the delete step gets the token`);
    }
  }
});

test('one site\'s failed publish holds back no other site\'s checks, and the failed site gains no marker', async (t) => {
  const pagesFailures = [];
  for (const failed of everySite) {
    // A push that changed every site: each is published and checked.
    const { world, run, change } = await deployWorld(t);
    await run();
    for (const id of everySite) await change(id);
    const result = await run({ failPublish: [failed] });
    assert.deepEqual(result.published, everySite);
    assert.equal(result.green, false, `${failed}: the failed publish leaves the run red`);
    assertEverySiteFullyChecked(result, everySite);
    // A failed Worker publish also holds back the Pages publish, so neuro's new bytes are not live either.
    const notLive = new Set(failed === PAGES_SITE ? [failed] : [failed, PAGES_SITE]);
    if (failed !== PAGES_SITE) pagesFailures.push(result.results.deploy);
    for (const id of everySite) {
      const leg = result.legs[checkJobOf(id)][id];
      assert.equal(world.markers.has(result.key(id)), !notLive.has(id), `${failed} failed: ${id} ${notLive.has(id) ? 'gains no marker' : 'gains its marker'}`);
      assert.equal(leg.result, notLive.has(id) ? 'failure' : 'success', `${failed} failed: ${id}'s leg`);
    }
    // The mixed case: a scheduled run with only this site changed, every other site live and verified.
    const mixed = await deployWorld(t);
    await mixed.run();
    await mixed.change(failed);
    const daily = await mixed.run({ event: 'schedule', failPublish: [failed] });
    assert.deepEqual(daily.published, [failed]);
    assert.equal(daily.green, false);
    assertEverySiteFullyChecked(daily, everySite);
    for (const id of everySite) assert.equal(mixed.world.markers.has(daily.key(id)), id !== failed, `${failed} failed on the daily run: ${id}`);
  }
  assert.ok(pagesFailures.every((result) => result === 'skipped'), 'the Pages publish waits for the Worker publishes');
});

test('a site whose checks fail loses its marker, and the next run with no change checks it again', async (t) => {
  for (const failed of everySite) {
    const { world, run } = await deployWorld(t);
    await run();
    assert.equal((await run()).published.length, 0, 'every site is live and verified');
    const keys = new Set(world.markers);
    // The daily run: the site's landing page answers 503, which its probe reports.
    const daily = await run({ event: 'schedule', failing: { [failed]: ['answers'] } });
    assert.equal(daily.green, false, failed);
    assertEverySiteFullyChecked(daily, everySite, failed);
    assert.deepEqual(daily.summary, [`${failed}: deleted its marker`]);
    assert.deepEqual([...world.markers].sort(), [...keys].filter((key) => key !== daily.key(failed)).sort(), `${failed}: only its marker is gone`);
    const next = await run();
    assert.deepEqual(next.published, [failed], `${failed} is published and checked again`);
    assert.equal(next.green, true);
    assert.deepEqual((await run()).published, [], `${failed} passed, so the run after skips it`);
  }
  // Any one assertion is enough.
  for (const step of assertionsOf('verify-sites')) {
    const { world, run } = await deployWorld(t);
    await run();
    const daily = await run({ event: 'schedule', failing: { msk: [step] } });
    assert.equal(world.markers.has(daily.key('msk')), false, step);
  }
});

test('a cancelled check deletes nothing, but an assertion that failed before the cancellation still deletes its marker', async (t) => {
  const { world, run } = await deployWorld(t);
  await run();
  const keys = [...world.markers].sort();
  const cancelled = await run({ event: 'schedule', cancelAt: 'isolation' });
  assert.equal(cancelled.green, false);
  assert.deepEqual(cancelled.summary, []);
  assert.deepEqual([...world.markers].sort(), keys, 'a cancelled check proves nothing');
  for (const id of registry.site.catalogs.map(({ id: catalogue }) => catalogue)) {
    assert.ok(!cancelled.legs['verify-sites'][id].ran.includes('save') && !cancelled.legs['verify-sites'][id].ran.includes('revoke'), id);
  }
  // msk's probe failed, then the run was cancelled during the next check.
  const failedThenCancelled = await run({ event: 'schedule', failing: { msk: ['answers'] }, cancelAt: 'isolation' });
  assert.equal(world.markers.has(failedThenCancelled.key('msk')), false);
  assert.deepEqual(failedThenCancelled.summary, ['msk: deleted its marker']);
});

test('a failed delete leaves the run red and says why', async (t) => {
  const { world, run } = await deployWorld(t);
  await run();
  const result = await run({ event: 'schedule', failing: { hub: ['links'] }, deleteFails: true });
  assert.equal(result.green, false);
  assert.equal(result.legs['verify-hub'].hub.steps.revoke.outcome, 'failure');
  assert.deepEqual(result.summary, ['hub: could not delete its marker']);
  assert.equal(world.markers.has(result.key('hub')), true, 'the marker stays when the delete fails');
});

test('a site whose check failed is checked again by the next run, and skipped once a check passed', async (t) => {
  const { run } = await deployWorld(t);
  // The first run after the merge: nothing is verified, so everything is published and checked.
  const first = await run({ failing: { msk: ['isolation'] } });
  assert.deepEqual(first.published, everySite);
  assert.equal(first.legs['verify-sites'].msk.result, 'failure');
  // No change: the sites that passed are skipped; msk is published and checked again.
  const second = await run();
  assert.deepEqual(second.published, ['msk']);
  assert.equal(second.planned.find(({ site: id }) => id === 'msk').verifyBuild, false, 'its bytes passed the build\'s checks when they were first published');
  assert.equal(second.green, true);
  // No change, and every check has passed: nothing runs.
  assert.deepEqual((await run()).published, []);
});

test('a re-run of an older run\'s hub check cannot hide a newer failed check', async (t) => {
  const { root, run } = await deployWorld(t);
  await run();
  // Run A changes the hub; its hub check fails.
  await put(join(root, 'hub'), 'index.html', '<!doctype html><title>hub 2</title>');
  const a = await run({ failing: { hub: ['links'] } });
  assert.deepEqual(a.published, ['hub']);
  // Run B changes msk; msk's check fails, and the hub, still unverified, is published and checked again and fails.
  await put(join(root, 'msk'), 'app/new.js', '');
  const b = await run({ failing: { msk: ['uploads'], hub: ['links'] } });
  assert.deepEqual(b.published, ['msk', 'hub']);
  // Someone re-runs only A's failed jobs, and the hub check passes: it marks the hub at A's digest, which the host still serves.
  const rerun = a.rerunFailed();
  assert.equal(rerun.ran, 'build turbo-cache-retention deploy-workers verify-hub');
  assert.equal(rerun.results['verify-hub'], 'success');
  // The next run skips the hub but still publishes and checks msk.
  const c = await run();
  assert.deepEqual(c.published, ['msk']);
  assert.equal(c.green, true);
  assert.deepEqual((await run()).published, []);
});

test('"Re-run failed jobs" re-runs only the failed check legs, saves their markers, and the next run skips them', async (t) => {
  const { world, run, change } = await deployWorld(t);
  await run();
  await change('preclinical');
  await change('msk');
  const failed = await run({ failing: { preclinical: ['downloads'] } });
  assert.equal(failed.legs['verify-sites'].preclinical.result, 'failure');
  const rerun = failed.rerunFailed();
  assert.equal(rerun.results['verify-sites'], 'success');
  assert.equal(rerun.green, true);
  assert.equal(world.markers.has(failed.key('preclinical')), true);
  assert.deepEqual((await run()).published, []);
});

test('a check that saw older bytes or a lost marker is published and checked again', async (t) => {
  const { world, run, change } = await deployWorld(t);
  await run();
  // preclinical's host still serves its old bytes while the checks run: they pass, but mark nothing.
  await change('preclinical');
  const lag = await run({ lagging: ['preclinical'] });
  assert.equal(lag.legs['verify-sites'].preclinical.steps.before.outputs.confirmed, 'false');
  assert.equal(world.markers.has(lag.key('preclinical')), false);
  const after = await run();
  assert.deepEqual(after.published, ['preclinical'], 'its digest is live now, but unverified');
  assert.equal(after.planned.find(({ site: id }) => id === 'preclinical').reason, 'no verified marker for this content and these checks');
  // The cache evicts neuro's marker: the next run publishes and checks neuro once.
  world.markers.delete(after.key('neuro'));
  assert.deepEqual((await run()).published, ['neuro']);
  assert.deepEqual((await run()).published, []);
});

test('changed check scripts check every site again, and an unreachable marker store publishes and checks every site', async (t) => {
  const { world, run } = await deployWorld(t);
  await run();
  assert.deepEqual((await run()).published, []);
  const changed = await run({ checks: CHECKS_2 });
  assert.deepEqual(changed.published, everySite);
  assertEverySiteFullyChecked(changed, everySite);
  assert.ok(changed.planned.every(({ verifyBuild }) => !verifyBuild), 'the content is what the hosts serve');
  assert.deepEqual((await run({ checks: CHECKS_2 })).published, []);
  world.storeDown = true;
  const down = await run({ checks: CHECKS_2 });
  assert.deepEqual(down.published, everySite);
  assertEverySiteFullyChecked(down, everySite);
  assert.ok(down.planned.every(({ reason }) => reason === 'marker unknown (GitHub API: HTTP 503)'));
});

test('the daily run checks every live site and restores the markers it lacks; a dispatch publishes and checks every site', async (t) => {
  const { world, run } = await deployWorld(t);
  await run();
  const keys = [...world.markers];
  world.markers.delete(keys.find((key) => key.startsWith(`${MARKER_PREFIX}msk-`)));
  const daily = await run({ event: 'schedule' });
  assertEverySiteFullyChecked(daily, everySite);
  assert.deepEqual(daily.published, ['msk'], 'only the site without a marker is published');
  assert.deepEqual([...world.markers].sort(), [...keys].sort());
  const dispatched = await run({ event: 'dispatch' });
  assert.deepEqual(dispatched.published, everySite);
  assertEverySiteFullyChecked(dispatched, everySite);
});

test('each check leg confirms the digest before and after its assertions, keeps or saves the marker only after both, and fails an untaken publish last', () => {
  for (const name of CHECK_JOBS) {
    const job = workflow.jobs[name];
    const index = (id) => job.steps.findIndex((step) => step.id === id);
    const order = ['before', ...assertionsOf(name), 'after', 'kept', 'save', 'revoke', 'untaken'];
    assert.deepEqual(job.steps.slice(index('before')).map(({ id }) => id), order, `${name}: confirm, assertions, confirm, keep, save, delete, untaken`);
    for (const step of job.steps.slice(0, index('before'))) assert.doesNotMatch(String(step.run ?? ''), /test:|smoke|check-site-answers|curl/, `${name}: no assertion runs before the first confirmation`);
    const site = name === 'verify-hub' ? 'hub' : '"$SITE_CATALOG"';
    const url = name === 'verify-hub' ? '$SITE_URL' : '$BASE_URL';
    const step = (id) => job.steps[index(id)];
    assert.equal(step('before').run, `node scripts/confirm-site-digest.mjs --url "${url}" --site ${site} --digest "$SITE_DIGEST" --published "$SITE_PUBLISHED"`);
    assert.equal(step('before').if, undefined, 'the confirmation always runs and never stops the assertions');
    assert.equal(step('after').run, `node scripts/confirm-site-digest.mjs --url "${url}" --site ${site} --digest "$SITE_DIGEST" --marker deploy-verified.json`);
    for (const id of assertionsOf(name)) assert.ok(step(id).if === undefined && step(id)['continue-on-error'] === undefined, `${name}: ${id} runs whenever the leg has not failed, and can fail it`);
    assert.equal(step('after').if, "steps.before.outputs.confirmed == 'true'");
    assert.equal(step('kept').if, "steps.after.outputs.confirmed == 'true' && env.SITE_MARKER != ''");
    assert.equal(step('save').if, "steps.after.outputs.confirmed == 'true' && env.SITE_MARKER != '' && steps.kept.outputs.cache-hit != 'true'");
    assert.match(step('revoke').if, /^\$\{\{ always\(\) && env\.SITE_MARKER != '' && \(/);
    assert.equal(step('revoke').run, 'node scripts/revoke-site-marker.mjs --key "$SITE_MARKER"');
    assert.equal(step('untaken').if, "${{ !cancelled() && steps.before.outputs.untaken == 'true' }}");
    assert.equal(step('kept').uses, 'actions/cache/restore@v6');
    assert.equal(step('save').uses, 'actions/cache/save@v6');
    for (const id of ['kept', 'save']) {
      assert.deepEqual(step(id).with, { path: 'deploy-verified.json', key: '${{ env.SITE_MARKER }}' }, `${name}: ${id}`);
      assert.equal(step(id)['continue-on-error'], true, `${name}: ${id} cannot fail checks that passed`);
    }
    // The leg's site, digest, key and whether this run published it come from the build's plan.
    const leg = { site: 'msk', url: 'https://mskapps.sciget.org/', digest, key: KEY, published: true };
    const env = jobEnv(job, { matrix: leg });
    assert.deepEqual({ digest: env.SITE_DIGEST, key: env.SITE_MARKER, published: env.SITE_PUBLISHED }, { digest, key: KEY, published: 'true' });
    assert.equal(env[name === 'verify-hub' ? 'SITE_URL' : 'BASE_URL'], leg.url);
    assert.equal(jobEnv(job, { matrix: { ...leg, key: '' } }).SITE_MARKER, '');
  }
});

test('the steps of a check leg: any failed assertion fails it and deletes the marker; a pass saves or keeps it', () => {
  const env = { SITE_MARKER: KEY, SITE_DIGEST: digest, SITE_PUBLISHED: 'false' };
  const outputs = { before: { confirmed: 'true' }, after: { confirmed: 'true' }, kept: { 'cache-hit': 'false' } };
  // The untaken step fails whenever it runs.
  const leg = (job, { fail = [], cancel, out = outputs, legEnv = env } = {}) => runSteps(job, { env: legEnv, act: (step) => ({ fail: fail.includes(step.id) || step.id === 'untaken', cancel: cancel !== undefined && step.id === cancel, outputs: out[step.id] ?? {} }) });
  for (const name of CHECK_JOBS) {
    const job = workflow.jobs[name];
    const passed = leg(job);
    assert.equal(passed.result, 'success', name);
    assert.ok(passed.ran.includes('save') && !passed.ran.includes('revoke') && !passed.ran.includes('untaken'), name);
    const kept = leg(job, { out: { ...outputs, kept: { 'cache-hit': 'true' } } });
    assert.ok(kept.ran.includes('kept') && !kept.ran.includes('save'), `${name}: an existing marker is restored, which keeps it from eviction`);
    for (const id of assertionsOf(name)) {
      const failed = leg(job, { fail: [id] });
      assert.equal(failed.result, 'failure', `${name}: ${id}`);
      assert.ok(failed.ran.includes('revoke') && !failed.ran.includes('kept') && !failed.ran.includes('save'), `${name}: ${id} failed, so the marker is deleted and not saved`);
      // Without a key there is nothing to delete.
      assert.ok(!leg(job, { fail: [id], legEnv: { ...env, SITE_MARKER: '' } }).ran.includes('revoke'), `${name}: ${id}`);
    }
    // A cancellation deletes and saves nothing.
    const cancelled = leg(job, { cancel: assertionsOf(name).at(-1) });
    assert.ok(!cancelled.ran.includes('revoke') && !cancelled.ran.includes('save'), `${name}: cancelled`);
    // The host served other bytes before or after: every assertion runs, nothing is saved, and the leg passes unless this run published the site.
    for (const which of ['before', 'after']) {
      const other = leg(job, { out: { ...outputs, [which]: { confirmed: 'false' } } });
      assert.ok(other.result === 'success' && assertionsOf(name).every((id) => other.ran.includes(id)) && !other.ran.includes('save'), `${name}: ${which}`);
    }
    const untaken = leg(job, { out: { ...outputs, before: { confirmed: 'false', untaken: 'true' } } });
    assert.equal(untaken.result, 'failure', `${name}: an untaken publish fails the leg`);
    assert.ok(assertionsOf(name).every((id) => untaken.ran.includes(id)) && !untaken.ran.includes('save') && !untaken.ran.includes('revoke'), `${name}: its assertions still run`);
    // A failed delete fails the step; the leg is red already.
    const deleteFails = leg(job, { fail: [assertionsOf(name)[0], 'revoke'] });
    assert.equal(deleteFails.steps.revoke.outcome, 'failure');
    assert.equal(deleteFails.result, 'failure');
  }
});

test('every job of the workflow is in the simulated order', () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...JOB_ORDER].sort());
});

test('each case runs exactly the deploy and check jobs it needs', async (t) => {
  const table = {};
  const describe = (result) => {
    const sites = (list) => JSON.parse(list).map(({ site: id }) => id).join(',');
    const { pages, workers, verify, hub, verify_build: startup } = result.outputs;
    return { outputs: `pages=${pages} workers=${sites(workers)} verify=${sites(verify)} hub=${sites(hub)} startup=${startup}`, ran: result.ran, green: result.green };
  };
  const scenario = async (name, prepare) => {
    const world = await deployWorld(t);
    await world.run();
    table[name] = describe(await prepare(world));
  };
  await scenario('nothing changed, markers present', ({ run }) => run());
  await scenario('nothing changed, msk marker absent', async ({ world, run }) => {
    world.markers.delete([...world.markers].find((key) => key.startsWith(`${MARKER_PREFIX}msk-`)));
    return run();
  });
  await scenario('one site changed', async ({ run, change }) => {
    await change('msk');
    return run();
  });
  await scenario('scheduled run, every digest live and verified', ({ run }) => run({ event: 'schedule' }));
  await scenario('scheduled run, every digest live and verified, a landing page fails', ({ run }) => run({ event: 'schedule', failing: { microscopy: ['answers'] } }));
  await scenario('dispatched run', ({ run }) => run({ event: 'dispatch' }));
  await scenario('unreadable record for one site', async ({ world, run }) => {
    world.hosts.delete('webapps.neurodesk.org');
    return run();
  });
  await scenario('marker store unreachable', async ({ world, run }) => {
    world.storeDown = true;
    return run();
  });
  await scenario('first run after the merge', async ({ world, run }) => {
    world.hosts.clear();
    world.markers.clear();
    return run();
  });
  await scenario('one Worker site changed and its publish fails', async ({ run, change }) => {
    await change('msk');
    return run({ failPublish: ['msk'] });
  });
  const all = 'pages=true workers=msk,microscopy,preclinical,hub verify=neuro,msk,microscopy,preclinical hub=hub';
  assert.deepEqual(table, {
    'nothing changed, markers present': { outputs: 'pages=false workers= verify= hub= startup=false', ran: 'build turbo-cache-retention', green: true },
    'nothing changed, msk marker absent': { outputs: 'pages=false workers=msk verify=msk hub= startup=false', ran: 'build turbo-cache-retention deploy-workers verify-sites', green: true },
    'one site changed': { outputs: 'pages=false workers=msk verify=msk hub= startup=true', ran: 'build turbo-cache-retention deploy-workers verify-sites', green: true },
    'scheduled run, every digest live and verified': { outputs: 'pages=false workers= verify=neuro,msk,microscopy,preclinical hub=hub startup=false', ran: 'build turbo-cache-retention verify-hub verify-sites', green: true },
    'scheduled run, every digest live and verified, a landing page fails': { outputs: 'pages=false workers= verify=neuro,msk,microscopy,preclinical hub=hub startup=false', ran: 'build turbo-cache-retention verify-hub verify-sites', green: false },
    'dispatched run': { outputs: `${all} startup=true`, ran: JOB_ORDER.join(' '), green: true },
    'unreadable record for one site': { outputs: 'pages=true workers= verify=neuro hub= startup=true', ran: 'build turbo-cache-retention deploy verify-sites', green: true },
    'marker store unreachable': { outputs: `${all} startup=false`, ran: JOB_ORDER.join(' '), green: true },
    'first run after the merge': { outputs: `${all} startup=true`, ran: JOB_ORDER.join(' '), green: true },
    'one Worker site changed and its publish fails': { outputs: 'pages=false workers=msk verify=msk hub= startup=true', ran: 'build turbo-cache-retention deploy-workers verify-sites', green: false },
  });
});
