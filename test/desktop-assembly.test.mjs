import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { catalogApps, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppInformation } from '../scripts/lib/app-information.mjs';
import { SHARED_ROOT_FILES } from '../scripts/lib/catalog-sites.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { emptyAnalytics } from '../scripts/write-analytics.mjs';
import { assembleSuite } from '../scripts/desktop/assemble.mjs';
import { suiteCatalog } from '../scripts/desktop/suite.mjs';
import { fileHash, verifyBundle } from '../packages/desktop/src/bundle.js';
import { startOfflineServer } from '../packages/desktop/src/server.js';

const registry = await loadAppsRegistry();
const standalone = await loadStandalone(registry);
const information = await loadAppInformation(registry);
const assetUrl = id => `https://example.test/${id}/model.bin`;

async function put(root, path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

// An all-app dist, one pinned asset per app and a cache holding them, without downloading anything.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-assemble-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  for (const name of SHARED_ROOT_FILES) await put(dist, name.includes('.') ? name : `${name}/keep.txt`, '');
  for (const path of ['app-theme.css', 'fonts']) await cp(join(repoRoot, 'site', path), join(dist, path), { recursive: true });
  await put(dist, 'analytics.json', JSON.stringify(emptyAnalytics(registry)));
  await put(dist, 'surf/index.html', '<!doctype html><html><head><title>surf</title></head><body></body></html>');
  for (const app of registry.apps) {
    const runtime = app.id === 'zarro' ? '<script type="module" src="../_runtime/viewer/1.0/viewer.js"></script>' : '';
    await put(dist, `${app.path}/index.html`, `<!doctype html><html><head><title>x</title><link rel="stylesheet" href="../app-theme.css">${runtime}</head><body>Offline app</body></html>`);
  }
  await put(dist, '_runtime/viewer/1.0/viewer.js', 'export {};');
  await put(dist, '_runtime/unused/2.0/unused.js', 'export {};');
  const cache = join(root, 'cache');
  await mkdir(cache);
  const lock = { assets: {}, apps: {} };
  const sources = { apps: {}, python: { base: 'https://example.test/python/', packages: [], wheels: [] } };
  for (const app of registry.apps) {
    const sha256 = createHash('sha256').update(app.id).digest('hex');
    await writeFile(join(cache, sha256), app.id);
    lock.assets[assetUrl(app.id)] = { sha256, bytes: Buffer.byteLength(app.id), kind: 'model', dependencies: [] };
    lock.apps[app.id] = [assetUrl(app.id)];
    sources.apps[app.id] = [{ url: assetUrl(app.id), kind: 'model' }];
  }
  return { root, dist, cache, lock, sources };
}

async function assemble(t, catalogId, ids) {
  const { root, ...inputs } = await fixture(t);
  const destination = join(root, 'offline');
  const catalog = findCatalog(registry, catalogId);
  await assembleSuite({ registry, catalog, ids, destination, standalone, information, version: '0.1.20261110', ...inputs });
  return { destination, catalog, dist: inputs.dist };
}

test('the suite defaults to the primary catalogue and takes another by --catalog', () => {
  assert.equal(suiteCatalog(registry, undefined).id, 'neuro');
  assert.equal(suiteCatalog(registry, 'msk').id, 'msk');
  assert.throws(() => suiteCatalog(registry, 'unknown'), /Unknown catalog 'unknown'/);
});

test('a catalogue suite holds exactly the apps, landing page, handoffs and assets of its host', async t => {
  const { destination, catalog } = await assemble(t, 'microscopy');
  const apps = catalogApps(registry, catalog);
  const ids = apps.map(app => app.id).sort();
  assert.ok(ids.includes('elastix') && !ids.includes('synthseg'), 'microscopy serves a copy of elastix and no neuro-only app');
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
  assert.equal(manifest.catalog, 'microscopy');
  assert.equal(manifest.defaultApp, null);
  assert.deepEqual(manifest.apps.map(entry => entry.id).sort(), ids);
  assert.deepEqual(Object.keys(manifest.assets).sort(), ids.map(assetUrl).sort());
  const site = (await readdir(join(destination, 'site'))).sort();
  assert.deepEqual(site, [...new Set([...apps.map(app => app.path), ...SHARED_ROOT_FILES, '_runtime', 'analytics.json', 'index.html', 'standalone.json'])].sort());
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'site/analytics.json'))).apps.map(app => app.id).sort(), ids, 'the usage report covers only the suite\'s apps');
  assert.deepEqual(await readdir(join(destination, 'site/_runtime')), ['viewer']);
  const landing = new JSDOM(await readFile(join(destination, 'site/index.html'), 'utf8')).window.document;
  assert.equal(landing.title, 'Microscopy Webapps');
  assert.equal(landing.querySelector('#elsewhere-apps, #elsewhere'), null, 'an offline suite offers no other catalogue\'s apps');
  assert.deepEqual([...new Set([...landing.querySelectorAll('[data-app-card]')].map(card => card.dataset.appId))].sort(), ids);
  for (const id of ['elastix', 'zarro']) {
    const html = await readFile(join(destination, 'site', id, 'index.html'), 'utf8');
    const payload = JSON.parse(html.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
    const handoffs = payload.catalog.map(entry => entry.id);
    assert.ok(handoffs.includes('niimath') && handoffs.every(handoff => ids.includes(handoff)), `${id} hands off only to the suite's apps: ${handoffs}`);
    assert.match(html, /data-brand-name="SciGet"/);
    assert.match(html, /\| Microscopy Webapps<\/title>/);
  }
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(destination, 'site/standalone.json')))).sort(), Object.keys(standalone).sort());
  await verifyBundle(destination);
});

