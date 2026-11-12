import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OFFLINE_AUDIT_APPS, auditedExampleFiles, auditedRuntimeFiles, exampleCachePath, fillExampleCache, loadVerifiedExampleCache, pythonIndexAnswers, pythonIndexProject } from '../scripts/lib/example-asset-cache.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const url = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/1234567890123456789012345678901234567890/scan.nii';
const body = Buffer.from([0, 1, 127, 255]);
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = { [url]: { sha256: hash(body), bytes: body.length, contentType: 'application/octet-stream' } };

test('cache mode returns the exact locked bytes for their original URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, hash(url)), body);
  const result = await loadVerifiedExampleCache([{ url }, { url }], { directory, assets });
  assert.equal(result.size, 1);
  assert.deepEqual(result.get(url).body, Buffer.from([0, 1, 127, 255]));
});

test('cache mode rejects missing, corrupt, or incorrectly sized assets without fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const load = locked => loadVerifiedExampleCache([{ url }], { directory, assets: locked });
  await assert.rejects(load(assets), /does not fall back to the network/);
  await writeFile(join(directory, hash(url)), Buffer.from([255, 127, 1, 0]));
  await assert.rejects(load(assets), /checksum or size mismatch/);
  await writeFile(join(directory, hash(url)), body);
  await assert.rejects(load({ [url]: { ...assets[url], bytes: 3 } }), /checksum or size mismatch/);
  await assert.rejects(load({}), /Missing locked SHA-256/);
});

test('verified cache files stream over HTTP with their locked type and CORS headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'streamed-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, hash(url));
  await writeFile(path, body);
  const locked = { [url]: { ...assets[url], contentType: 'application/gzip' } };
  const cache = await loadVerifiedExampleCache([{ url }], { directory, assets: locked });
  const site = await serveSite(directory, { files: new Map([
    ['/verified-scan', cache.get(url)],
    ['/legacy-scan', path],
  ]) });
  t.after(site.close);
  const response = await fetch(`${site.origin}/verified-scan`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  const head = await fetch(`${site.origin}/verified-scan`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const legacy = await fetch(`${site.origin}/legacy-scan`);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), body);
});

// A local origin whose handler decides each response; it counts requests per path.
async function fixtureServer(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handler(request, response, requests.filter(path => path === request.url).length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

async function cacheDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'filled-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const lockFor = (origin, bodies) => Object.fromEntries(Object.entries(bodies).map(([path, content]) =>
  [`${origin}${path}`, { sha256: hash(content), bytes: content.length }]));
const quick = { baseDelay: 1, maxDelay: 5 };

test('filling downloads each file once under the loader\'s name and a second run asks for nothing', async t => {
  const bodies = { '/a': Buffer.from('first example'), '/b': Buffer.from('second example') };
  const server = await fixtureServer(t, (request, response) => response.end(bodies[request.url]));
  const directory = await cacheDirectory(t);
  const locked = lockFor(server.origin, bodies);
  const files = [{ url: `${server.origin}/a` }, { url: `${server.origin}/b` }, { url: `${server.origin}/a` }];
  const first = await fillExampleCache(files, { directory, assets: locked, ...quick });
  assert.deepEqual(first.downloaded.sort(), Object.keys(locked).sort());
  assert.deepEqual(server.requests.sort(), ['/a', '/b']);
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(locked).map(hash).sort());
  const loaded = await loadVerifiedExampleCache(files, { directory, assets: locked });
  assert.deepEqual(loaded.get(`${server.origin}/b`).body, bodies['/b']);
  const second = await fillExampleCache(files, { directory, assets: locked, ...quick });
  assert.equal(server.requests.length, 2);
  assert.deepEqual([second.downloaded.length, second.reused.length], [0, 2]);
});

