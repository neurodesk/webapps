// Checks the catalogue sites `pnpm build` writes to dist-sites/ against the
// all-app assembly in dist/. Run after a build (CI composite-site, Pages deploy).
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { catalogApps, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { HUB_SITE, SITES_DIR, runtimeClosure } from '../scripts/lib/catalog-sites.mjs';

const registry = await loadAppsRegistry();
const dist = join(repoRoot, 'dist');
const sites = join(repoRoot, SITES_DIR);
const MOVED = ['musclemap', 'seedseg', 'carotid-flow'];
const TEXT = new Set(['.html', '.js', '.mjs', '.css']);
const ATTRIBUTE = /\b(?:src|href)=["']([^"']+)["']/g;
const LITERAL = /(['"`])((?:\.\.?\/|\/)[^'"`\s]*)\1/g;

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Paths a page or module names relative to itself or the site root. Many bundled
// strings only look like paths (Emscripten's /dev/stdin), so a path counts when
// it names a file of the all-app assembly.
function references(source, file) {
  const pattern = extname(file) === '.html' ? ATTRIBUTE : LITERAL;
  return [...source.matchAll(pattern)]
    .map((match) => match[pattern === ATTRIBUTE ? 1 : 2])
    .filter((reference) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(reference))
    .map((reference) => reference.split(/[?#]/)[0])
    .filter(Boolean);
}

for (const catalog of registry.site.catalogs) {
  const site = join(sites, catalog.id);
  const apps = catalogApps(registry, catalog);
  const primary = catalog.host === registry.site.domain;

  test(`${catalog.host} holds exactly the apps of catalogue ${catalog.id}`, async () => {
    const directories = (await readdir(site, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name);
    const shared = ['_runtime', 'fonts', 'shell-adapters', ...(primary ? ['surf'] : [])];
    assert.deepEqual(directories.sort(), [...shared, ...apps.map(({ path }) => path)].sort());
    const standalone = JSON.parse(await readFile(join(site, 'standalone.json'), 'utf8'));
    assert.deepEqual(Object.keys(standalone.apps).sort(), apps.map(({ id }) => id).sort());
    const landing = await readFile(join(site, 'index.html'), 'utf8');
    const listed = new Set([...landing.matchAll(/data-app-id="([^"]+)"/g)].map((match) => match[1]));
    assert.deepEqual([...listed].sort(), apps.map(({ id }) => id).sort());
  });

  test(`${catalog.host} serves every runtime family its files reference, and no other`, async () => {
    const families = await runtimeClosure(site, await walk(site));
    const served = [];
    for (const name of await readdir(join(site, '_runtime'))) {
      for (const version of await readdir(join(site, '_runtime', name))) served.push(join(site, '_runtime', name, version));
    }
    assert.deepEqual(served.sort(), families);
  });

  test(`${catalog.host} keeps every reference that resolves in the all-app assembly`, async () => {
    const missing = new Set();
    for (const file of (await walk(site)).filter((path) => TEXT.has(extname(path)))) {
      const path = relative(site, file);
      const own = path.includes(sep) ? join(site, path.split(sep)[0]) : site;
      for (const reference of references(await readFile(file, 'utf8'), file)) {
        const target = reference.startsWith('/') ? join(site, reference) : resolve(dirname(file), reference);
        if (target.startsWith(own + sep) && own !== site) continue;
        const counterpart = join(dist, relative(site, target));
        if (await exists(counterpart) && !await exists(target)) missing.add(`${path} -> ${reference}`);
      }
    }
    // landing.js fetches the usage report only where the landing page has its section.
    const expected = primary ? [] : ['landing.js -> ./analytics.json'];
    assert.deepEqual([...missing], expected);
  });

  test(`${catalog.host} app pages offer handoffs only to apps on the same host`, async () => {
    const ids = apps.map(({ id }) => id);
    for (const app of apps) {
      const html = await readFile(join(site, app.path, 'index.html'), 'utf8');
      const payload = JSON.parse(html.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
      for (const entry of payload.catalog) assert.ok(ids.includes(entry.id), `${app.id} offers ${entry.id}, which ${catalog.host} does not serve`);
      assert.match(html, new RegExp(`data-app-url="https://${catalog.host.replaceAll('.', '\\.')}/${app.path}/"`));
      assert.match(html, new RegExp(`data-brand-name="${catalog.brand.name}"`));
      assert.match(html, new RegExp(`<html\\b[^>]*\\sdata-neurodesk-catalog="${catalog.id}"`));
    }
  });
}

test('the neurodesk DICOM View menu leaves out the apps that moved to mskapps.sciget.org', async () => {
  const html = await readFile(join(sites, 'neuro', 'dicomview', 'index.html'), 'utf8');
  const { catalog } = JSON.parse(html.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
  const offered = catalog.map(({ id }) => id);
  for (const moved of MOVED) assert.ok(!offered.includes(moved), `DICOM View must not offer ${moved}`);
  assert.ok(offered.includes('white-matter-lesions'));
});

test('webapps.neurodesk.org redirects the moved apps to mskapps.sciget.org', async () => {
  for (const moved of MOVED) assert.equal(await exists(join(sites, 'neuro', moved)), false, `${moved} is not served from neuro`);
  const page = await readFile(join(sites, 'neuro', '404.html'), 'utf8');
  const routes = JSON.parse(page.match(/id="moved-apps">([\s\S]*?)<\/script>/)[1]);
  for (const moved of MOVED) assert.equal(routes[moved], `https://mskapps.sciget.org/${moved}`);
  assert.equal(routes.dicom2vid, '/mri2vid');
});

test('the all-app assembly still holds every app for the desktop suite', async () => {
  for (const app of registry.apps) assert.ok(await exists(join(dist, app.path, 'index.html')), app.id);
  const html = await readFile(join(dist, 'dicomview', 'index.html'), 'utf8');
  const { catalog } = JSON.parse(html.match(/data-neurodesk-app-information>([\s\S]*?)<\/script>/)[1]);
  for (const moved of MOVED) assert.ok(catalog.some(({ id }) => id === moved), `the desktop suite hands off to ${moved}`);
});

test('the hub holds only the hub page and what it loads', async () => {
  const hub = join(sites, HUB_SITE);
  assert.deepEqual((await readdir(hub)).sort(), ['_headers', 'fonts', 'index.html', 'landing.css', registry.site.hub.brand.logo, 'theme.js'].sort());
  const html = await readFile(join(hub, 'index.html'), 'utf8');
  for (const reference of references(html, join(hub, 'index.html'))) assert.ok(await exists(join(hub, reference)), reference);
  for (const catalog of registry.site.catalogs) assert.match(html, new RegExp(`href="https://${catalog.host.replaceAll('.', '\\.')}/"`));
});
