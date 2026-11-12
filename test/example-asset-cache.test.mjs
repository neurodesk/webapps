import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditedExampleFiles, exampleCachePath, fillExampleCache, loadVerifiedExampleCache } from '../scripts/lib/example-asset-cache.mjs';
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

test('a 429 is retried after its Retry-After, not after the backoff', async t => {
  const content = Buffer.from('rate limited once');
  const server = await fixtureServer(t, (_request, response, count) => {
    if (count === 1) response.writeHead(429, { 'retry-after': '0' }).end();
    else response.end(content);
  });
  const directory = await cacheDirectory(t);
  const url = `${server.origin}/a`;
  const events = [];
  const summary = await fillExampleCache([{ url }], {
    directory,
    assets: lockFor(server.origin, { '/a': content }),
    baseDelay: 3_600_000,
    maxDelay: 3_600_000,
    onEvent: event => events.push(event),
  });
  assert.deepEqual(events, [{ type: 'retry', url, attempt: 1, delay: 0, reason: 'HTTP 429' }]);
  assert.deepEqual(summary.downloaded, [url]);
  assert.deepEqual(await readFile(exampleCachePath(directory, url)), content);
});

test('a response that stalls is abandoned at the timeout, never visible under its final name, and the next attempt completes', async t => {
  const content = Buffer.from('arrives on the second attempt');
  const entriesMidDownload = [];
  const server = await fixtureServer(t, (_request, response, count) => {
    if (count > 1) return response.end(content);
    response.writeHead(200, { 'content-length': content.length }).write(content.subarray(0, 5));
    setTimeout(async () => entriesMidDownload.push(...await readdir(directory)), 100);
  });
  const directory = await cacheDirectory(t);
  const url = `${server.origin}/a`;
  const events = [];
  await fillExampleCache([{ url }], {
    directory,
    assets: lockFor(server.origin, { '/a': content }),
    timeout: 200,
    ...quick,
    onEvent: event => events.push(event.reason),
  });
  assert.deepEqual(events, ['no complete response within 200 ms']);
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