test('filling replaces an entry whose bytes no longer match, even at the right size', async t => {
  const bodies = { '/a': Buffer.from('first example') };
  const server = await fixtureServer(t, (request, response) => response.end(bodies[request.url]));
  const directory = await cacheDirectory(t);
  const locked = lockFor(server.origin, bodies);
  const path = exampleCachePath(directory, `${server.origin}/a`);
  await writeFile(path, Buffer.from('FIRST EXAMPLE'));
  const summary = await fillExampleCache([{ url: `${server.origin}/a` }], { directory, assets: locked, ...quick });
  assert.equal(summary.downloaded.length, 1);
  assert.deepEqual(await readFile(path), bodies['/a']);
});

test('a download that does not match the lock is rejected by URL, not retried, and leaves no entry', async t => {
  const server = await fixtureServer(t, (_request, response) => response.end('tampered bytes'));
  const directory = await cacheDirectory(t);
  const url = `${server.origin}/a`;
  const locked = { [url]: { sha256: hash('expected bytes'), bytes: 14 } };
  await assert.rejects(fillExampleCache([{ url }], { directory, assets: locked, ...quick }),
    error => error.message.includes('does not match its locked SHA-256') && error.message.includes(url));
  assert.equal(server.requests.length, 1);
  assert.deepEqual(await readdir(directory), []);
});

// A clock the test advances itself: sleeping records the wait and moves the time.
function fakeClock() {
  const clock = { time: Date.parse('2026-11-12T00:00:00Z'), waits: [] };
  clock.now = () => clock.time;
  clock.sleep = async ms => {
    clock.waits.push(ms);
    clock.time += ms;
  };
  return clock;
}

for (const [form, header] of [
  ['seconds', () => '120'],
  ['an HTTP date', clock => new Date(clock.time + 120_000).toUTCString()],
]) {
  test(`a 429 is retried after the whole wait its Retry-After names in ${form}, not after the backoff`, async t => {
    const content = Buffer.from('rate limited once');
    const clock = fakeClock();
    const server = await fixtureServer(t, (_request, response, count) => {
      if (count === 1) response.writeHead(429, { 'retry-after': header(clock) }).end();
      else response.end(content);
    });
    const directory = await cacheDirectory(t);
    const url = `${server.origin}/a`;
    const events = [];
    const summary = await fillExampleCache([{ url }], {
      directory,
      assets: lockFor(server.origin, { '/a': content }),
      baseDelay: 1,
      maxDelay: 5,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: event => events.push(event),
    });
    assert.deepEqual(clock.waits, [120_000]);
    assert.deepEqual(events, [{ type: 'retry', url, attempt: 1, delay: 120_000, reason: 'HTTP 429' }]);
    assert.deepEqual(summary.downloaded, [url]);
    assert.deepEqual(await readFile(exampleCachePath(directory, url)), content);
  });
}

test('a five-minute rate limit is waited out within the default deadline', async t => {
  const content = Buffer.from('rate limited three times');
  const clock = fakeClock();
  const server = await fixtureServer(t, (_request, response, count) => {
    if (count <= 3) response.writeHead(429, { 'retry-after': '300' }).end();
    else response.end(content);
  });
  const directory = await cacheDirectory(t);
  const url = `${server.origin}/a`;
  await fillExampleCache([{ url }], { directory, assets: lockFor(server.origin, { '/a': content }), now: clock.now, sleep: clock.sleep });
  assert.deepEqual(clock.waits, [300_000, 300_000, 300_000]);
  assert.deepEqual(await readFile(exampleCachePath(directory, url)), content);
});

test('a Retry-After longer than what is left of the deadline fails at once, naming the URL and the wait', async t => {
  const clock = fakeClock();
  const server = await fixtureServer(t, (_request, response) => response.writeHead(429, { 'retry-after': '300' }).end());
  const directory = await cacheDirectory(t);
  const url = `${server.origin}/a`;
  const options = { directory, assets: lockFor(server.origin, { '/a': Buffer.from('x') }), now: clock.now, sleep: clock.sleep };
  await assert.rejects(fillExampleCache([{ url }], { ...options, deadline: 120_000 }), error => error.message ===
    `Cannot download example ${url}: HTTP 429; the server asked for a wait of 300 s (Retry-After: 300), but 120 s of the 120 s deadline for filling the cache remain`);
  assert.deepEqual(clock.waits, []);
  assert.equal(server.requests.length, 1);
  // Two waits fit in eleven minutes; the third would end after them.
  await assert.rejects(fillExampleCache([{ url }], { ...options, deadline: 660_000 }), error =>
    error.message.includes(url) && error.message.includes('a wait of 300 s') && error.message.includes('60 s of the 660 s deadline'));
  assert.deepEqual(clock.waits, [300_000, 300_000]);
  assert.equal(server.requests.length, 4);
  assert.deepEqual(await readdir(directory), []);
});

