import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkLink, checkLinks, dockerHubTagUrl, standaloneLinks } from '../scripts/check-standalone-links.mjs';

const catalog = JSON.parse(await readFile(new URL('../registry/standalone.json', import.meta.url), 'utf8'));

test('Docker images become the Docker Hub tag that must exist', () => {
  assert.equal(dockerHubTagUrl('vnmd/ants_2.6.5:20261012'), 'https://hub.docker.com/v2/repositories/vnmd/ants_2.6.5/tags/20261012');
  assert.equal(dockerHubTagUrl('vnmd/topofit_0.5.1:candidate-1c96'), 'https://hub.docker.com/v2/repositories/vnmd/topofit_0.5.1/tags/candidate-1c96');
  assert.equal(dockerHubTagUrl('ubuntu'), 'https://hub.docker.com/v2/repositories/library/ubuntu/tags/latest');
});

test('every link a Standalone dialog offers is checked, with where the catalog names it', () => {
  const links = standaloneLinks(catalog);
  const where = (url) => links.get(url) ?? [];
  for (const suite of Object.values(catalog.suites)) {
    for (const download of [...suite.downloads, suite.models, ...(suite.models.parts || [])]) {
      assert.ok(links.has(download.url), download.url);
    }
  }
  for (const [id, app] of Object.entries(catalog.apps)) {
    for (const download of app.downloads) {
      for (const file of download.parts || [download]) assert.ok(links.has(file.url), `${id}: ${file.url}`);
    }
    for (const [index, container] of app.containers.entries()) {
      if (container.apptainerUrl) assert.ok(where(container.apptainerUrl).includes(`$.apps.${id}.containers[${index}].apptainerUrl`), `${id}: ${container.apptainerUrl}`);
      if (container.dockerImage) assert.ok(where(dockerHubTagUrl(container.dockerImage)).includes(`$.apps.${id}.containers[${index}].dockerImage`), `${id}: ${container.dockerImage}`);
    }
    if (app.openrecon) assert.ok(links.has(`https://github.com/neurodesk/openrecon/tree/main/recipes/${app.openrecon.recipe}`), id);
    if (app.computeServer?.download) assert.ok(links.has(app.computeServer.download.url), id);
  }
});

test('a link shared by several entries and files is checked once', () => {
  const entry = { apptainerUrl: 'https://example.test/a.simg', dockerImage: 'vnmd/a:1' };
  const links = standaloneLinks({ apps: { one: { containers: [entry] } } }, new Map(), 'standalone.json');
  standaloneLinks({ containers: { one: entry } }, links, 'neurocontainers.json');
  assert.deepEqual([...links.keys()], ['https://example.test/a.simg', 'https://hub.docker.com/v2/repositories/vnmd/a/tags/1']);
  assert.deepEqual(links.get('https://example.test/a.simg'), ['standalone.json.apps.one.containers[0].apptainerUrl', 'neurocontainers.json.containers.one.apptainerUrl']);
});

test('commands and plain names are not treated as links', () => {
  const links = standaloneLinks({ command: 'curl -X GET https://example.test/a.simg -O', apptainerName: 'a_1', url: 'http://insecure.test' });
  assert.equal(links.size, 0);
});

function fakeFetch(responses) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { status: next, body: null };
  };
  return { calls, fetcher };
}

test('a missing link fails without retrying, and a refused HEAD falls back to GET', async () => {
  const missing = fakeFetch([404]);
  assert.deepEqual(await checkLink('https://example.test/gone', { fetcher: missing.fetcher, backoffMs: 0 }), { ok: false, status: 404 });
  assert.deepEqual(missing.calls, ['HEAD https://example.test/gone']);
  const refused = fakeFetch([405, 206]);
  assert.deepEqual(await checkLink('https://example.test/file', { fetcher: refused.fetcher, backoffMs: 0 }), { ok: true, status: 206 });
  assert.deepEqual(refused.calls, ['HEAD https://example.test/file', 'GET https://example.test/file']);
});

test('network errors and transient statuses are retried before a link fails', async () => {
  const flaky = fakeFetch([new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 503, 200]);
  assert.deepEqual(await checkLink('https://example.test/flaky', { fetcher: flaky.fetcher, backoffMs: 0 }), { ok: true, status: 200 });
  assert.equal(flaky.calls.length, 3);
  const down = fakeFetch([502, 502, 502]);
  assert.deepEqual(await checkLink('https://example.test/down', { fetcher: down.fetcher, backoffMs: 0, attempts: 3 }), { ok: false, status: 502 });
});

test('results keep the order and locations of the links checked', async () => {
  const statuses = { 'https://example.test/a': 200, 'https://example.test/b': 404 };
  const fetcher = async (url) => ({ status: statuses[url], body: null });
  const results = await checkLinks([{ url: 'https://example.test/a', where: ['x'] }, { url: 'https://example.test/b', where: ['y'] }], { fetcher, concurrency: 2, backoffMs: 0 });
  assert.deepEqual(results, [
    { url: 'https://example.test/a', where: ['x'], ok: true, status: 200 },
    { url: 'https://example.test/b', where: ['y'], ok: false, status: 404 },
  ]);
});
