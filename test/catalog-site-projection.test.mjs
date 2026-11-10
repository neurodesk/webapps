import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { findApp, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppInformation } from '../scripts/lib/app-information.mjs';
import { SHARED_ROOT_FILES, hostedThemeOptions, projectCatalogSite, projectHubSite, runtimeReferences, workerConfig, workerSites } from '../scripts/lib/catalog-sites.mjs';
import { loadNotFoundTemplate } from '../scripts/lib/not-found-page.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { emptyAnalytics } from '../scripts/write-analytics.mjs';

const full = await loadAppsRegistry();
// dicomview (home neuro, copied to msk) and musclemap (msk) keep the fixture small.
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
  await put(siteDist, 'analytics.json', JSON.stringify(emptyAnalytics(registry)));
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
  assert.match(html, /<html data-neurodesk-catalog="neuro"/);
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
  // dicomview is also_in msk: the copy brings its runtime families and hands off to msk's apps only.
  assert.deepEqual(msk.apps, ['dicomview', 'musclemap']);
  assert.deepEqual(msk.families, ['_runtime/ort-web/1.21.0', '_runtime/viewer/1.0']);
  await assert.rejects(access(join(mskDir, '_runtime/unused')), { code: 'ENOENT' });
  const mskDicomview = await readFile(join(mskDir, 'dicomview/index.html'), 'utf8');
  assert.match(mskDicomview, /data-app-url="https:\/\/mskapps\.sciget\.org\/dicomview\/"/);
  assert.deepEqual([...mskDicomview.matchAll(/data-neurodesk-catalog="([^"]*)"/g)].map(([, id]) => id), ['msk']);
  // The all-app assembly also feeds the desktop suite, which no catalogue hosts.
  assert.doesNotMatch(await readFile(join(siteDist, 'dicomview/index.html'), 'utf8'), /data-neurodesk-catalog/);
  const mskPayload = JSON.parse(mskDicomview.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(mskPayload.catalog.map(({ id }) => id).sort(), ['dicomview', 'musclemap']);
  const msHtml = await readFile(join(mskDir, 'musclemap/index.html'), 'utf8');
  assert.match(msHtml, /<title>MuscleMap \| MSK Webapps<\/title>/);
  assert.match(msHtml, /data-brand-name="SciGet"/);
  await assert.rejects(access(join(mskDir, '.nojekyll')), { code: 'ENOENT' });
  await assert.rejects(access(join(mskDir, 'surf')), { code: 'ENOENT' });
  const report = JSON.parse(await readFile(join(mskDir, 'analytics.json'), 'utf8'));
  assert.deepEqual(report.apps.map(({ id }) => id), msk.apps);
  assert.equal(report.catalogs, undefined);
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

test('catalogue projection follows Vite preload paths from the app base', async t => {
  const { root, siteDist } = await fixture(t);
  const source = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["../_runtime/codecs/1/blosc.js?v=1","/_runtime/codecs/1/zstd.js"])))=>i.map(i=>d[i]);',
    'export const codec = () => import("../../_runtime/codecs/1/blosc.js");',
  ].join('\n');
  await put(siteDist, 'dicomview/assets/index-Abcd1234.js', source);
  await put(siteDist, '_runtime/codecs/1/blosc.js', 'import "./helper.js";');
  await put(siteDist, '_runtime/codecs/1/zstd.js', 'export {};');
  await put(siteDist, '_runtime/codecs/1/helper.js', 'export {};');
  const destination = join(root, 'out');
  await projectCatalogSite({
    repoRoot, siteDist, destination, registry, catalog: findCatalog(full, 'neuro'), information, standalone, notFoundTemplate,
  });
  for (const name of ['blosc.js', 'zstd.js', 'helper.js']) {
    await access(join(destination, '_runtime/codecs/1', name));
  }
  assert.equal(await readFile(join(destination, 'dicomview/assets/index-Abcd1234.js'), 'utf8'), source);
  assert.deepEqual(runtimeReferences(source, join(siteDist, 'dicomview/assets/index-Abcd1234.js'), siteDist)
    .map(({ target }) => target), ['blosc.js', 'zstd.js', 'blosc.js'].map(name => join(siteDist, '_runtime/codecs/1', name)));
});

