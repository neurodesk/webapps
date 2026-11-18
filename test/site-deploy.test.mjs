import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
  analyticsStale,
  decideSite,
  deployOutputs,
  deploySites,
  deploySummary,
  lastAnalyticsRefresh,
  planDeploy,
  siteDigest,
} from '../scripts/lib/site-deploy.mjs';
import { DIGEST_FILE, parseLiveRecord, readLiveRecord } from '../scripts/lib/site-record.mjs';

const registry = await loadAppsRegistry();
const DEPLOY_WORKFLOW = '.github/workflows/deploy-pages.yml';
const PAGES_SITE = registry.site.catalogs.find(({ hosting }) => hosting === 'pages');

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
    // A file named for a commit, such as calmar's build-info.json, republishes its site when it changes.
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

test('a site is published when the run was dispatched, its live record is unreadable, its digest differs or its usage report is due, and only then', () => {
  const lives = { readable: { record: record() }, unreadable: { error: 'HTTP 404' } };
  const digests = { equal: digest, different: 'b'.repeat(64) };
  const reports = { current: '2026-11-18T12:00:00Z', due: '2026-11-19T04:30:00Z' };
  let cases = 0;
  for (const deployAll of [false, true]) {
    for (const [liveName, live] of Object.entries(lives)) {
      for (const [digestName, built] of Object.entries(digests)) {
        for (const [reportName, analytics] of Object.entries(reports)) {
          const name = `${deployAll ? 'dispatched' : 'push or schedule'}, ${liveName} record, ${digestName} digest, report ${reportName}`;
          const publish = deployAll || liveName === 'unreadable' || digestName === 'different' || reportName === 'due';
          assert.deepEqual(Object.keys(decideSite({ digest: built, analytics, live, deployAll })), ['publish', 'reason'], name);
          assert.equal(decideSite({ digest: built, analytics, live, deployAll }).publish, publish, name);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 16);
  const reason = (fields) => decideSite({ digest, analytics: reports.current, live: lives.readable, ...fields }).reason;
  assert.equal(reason({}), 'the host serves this content and a current usage report');
  assert.equal(reason({ deployAll: true }), 'dispatched run: every site is published');
  assert.equal(reason({ live: { error: 'HTTP 404' } }), 'live digest unreadable (HTTP 404)');
  assert.equal(reason({ digest: 'b'.repeat(64) }), 'content changed');
  assert.equal(reason({ analytics: reports.due }), 'usage report refresh (live report: 2026-11-18T04:24:00Z)');
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

// Sites whose every digest is live: the hosts serve the records a first plan wrote.
async function liveFixture(t) {
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, nonce: 'n', fetch: missing, write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, served]));
  const served = async (url) => json(records.get(new URL(url).host));
  const plan = (options = {}) => planDeploy({ registry, sitesDir: root, commit: C1, nonce: 'n', fetch: served, write: writeFile, ...options });
  return { root, first, records, served, plan };
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
  const { records, plan } = await liveFixture(t);
  const planned = await plan({ fetch: async (url) => json({ ...records.get(new URL(url).host), commit: { sha: C1 } }) });
  assert.ok(planned.every(({ publish, reason }) => publish && /^live digest unreadable \(commit is neither/.test(reason)));
  assert.match(deploySummary(planned), /\| msk \| mskapps\.sciget\.org \| published \| live digest unreadable/);
});

test('a site whose plan throws is published, and the other sites are still planned', async (t) => {
  const { root, plan } = await liveFixture(t);
  await rm(join(root, 'microscopy.wrangler.json'));
  const planned = await plan();
  const decision = Object.fromEntries(planned.map(({ site: id, publish, reason }) => [id, publish ? reason : 'skip']));
  assert.match(decision.microscopy, /^plan failed \(ENOENT/);
  assert.deepEqual({ ...decision, microscopy: 'plan failed' }, { neuro: 'skip', msk: 'skip', microscopy: 'plan failed', preclinical: 'skip', hub: 'skip' });
  assert.deepEqual(deployOutputs(planned), {
    publish: JSON.stringify({ neuro: false, msk: false, microscopy: true, preclinical: false, hub: false }),
    any: 'true',
    pages_url: `https://${PAGES_SITE.host}/`,
  });
  assert.match(deploySummary(planned), /\| microscopy \| microscopyapps\.sciget\.org \| published \| plan failed \(ENOENT[^|]*\| - \| - \| - \|/);
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
  assert.equal(requests[0].init.redirect, 'manual');
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

test('the plan returns by its deadline when every read stalls, and publishes everything', { timeout: 10_000 }, async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const fetch = await slowServer(t, Infinity);
  const { result, ms } = await elapsed(() => planDeploy({ registry, sitesDir: root, commit: C1, nonce: 'n', fetch, write: writeFile, timeoutMs: 1200 }));
  assert.ok(ms >= 1190 && ms < 2400, `the reads run at once and end at the deadline (${ms} ms)`);
  assert.ok(result.every(({ publish, reason }) => publish && reason === 'live digest unreadable (no complete answer in 1.2 s)'));
  assert.equal(deployOutputs(result).any, 'true');
});

// A preload for the plan command: every https request goes to the loopback
// server at `port`, naming the host it was meant for in `x-site-host`, and
// every deadline of 10 s or more is divided by 100, so 30 s ends at 0.3 s.
async function loopbackPreload(root, port) {
  const preload = join(root, 'loopback.mjs');
  await writeFile(preload, [
    `const origin = 'http://127.0.0.1:${port}';`,
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = (url, init) => { const { host, pathname, search } = new URL(url); return realFetch(origin + pathname + search, { ...init, headers: { ...init?.headers, \'x-site-host\': host } }); };',
    'const realTimeout = globalThis.setTimeout;',
    'globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms >= 10_000 ? ms / 100 : ms, ...args);',
    '',
  ].join('\n'));
  return preload;
}

// Run the plan command over a copy of the sites fixture under the preload; the outputs it writes to GITHUB_OUTPUT.
async function planCommand(t, answer, args = []) {
  const { port, requests } = await answeringServer(t, answer);
  const root = await tempDir(t);
  const sitesDir = join(root, 'sites');
  await sitesFixture(sitesDir);
  const output = join(root, 'output');
  await writeFile(output, '');
  const start = performance.now();
  const child = spawn(process.execPath, ['--import', await loopbackPreload(root, port), join(repoRoot, 'scripts/plan-site-deploy.mjs'), '--sites-dir', sitesDir, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_SHA: C1 },
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
  return { code, signal, stdout, stderr, ms: performance.now() - start, outputs, requests, sitesDir };
}

// A loopback server that answers every request with `status`, `type` and
// `headers` at once, then sends `body` (a function of the meant-for host, or
// text) and, with `trickle`, a space every 100 ms forever, with `end` the end,
// or else nothing more.
async function answeringServer(t, { status, type, headers = {}, body = '{', trickle, end }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, host: request.headers['x-site-host'], cacheControl: request.headers['cache-control'] });
    response.writeHead(status, { 'content-type': type, ...headers });
    response.flushHeaders();
    response.write(typeof body === 'function' ? body(request.headers['x-site-host']) : body);
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

const ALL_PUBLISHED = JSON.stringify(Object.fromEntries(deploySites(registry).map(({ site: id }) => [id, true])));

test('the plan command exits by itself with its outputs written, publishing every site, whatever unreadable answer the hosts give', { timeout: 120_000 }, async (t) => {
  // Start-up, digests and outputs, with every answer complete at once.
  const prompt = await planCommand(t, { status: 404, type: 'text/plain', body: 'Not found', end: true });
  assert.equal(prompt.code, 0, prompt.stderr);
  assert.equal(prompt.requests.length, deploySites(registry).length);
  assert.ok(prompt.requests.every(({ url, cacheControl }) => url.startsWith(`/${DIGEST_FILE}?run=`) && cacheControl === 'no-cache'));
  const msk = (fields) => () => JSON.stringify(record(fields));
  for (const [name, answer, reason] of [
    ['a redirect', { status: 302, type: 'application/json', headers: { location: `/old/${DIGEST_FILE}` }, body: msk({}), end: true }, 'HTTP 302'],
    ['a stale Age', { status: 200, type: 'application/json', headers: { age: '3600' }, body: msk({}), end: true }, 'a cached copy (Age: 3600)'],
    ['a wrong content type', { status: 200, type: 'text/html', body: msk({}), end: true }, 'content type "text/html"'],
    ['a malformed record', { status: 200, type: 'application/json', body: '{"schema":1,"site":"msk"}', end: true }, 'no content digest'],
    ['an impossible date', { status: 200, type: 'application/json', body: msk({ analyticsGeneratedAt: '2026-02-31T10:00:00Z' }), end: true }, 'analyticsGeneratedAt is neither null nor an ISO instant'],
    ['a stalled JSON body', { status: 200, type: 'application/json' }, 'no complete answer in 30 s'],
    ['a trickling JSON body', { status: 200, type: 'application/json', trickle: true }, 'no complete answer in 30 s'],
    ['a trickling HTTP 502', { status: 502, type: 'text/html', trickle: true }, 'HTTP 502'],
  ]) {
    const { code, signal, stdout, stderr, ms, outputs } = await planCommand(t, answer);
    assert.equal(signal, null, `${name}: the process ended by itself (${stderr})`);
    assert.equal(code, 0, `${name}: ${stderr}`);
    // Each live record read ends at 0.3 s under the preload.
    assert.ok(ms < prompt.ms + 300 + 1500, `${name}: exited after ${Math.round(ms)} ms, ${Math.round(prompt.ms)} ms with prompt answers`);
    assert.deepEqual(outputs, { publish: ALL_PUBLISHED, any: 'true', pages_url: `https://${PAGES_SITE.host}/` }, name);
    // The message names the configured deadline; the preload ended it at 0.3 s.
    assert.ok(stdout.includes(`| msk | mskapps.sciget.org | published | live digest unreadable (${reason}) |`), `${name}: ${stdout}`);
  }
});

test('the plan command publishes nothing when every host serves this build, and everything when dispatched', { timeout: 60_000 }, async (t) => {
  // The records a first plan of the same fixture writes, served by host.
  const root = await tempDir(t);
  await sitesFixture(root);
  const first = await planDeploy({ registry, sitesDir: root, commit: C2, nonce: 'n', fetch: missing, write: writeFile });
  const records = new Map(first.map(({ host, record: served }) => [host, JSON.stringify(served)]));
  const answer = { status: 200, type: 'application/json', body: (host) => records.get(host), end: true };
  const live = await planCommand(t, answer);
  assert.equal(live.code, 0, live.stderr);
  assert.deepEqual(live.outputs, {
    publish: JSON.stringify(Object.fromEntries(deploySites(registry).map(({ site: id }) => [id, false]))),
    any: 'false',
    pages_url: `https://${PAGES_SITE.host}/`,
  });
  // Every site still carries this run's record.
  for (const { site: id } of deploySites(registry)) {
    assert.deepEqual(JSON.parse(await readFile(join(live.sitesDir, id, DIGEST_FILE), 'utf8')), { ...JSON.parse(records.get(first.find(({ site: s }) => s === id).host)), commit: C1 });
  }
  const dispatched = await planCommand(t, answer, ['--deploy-all']);
  assert.deepEqual(dispatched.outputs.publish, ALL_PUBLISHED);
  assert.ok(dispatched.stdout.includes('| neuro | webapps.neurodesk.org | published | dispatched run: every site is published |'));
});

test('every catalogue and the hub is planned, and the Worker list is the one the registry declares', () => {
  assert.deepEqual(deploySites(registry).map(({ site }) => site), [...registry.site.catalogs.map(({ id }) => id), 'hub']);
  assert.deepEqual(deploySites(registry).filter(({ hosting }) => hosting === 'worker').map(({ site, host }) => ({ host, site })), workerSites(registry));
  assert.equal(deploySites(registry).filter(({ hosting }) => hosting === 'pages').length, 1);
});

test('a plan publishes only what differs from the live hosts, and writes each site its record', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const written = new Map();
  const write = async (path, text) => { written.set(path, text); await writeFile(path, text); };
  // First deploy: nothing is live, so every site is published.
  const first = await planDeploy({ registry, sitesDir: root, commit: C1, nonce: 'n', fetch: missing, write });
  assert.ok(first.every(({ publish }) => publish));
  assert.equal(written.size, deploySites(registry).length);
  const records = Object.fromEntries(first.map(({ site, record }) => [site, record]));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'msk', DIGEST_FILE), 'utf8')), records.msk);
  assert.equal(records.msk.analyticsGeneratedAt, '2026-11-18T01:06:47.596Z');
  assert.equal(records.hub.analyticsGeneratedAt, null);
  assert.equal(records.msk.commit, C1);

  // The hosts now serve those records, but microscopy's publish had failed. One app of msk changes.
  const served = async (url) => {
    const id = deploySites(registry).find(({ host }) => url.startsWith(`https://${host}/`)).site;
    if (id === 'microscopy') return json({ ...records.microscopy, digest: 'f'.repeat(64) });
    return json(records[id]);
  };
  await put(join(root, 'msk'), 'app/assets/model.wasm', 'new model');
  const second = await planDeploy({ registry, sitesDir: root, commit: C2, nonce: 'n', fetch: served, write });
  const decision = Object.fromEntries(second.map(({ site, publish, reason }) => [site, publish ? reason : 'skip']));
  assert.deepEqual(decision, { neuro: 'skip', msk: 'content changed', microscopy: 'content changed', preclinical: 'skip', hub: 'skip' });
  assert.deepEqual(JSON.parse(deployOutputs(second).publish), { neuro: false, msk: true, microscopy: true, preclinical: false, hub: false });
  // The record a site now carries does not change its digest.
  assert.equal(second.find(({ site: id }) => id === 'neuro').digest, records.neuro.digest);
  assert.equal(await siteDigest(join(root, 'neuro')), records.neuro.digest);

  const summary = deploySummary(second);
  assert.match(summary, /^Every site is checked against its public host, published or not\.$/m);
  assert.match(summary, /\| Site \| Host \| Publish \| Why \| Build digest \| Live digest \| Live commit \|/);
  for (const { site: id, host } of deploySites(registry)) assert.match(summary, new RegExp(`\\| ${id} \\| ${host} \\| (published|skipped) \\| `));
  assert.match(summary, /\| neuro \| webapps\.neurodesk\.org \| skipped \| the host serves this content and a current usage report \|/);
  assert.match(summary, /\| msk \| mskapps\.sciget\.org \| published \| content changed \| `[0-9a-f]{12}` \| `[0-9a-f]{12}` \| `fd08c1c20` \|/);
});

test('the scheduled run refreshes every catalogue\'s usage report once a day, and the hub, which has none, stays', async (t) => {
  const { root, plan } = await liveFixture(t);
  assert.equal(deployOutputs(await plan()).any, 'false');
  for (const { id } of registry.site.catalogs) await put(join(root, id), 'analytics.json', report('2026-11-19T04:24:00Z'));
  const daily = await plan();
  assert.deepEqual(daily.filter(({ publish }) => publish).map(({ site: id }) => id), registry.site.catalogs.map(({ id }) => id));
  assert.ok(daily.filter(({ publish }) => publish).every(({ reason }) => reason.startsWith('usage report refresh')));
});

// The workflow on main before the deploy plan (origin/main at 468a942ee). The
// plan may change only what the test below allows; anything else is a change
// to the deploy or its checks and needs its own review.
const BASE_WORKFLOW = 'test/fixtures/deploy-pages.main.yml';
const workflow = parse(await readFile(join(repoRoot, DEPLOY_WORKFLOW), 'utf8'));
const base = parse(await readFile(join(repoRoot, BASE_WORKFLOW), 'utf8'));

// A GitHub expression of `needs`, `steps`, `matrix` and `github`, evaluated as JavaScript.
const expression = (source, context) => runInNewContext(
  String(source).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\bfromJSON\(/g, 'JSON.parse('),
  context,
);

const PLAN_STEP = {
  name: 'Decide which sites to publish',
  id: 'plan',
  run: "node scripts/plan-site-deploy.mjs ${{ github.event_name == 'workflow_dispatch' && '--deploy-all' || '' }}",
};
const STARTUP_CONDITION = "steps.plan.outputs.any == 'true'";
const isStartup = (step) => ['Install runtime startup test browser', 'Verify threaded model loading before deployment'].includes(step.name);
// The steps that publish, by job, and the condition each gains.
const PUBLISH_STEPS = {
  build: [[(step) => step.uses?.startsWith('actions/upload-pages-artifact@'), `fromJSON(steps.plan.outputs.publish).${PAGES_SITE.id}`]],
  deploy: [[(step) => step.id === 'deployment', `fromJSON(needs.build.outputs.publish).${PAGES_SITE.id}`]],
  'deploy-workers': [[(step) => step.name === 'Deploy the ${{ matrix.site }} site', 'fromJSON(needs.build.outputs.publish)[matrix.site]']],
};
// A check of the Pages site uses its registry URL when its publish was skipped.
const PAGES_URL = '${{ steps.deployment.outputs.page_url }}';
const PAGES_URL_OR_REGISTRY = '${{ steps.deployment.outputs.page_url || needs.build.outputs.pages_url }}';

test('the deploy plan changes only the publish steps and the startup check: every job, need, matrix, permission and check is main\'s', () => {
  const { jobs: headJobs, ...headTop } = workflow;
  const { jobs: baseJobs, ...baseTop } = base;
  assert.deepEqual(headTop, baseTop, 'triggers, permissions, concurrency and env');
  assert.deepEqual(Object.keys(headJobs), Object.keys(baseJobs), 'jobs');
  for (const [name, job] of Object.entries(headJobs)) {
    const { steps, outputs, ...rest } = job;
    const { steps: baseSteps, ...baseRest } = baseJobs[name];
    // Needs, matrices, permissions, environments, conditions and env of every job.
    assert.deepEqual(rest, baseRest, `${name}: everything but its steps`);
    if (name === 'build') {
      assert.deepEqual(outputs, { publish: '${{ steps.plan.outputs.publish }}', pages_url: '${{ steps.plan.outputs.pages_url }}' });
    } else {
      assert.equal(outputs, undefined, `${name} has no outputs`);
    }
    const conditions = [];
    const normal = steps.filter((step) => step.id !== 'plan').map((step) => {
      const publish = PUBLISH_STEPS[name]?.find(([match]) => match(step));
      if (!publish && !isStartup(step)) return step;
      const { if: condition, ...unconditional } = step;
      conditions.push([step.name ?? step.uses, condition]);
      assert.equal(condition, publish ? publish[1] : STARTUP_CONDITION, `${step.name ?? step.uses}`);
      return unconditional;
    }).map((step) => (step.env?.BASE_URL === PAGES_URL_OR_REGISTRY ? { ...step, env: { ...step.env, BASE_URL: PAGES_URL } } : step));
    // Every other step, every check included, is main's, condition and all; the startup check may move after the plan.
    assert.deepEqual(normal.filter((step) => !isStartup(step)), baseSteps.filter((step) => !isStartup(step)), `${name}: steps`);
    assert.deepEqual(normal.filter(isStartup), baseSteps.filter(isStartup), `${name}: startup check`);
    assert.equal(conditions.length, (PUBLISH_STEPS[name]?.length ?? 0) + (name === 'build' ? 2 : 0), `${name}: conditional steps ${JSON.stringify(conditions)}`);
  }
  // On main the Pages checks read the deployment's URL; that URL is what the fallback replaces, in every one of them.
  const pagesChecks = headJobs.deploy.steps.filter((step) => step.env?.BASE_URL);
  assert.equal(pagesChecks.length, 3);
  assert.ok(pagesChecks.every((step) => step.env.BASE_URL === PAGES_URL_OR_REGISTRY && step.env.SITE_CATALOG === PAGES_SITE.id));
  assert.equal(headJobs.deploy.environment.url, PAGES_URL);
});

test('the plan runs after the build\'s checks of the projected sites, and the startup check and the uploads after it', () => {
  const steps = workflow.jobs.build.steps;
  const at = (match) => {
    const index = steps.findIndex(match);
    assert.ok(index >= 0, `missing step ${match}`);
    return index;
  };
  const plan = at((step) => step.id === 'plan');
  assert.deepEqual(steps[plan], PLAN_STEP);
  for (const [event, flag] of [['workflow_dispatch', '--deploy-all'], ['schedule', ''], ['push', '']]) {
    assert.equal(expression(PLAN_STEP.run.replace(/^node scripts\/plan-site-deploy\.mjs /, ''), { github: { event_name: event } }), flag, event);
  }
  for (const [name, match] of [
    ['build', (step) => step.run === 'pnpm build'],
    ['usage report', (step) => step.run?.startsWith('node scripts/write-analytics.mjs')],
    ['artifact audit', (step) => step.run === 'pnpm audit:artifacts'],
    // It asserts each site's exact root files, so it runs before the plan adds the record.
    ['site check', (step) => step.run === 'node --test test/catalog-sites.test.mjs'],
  ]) assert.ok(at(match) < plan, `${name} runs before the plan`);
  for (const [name, match] of [
    ['startup check', isStartup],
    ['Pages upload', (step) => step.uses?.startsWith('actions/upload-pages-artifact@')],
    ['Worker upload', (step) => step.with?.name === 'worker-sites'],
  ]) assert.ok(at(match) > plan, `${name} runs after the plan`);
});

test('each publish step runs exactly when the plan publishes its site, and the Pages checks read the host either way', () => {
  const pagesUrl = `https://${PAGES_SITE.host}/`;
  const sites = deploySites(registry).map(({ site: id }) => id);
  const workers = workflow.jobs['deploy-workers'].strategy.matrix.include.map(({ site: id }) => id);
  assert.deepEqual(workers, sites.filter((id) => id !== PAGES_SITE.id), 'the Worker matrix holds every other planned site');
  for (const published of sites) {
    const outputs = deployOutputs(deploySites(registry).map(({ site: id, host, hosting }) => ({ site: id, hosting, url: `https://${host}/`, publish: id === published })));
    const needs = { build: { outputs } };
    assert.equal(Boolean(expression(PUBLISH_STEPS.build[0][1], { steps: { plan: { outputs } } })), published === PAGES_SITE.id);
    assert.equal(Boolean(expression(PUBLISH_STEPS.deploy[0][1], { needs })), published === PAGES_SITE.id);
    for (const site of workers) assert.equal(Boolean(expression(PUBLISH_STEPS['deploy-workers'][0][1], { needs, matrix: { site } })), site === published, `${site} when ${published} is published`);
    assert.equal(expression(STARTUP_CONDITION, { steps: { plan: { outputs } } }), true);
  }
  const none = deployOutputs(deploySites(registry).map(({ site: id, host, hosting }) => ({ site: id, hosting, url: `https://${host}/`, publish: false })));
  assert.equal(expression(STARTUP_CONDITION, { steps: { plan: { outputs: none } } }), false, 'nothing published: no startup check');
  // A skipped step's outputs are empty strings.
  assert.equal(expression(PAGES_URL_OR_REGISTRY, { steps: { deployment: { outputs: { page_url: '' } } }, needs: { build: { outputs: none } } }), pagesUrl);
  assert.equal(expression(PAGES_URL_OR_REGISTRY, { steps: { deployment: { outputs: { page_url: 'https://pages.example/' } } }, needs: { build: { outputs: none } } }), 'https://pages.example/');
});
