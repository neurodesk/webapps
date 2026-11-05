import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { findApp, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppInformation } from '../scripts/lib/app-information.mjs';
import { SHARED_ROOT_FILES, projectCatalogSite, projectHubSite, runtimeReferences } from '../scripts/lib/catalog-sites.mjs';
import { loadNotFoundTemplate } from '../scripts/lib/not-found-page.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';

const full = await loadAppsRegistry();
// Two real apps, one per catalogue, keep the fixture small.
const registry = { ...full, apps: [findApp(full, 'dicomview'), findApp(full, 'musclemap')] };
const information = await loadAppInformation(full);
const standalone = await loadStandalone(full);
const notFoundTemplate = await loadNotFoundTemplate(repoRoot);

async function put(root, path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const page = (body) => `<!doctype html><html><head><title>x</title>${body}</head><body></body></html>`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'catalog-sites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  for (const name of SHARED_ROOT_FILES) await put(siteDist, name.includes('.') ? name : `${name}/keep.txt`, '');
  await put(siteDist, 'analytics.json', '{}');
  await put(siteDist, 'surf/index.html', page(''));
  await put(siteDist, 'dicomview/index.html', page('<script type="module" src="../_runtime/viewer/1.0/viewer.js"></script>'));
  await put(siteDist, 'musclemap/index.html', page('<script src="./app.js"></script>'));
  await put(siteDist, 'musclemap/app.js', 'export const model = "./model.bin";');
  // viewer reaches ort-web through a family-relative import; unused is referenced by nobody.
  await put(siteDist, '_runtime/viewer/1.0/viewer.js', 'import "../../ort-web/1.21.0/ort.mjs";\nconst wasm = new URL("../../ort-web/1.21.0/ort.wasm", import.meta.url);');
  await put(siteDist, '_runtime/ort-web/1.21.0/ort.mjs', 'export {};');
  await put(siteDist, '_runtime/ort-web/1.21.0/ort.wasm', 'wasm');
  await put(siteDist, '_runtime/unused/2.0/unused.wasm', 'wasm');
  return { root, siteDist };
}

test('a catalogue site holds its own apps and only the runtime families they reach', async (t) => {
  const { root, siteDist } = await fixture(t);
  const neuroDir = join(root, 'dist-sites/neuro');
  const neuro = await projectCatalogSite({
    repoRoot, siteDist, destination: neuroDir, registry, catalog: findCatalog(full, 'neuro'), information, standalone, notFoundTemplate,
  });
  assert.deepEqual(neuro.apps, ['dicomview']);
  assert.deepEqual(neuro.families, ['_runtime/ort-web/1.21.0', '_runtime/viewer/1.0']);
  await access(join(neuroDir, '_runtime/ort-web/1.21.0/ort.mjs'));
  await assert.rejects(access(join(neuroDir, '_runtime/unused')), { code: 'ENOENT' });
  await assert.rejects(access(join(neuroDir, 'musclemap')), { code: 'ENOENT' });
  const html = await readFile(join(neuroDir, 'dicomview/index.html'), 'utf8');
  const payload = JSON.parse(html.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.catalog.map(({ id }) => id), ['dicomview']);
  assert.match(html, /data-app-url="https:\/\/webapps\.neurodesk\.org\/dicomview\/"/);
  const manifestName = html.match(/name="neurodesk-runtime-manifest" content="\.\/([^"]+)"/)[1];
  const manifest = JSON.parse(await readFile(join(neuroDir, 'dicomview', manifestName), 'utf8'));
  assert.deepEqual(manifest.assets.map(({ url }) => url), ['../_runtime/ort-web/1.21.0/ort.wasm']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(neuroDir, 'standalone.json'), 'utf8')).apps), ['dicomview']);
  assert.match(await readFile(join(neuroDir, '404.html'), 'utf8'), /"musclemap":"https:\/\/mskapps\.sciget\.org\/musclemap"/);
  await access(join(neuroDir, '.nojekyll'));

  const mskDir = join(root, 'dist-sites/msk');
  const msk = await projectCatalogSite({
    repoRoot, siteDist, destination: mskDir, registry, catalog: findCatalog(full, 'msk'), information, standalone, notFoundTemplate,
  });
  assert.deepEqual(msk.apps, ['musclemap']);
  assert.deepEqual(msk.families, []);
  assert.deepEqual((await readdir(join(mskDir, '_runtime'))), []);
  const msHtml = await readFile(join(mskDir, 'musclemap/index.html'), 'utf8');
  assert.match(msHtml, /<title>MuscleMap \| SciGet MSK Webapps<\/title>/);
  assert.match(msHtml, /data-brand-name="SciGet"/);
  await assert.rejects(access(join(mskDir, '.nojekyll')), { code: 'ENOENT' });
  await assert.rejects(access(join(mskDir, 'surf')), { code: 'ENOENT' });
  assert.match(await readFile(join(mskDir, '_headers'), 'utf8'), /Cross-Origin-Embedder-Policy: credentialless/);
});

for (const [script, message] of [
  ['import("../_runtime/" + family + "/1.0/viewer.js");', /dicomview\/index\.html: "\.\.\/_runtime\/" does not name a file in a _runtime family/],
  ['import(`../_runtime/${family}/1.0/viewer.js`);', /dicomview\/index\.html: "\.\.\/_runtime\/\$\{family\}\/1\.0\/viewer\.js" computes a _runtime path/],
  ['import("../_runtime/viewer/1.0/missing.js");', /ENOENT/],
]) {
  test(`a runtime reference the projection cannot follow fails it: ${script}`, async (t) => {
    const { root, siteDist } = await fixture(t);
    await put(siteDist, 'dicomview/index.html', page(`<script>const family = "viewer"; ${script}</script>`));
    await assert.rejects(projectCatalogSite({
      repoRoot, siteDist, destination: join(root, 'out'), registry, catalog: findCatalog(full, 'neuro'), information, standalone, notFoundTemplate,
    }), message);
  });
}

test('runtime references resolve against the file or the site root', () => {
  const site = '/site';
  assert.deepEqual(
    runtimeReferences('a("../_runtime/x/1/a.js?v=1"); b(\'/_runtime/y/2/b.wasm\')', '/site/app/index.js', site).map(({ target }) => target),
    ['/site/_runtime/x/1/a.js', '/site/_runtime/y/2/b.wasm'],
  );
});

test('the hub site holds the hub page and nothing it does not load', async (t) => {
  const { root, siteDist } = await fixture(t);
  const hubDir = join(root, 'dist-sites/hub');
  await projectHubSite({ siteDist, destination: hubDir, registry: full });
  assert.deepEqual((await readdir(hubDir)).sort(), ['_headers', 'fonts', 'index.html', 'landing.css', 'sciget-logo.svg', 'theme.js']);
});