test('a response that stalls is abandoned at the timeout, never visible under its final name, and the next attempt completes', async t => {
  const content = Buffer.from('arrives on the second attempt');
  const directory = await cacheDirectory(t);
  let entriesMidDownload;
  const server = await fixtureServer(t, async (_request, response, count) => {
    if (count > 1) return response.end(content);
    response.writeHead(200, { 'content-length': content.length }).write(content.subarray(0, 5));
    // The client gives up only after its partial file exists, so look once it does.
    while (!response.destroyed && !entriesMidDownload?.length) {
      entriesMidDownload = await readdir(directory);
      await delay(5);
    }
  });
  const url = `${server.origin}/a`;
  const events = [];
  await fillExampleCache([{ url }], {
    directory,
    assets: lockFor(server.origin, { '/a': content }),
    timeout: 1000,
    ...quick,
    onEvent: event => events.push(event.reason),
  });
  assert.deepEqual(events, ['no complete response within 1000 ms']);
  // An interrupted run must not leave bytes under the name the audit reads.
  assert.equal(entriesMidDownload.length, 1);
  assert.match(entriesMidDownload[0], /\.partial$/);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(await readdir(directory), [hash(url)]);
  assert.deepEqual(await readFile(exampleCachePath(directory, url)), content);
});

test('a failing server is retried a bounded number of times and a missing file not at all', async t => {
  const server = await fixtureServer(t, (request, response) => response.writeHead(request.url === '/gone' ? 404 : 503).end());
  const directory = await cacheDirectory(t);
  const locked = lockFor(server.origin, { '/gone': Buffer.from('x'), '/down': Buffer.from('y') });
  await assert.rejects(fillExampleCache([{ url: `${server.origin}/gone` }], { directory, assets: locked, ...quick }),
    error => error.message === `Cannot download example ${server.origin}/gone: HTTP 404`);
  assert.equal(server.requests.length, 1);
  await assert.rejects(fillExampleCache([{ url: `${server.origin}/down` }], { directory, assets: locked, retries: 2, ...quick }),
    error => error.message === `Cannot download example ${server.origin}/down after 3 attempts: HTTP 503`);
  assert.equal(server.requests.filter(path => path === '/down').length, 3);
  assert.deepEqual(await readdir(directory), []);
});

test('a file without a lock entry stops the run before any request', async t => {
  const server = await fixtureServer(t, (_request, response) => response.end('x'));
  const directory = await cacheDirectory(t);
  const locked = lockFor(server.origin, { '/a': Buffer.from('x') });
  await assert.rejects(fillExampleCache([{ url: `${server.origin}/a` }, { url: `${server.origin}/unlocked` }], { directory, assets: locked }),
    /Missing locked SHA-256 for cached example: .*\/unlocked/);
  assert.equal(server.requests.length, 0);
});

test('no more than the stated number of downloads run at once', async t => {
  const bodies = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`/${index}`, Buffer.from(`example ${index}`)]));
  let open = 0;
  let peak = 0;
  const server = await fixtureServer(t, (request, response) => {
    open += 1;
    peak = Math.max(peak, open);
    setTimeout(() => {
      open -= 1;
      response.end(bodies[request.url]);
    }, 30);
  });
  const directory = await cacheDirectory(t);
  const files = Object.keys(bodies).map(path => ({ url: `${server.origin}${path}` }));
  const summary = await fillExampleCache(files, { directory, assets: lockFor(server.origin, bodies), concurrency: 2, ...quick });
  assert.equal(summary.downloaded.length, 7);
  assert.equal(peak, 2);
});