test('a suite of some of its catalogue apps lists only them, and refuses another catalogue app', async t => {
  const { destination } = await assemble(t, 'microscopy', ['zarro']);
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
  assert.deepEqual(manifest.apps.map(entry => entry.id), ['zarro']);
  assert.equal(manifest.defaultApp, 'zarro');
  assert.deepEqual(Object.keys(manifest.assets), [assetUrl('zarro')]);
  await assert.rejects(assemble(t, 'microscopy', ['musclemap']), /Not in the microscopy catalogue: musclemap/);
});

test('the primary suite keeps the game and serves fonts offline', async t => {
  const { destination, dist } = await assemble(t, 'neuro');
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
  assert.deepEqual(manifest.apps.map(entry => entry.id).sort(), catalogApps(registry, findCatalog(registry, 'neuro')).map(app => app.id).sort());
  assert.ok(!manifest.apps.some(entry => entry.id === 'musclemap'), 'MuscleMap ships in the MSK suite');
  for (const path of ['analytics.json', 'surf/index.html', '_offline/python.json']) await readFile(join(destination, 'site', path));
  for (const path of ['404.html', '_headers', '.nojekyll']) await assert.rejects(readFile(join(destination, 'site', path)), { code: 'ENOENT' });
  for (const path of ['fonts/inter.woff2', 'fonts/OFL.txt']) {
    assert.equal(manifest.files[`site/${path}`].sha256, await fileHash(join(dist, path)));
  }
  const { server, origin } = await startOfflineServer(destination);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stylesheetUrl = new URL('../app-theme.css', `${origin}/mri2vid/`);
  const stylesheet = await (await fetch(stylesheetUrl)).text();
  const fontPath = /url\(["']?(fonts\/[^)"']+)/.exec(stylesheet)?.[1];
  assert.equal(fontPath, 'fonts/inter.woff2');
  const response = await fetch(new URL(fontPath, stylesheetUrl));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(repoRoot, 'site/fonts/inter.woff2')));
  await writeFile(join(destination, 'site/fonts/inter.woff2'), 'corrupt font');
  await assert.rejects(verifyBundle(destination), /missing or corrupt: site\/fonts\/inter\.woff2/);
});

// Serves each app's pinned asset as the fixture locked it, or `body(id)` instead.
async function assetServer(t, body = id => id) {
  const { createServer } = await import('node:http');
  const requested = [];
  const server = createServer((request, response) => {
    const id = request.url.split('/')[1];
    requested.push(id);
    response.end(body(id));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, requested };
}

// The fixture's assets at the server's URLs, with an empty cache.
async function uncached(t, origin) {
  const inputs = await fixture(t);
  const moved = url => url.replace('https://example.test', origin);
  const lock = { assets: {}, apps: {} };
  for (const [url, asset] of Object.entries(inputs.lock.assets)) lock.assets[moved(url)] = asset;
  for (const [id, urls] of Object.entries(inputs.lock.apps)) lock.apps[id] = urls.map(moved);
  for (const list of Object.values(inputs.sources.apps)) for (const source of list) source.url = moved(source.url);
  await rm(inputs.cache, { recursive: true });
  return { ...inputs, lock };
}

test('a suite fetches the locked assets of its own apps that the cache lacks, and only those', async t => {
  const { origin, requested } = await assetServer(t);
  const { root, ...inputs } = await uncached(t, origin);
  const catalog = findCatalog(registry, 'microscopy');
  const destination = join(root, 'offline');
  await assembleSuite({ registry, catalog, destination, standalone, information, version: '0.1.20261110', ...inputs });
  const ids = catalogApps(registry, catalog).map(app => app.id);
  assert.deepEqual(requested.sort(), [...ids].sort());
  for (const id of ids) {
    const sha256 = createHash('sha256').update(id).digest('hex');
    assert.equal(await readFile(join(destination, 'assets', sha256), 'utf8'), id);
    assert.equal(await fileHash(join(inputs.cache, sha256)), sha256);
  }
});

test('a fetched asset whose bytes differ from the lock fails the suite and stays out of the cache', async t => {
  const { origin } = await assetServer(t, id => `${id} altered`);
  const { root, ...inputs } = await uncached(t, origin);
  const destination = join(root, 'offline');
  await assert.rejects(
    assembleSuite({ registry, catalog: findCatalog(registry, 'microscopy'), destination, standalone, information, version: '0.1.20261110', ...inputs }),
    /checksum mismatch/,
  );
  assert.deepEqual(await readdir(inputs.cache), []);
});