test('the hub site holds the hub page and nothing it does not load', async (t) => {
  const { root, siteDist } = await fixture(t);
  const hubDir = join(root, 'dist-sites/hub');
  await projectHubSite({ siteDist, destination: hubDir, registry: full });
  assert.deepEqual((await readdir(hubDir)).sort(), ['_headers', 'fonts', 'index.html', 'landing.css', 'sciget-logo.svg', 'theme.js']);
});

test('the Worker-hosted sites deploy as assets-only Workers on their own domains', () => {
  assert.deepEqual(workerSites(full), [
    { host: 'mskapps.sciget.org', site: 'msk' },
    { host: 'microscopyapps.sciget.org', site: 'microscopy' },
    { host: 'preclinicalapps.sciget.org', site: 'preclinical' },
    { host: 'webapps.sciget.org', site: 'hub' },
  ]);
  assert.deepEqual(workerConfig('mskapps.sciget.org', 'msk'), {
    name: 'mskapps-sciget-org',
    compatibility_date: '2026-07-12',
    workers_dev: false,
    routes: [{ pattern: 'mskapps.sciget.org', custom_domain: true }],
    assets: { directory: './msk', html_handling: 'auto-trailing-slash', not_found_handling: '404-page' },
  });
  assert.ok(!('main' in workerConfig('webapps.sciget.org', 'hub')), 'assets only, no Worker script');
});

test('the deploy workflow deploys every Worker site the registry declares', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/deploy-pages.yml'), 'utf8'));
  const matrix = workflow.jobs['deploy-workers'].strategy.matrix.include;
  assert.deepEqual(matrix, workerSites(full).map(({ host, site }) => ({ site, url: `https://${host}/` })));
  const catalogSites = workerSites(full).filter(({ site }) => site !== 'hub');
  assert.deepEqual(workflow.jobs['verify-workers'].strategy.matrix.include, catalogSites.map(({ host, site }) => ({ site, url: `https://${host}/` })));
  const upload = workflow.jobs.build.steps.find((step) => step.with?.name === 'worker-sites');
  assert.deepEqual(upload.with.path.trim().split('\n'), workerSites(full).flatMap(({ site }) => [`dist-sites/${site}`, `dist-sites/${site}.wrangler.json`]));
  const hubCheck = workflow.jobs['deploy-workers'].steps.find((step) => step.name === 'Check the hub lists every catalogue');
  assert.match(hubCheck.run, new RegExp(`for host in ${full.site.catalogs.map(({ host }) => host).join(' ')}; do`), 'the hub check covers every catalogue');
  const pages = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('actions/upload-pages-artifact'));
  const primary = full.site.catalogs.find((catalog) => catalog.hosting === 'pages');
  assert.equal(pages.with.path, `dist-sites/${primary.id}`);
  for (const step of workflow.jobs.deploy.steps.filter((candidate) => candidate.env?.BASE_URL)) {
    assert.equal(step.env.SITE_CATALOG, primary.id, `${step.name} checks only the Pages catalogue`);
  }
});

test('an app copy takes the URL and brand of the host that serves it', () => {
  const app = findApp(full, 'elastix');
  const home = hostedThemeOptions({ registry: full, information, app, version: '1.0.0' });
  const copy = hostedThemeOptions({ registry: full, information, app, version: '1.0.0', catalog: findCatalog(full, 'microscopy') });
  assert.equal(home.url, 'https://webapps.neurodesk.org/elastix/');
  assert.equal(home.brandName, 'Neurodesk');
  assert.equal(copy.url, 'https://microscopyapps.sciget.org/elastix/');
  assert.equal(copy.brandName, 'SciGet');
  assert.equal(copy.siteTitle, 'Microscopy Webapps');
});