test('pruning removes entries the files do not use, and only when asked', async t => {
  const bodies = { '/a': Buffer.from('kept') };
  const server = await fixtureServer(t, (request, response) => response.end(bodies[request.url]));
  const directory = await cacheDirectory(t);
  const options = { directory, assets: lockFor(server.origin, bodies), ...quick };
  const files = [{ url: `${server.origin}/a` }];
  const stale = [hash('an example the lock dropped'), `${hash('interrupted')}.partial`];
  for (const name of stale) await writeFile(join(directory, name), 'old');
  await fillExampleCache(files, options);
  assert.equal((await readdir(directory)).length, 3);
  const summary = await fillExampleCache(files, { ...options, prune: true });
  assert.deepEqual(summary.pruned.sort(), stale.sort());
  assert.deepEqual(await readdir(directory), [hash(files[0].url)]);
});

test('the audit caches the first example of each app, the one it imports', () => {
  const examples = [{ id: 'first', files: [{ url: 'a' }, { url: 'b' }] }, { id: 'second', files: [{ url: 'c' }] }];
  assert.deepEqual(auditedExampleFiles(examples), [{ url: 'a' }, { url: 'b' }]);
  assert.deepEqual(auditedExampleFiles([]), []);
});

test('an offline app\'s audit files are the runtime its lock entry pins, and no other app has any', async () => {
  const lock = JSON.parse(await readFile(new URL('../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
  assert.ok(OFFLINE_AUDIT_APPS.includes('dicompare'));
  const urls = auditedRuntimeFiles({ id: 'dicompare' }, lock).map(file => file.url);
  // What the hosted page fetched from other hosts on 2026-11-12, by kind.
  for (const expected of [
    'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.asm.wasm',
    'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/python_stdlib.zip',
    'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/scipy-1.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl',
    'https://files.pythonhosted.org/packages/64/52/fc88de4696f87c4b7316bb26082e7652961c59fb66de8da5c05667cdcdac/dicompare-0.11.1-py3-none-any.whl',
  ]) {
    assert.ok(urls.includes(expected), `${expected} is cached for the audit`);
  }
  for (const url of urls) {
    assert.match(lock.assets[url].sha256, /^[a-f0-9]{64}$/, url);
    assert.match(url, /^https:\/\/(cdn\.jsdelivr\.net\/pyodide\/v\d+\.\d+\.\d+\/|files\.pythonhosted\.org\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60}\/)/, `${url} is immutable`);
  }
  assert.ok(urls.every(url => lock.assets[url].kind !== 'example'), 'examples are listed by auditedExampleFiles');
  assert.deepEqual(auditedRuntimeFiles({ id: 'neuromorph' }, lock), []);
});

test('the index answer for a project offers only its locked wheel, with its hash and no metadata shortcut', () => {
  const wheel = 'https://files.pythonhosted.org/packages/aa/bb/cc/Typing_Extensions-1.2.3-py3-none-any.whl';
  const other = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl';
  const locked = { [wheel]: { kind: 'python-wheel', sha256: 'a'.repeat(64) }, [other]: { kind: 'python-runtime', sha256: 'b'.repeat(64) } };
  const answers = pythonIndexAnswers([{ url: wheel }, { url: other }], locked);
  assert.deepEqual([...answers.keys()], ['typing-extensions']);
  assert.deepEqual(JSON.parse(answers.get('typing-extensions')), {
    meta: { 'api-version': '1.0' },
    name: 'typing-extensions',
    files: [{ filename: 'Typing_Extensions-1.2.3-py3-none-any.whl', url: wheel, hashes: { sha256: 'a'.repeat(64) } }],
  });
  assert.equal(pythonIndexProject('https://pypi.org/simple/typing_extensions/'), 'typing-extensions');
  assert.equal(pythonIndexProject('https://pypi.org/pypi/typing-extensions/json'), null);
  assert.equal(pythonIndexProject(wheel), null);
});
