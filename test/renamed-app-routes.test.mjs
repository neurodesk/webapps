import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { catalogApps, findCatalog, loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { movedAppRoutes, renderNotFoundPage } from '../scripts/lib/not-found-page.mjs';

const registry = await loadAppsRegistry();
const template = await readFile(new URL('../site/404.html', import.meta.url), 'utf8');
const neuro = findCatalog(registry, 'neuro');
const msk = findCatalog(registry, 'msk');
const microscopy = findCatalog(registry, 'microscopy');

// Run the page's inline redirect at a URL on its host, as GitHub Pages or a Worker serves it.
function visit(page, route, origin) {
  const { document } = new JSDOM(page).window;
  const inline = [...document.querySelectorAll('script:not([src]):not([type])')].map(script => script.textContent).join('\n');
  const location = new URL(route, origin);
  let redirected;
  location.replace = value => { redirected = value; };
  vm.runInNewContext(inline, { location, document });
  return redirected;
}

const pages = {
  neuro: renderNotFoundPage(template, { registry, catalog: neuro }),
  msk: renderNotFoundPage(template, { registry, catalog: msk }),
  all: renderNotFoundPage(template, { registry }),
};

for (const [page, route, expected] of [
  ['neuro', '/dicom2vid', '/mri2vid'],
  ['neuro', '/dicom2vid/', '/mri2vid/'],
  ['neuro', '/dicom2vid/index.html?x=1#about', '/mri2vid/index.html?x=1#about'],
  ['all', '/dicom2vid/index.html?x=1#about', '/mri2vid/index.html?x=1#about'],
  ['neuro', '/musclemap/', 'https://mskapps.sciget.org/musclemap/'],
  ['neuro', '/musclemap/?x=1#y', 'https://mskapps.sciget.org/musclemap/?x=1#y'],
  ['neuro', '/musclemap', 'https://mskapps.sciget.org/musclemap'],
  ['neuro', '/seedseg/index.html?example=1#results', 'https://mskapps.sciget.org/seedseg/index.html?example=1#results'],
  ['neuro', '/carotid-flow/assets/app.js', 'https://mskapps.sciget.org/carotid-flow/assets/app.js'],
  ['msk', '/dicomview/?x=1#y', 'https://webapps.neurodesk.org/dicomview/?x=1#y'],
  ['msk', '/dicom2vid/x', 'https://webapps.neurodesk.org/mri2vid/x'],
]) {
  test(`${page} 404 page sends ${route} to ${expected}`, () => {
    const origin = `https://${page === 'msk' ? msk.host : neuro.host}`;
    assert.equal(visit(pages[page], route, origin), expected);
  });
}

for (const [page, route] of [
  ['neuro', '/'], ['neuro', '/missing'], ['neuro', '/dicom2video/'], ['neuro', '/mri2vid/missing'],
  ['neuro', '/dicompare/schema'], ['neuro', '/musclemapper/'], ['neuro', '/constructor/'], ['neuro', '/__proto__/'],
  ['msk', '/'], ['msk', '/musclemap/missing'],
  ['all', '/musclemap/'],
]) {
  test(`${page} 404 page leaves ${route} alone`, () => {
    assert.equal(visit(pages[page], route, `https://${page === 'msk' ? msk.host : neuro.host}`), undefined);
  });
}

test('every app outside a catalogue redirects to its home host', () => {
  for (const catalog of registry.site.catalogs) {
    const routes = movedAppRoutes(registry, catalog);
    for (const app of registry.apps) {
      if (catalogApps(registry, catalog).includes(app)) {
        assert.ok(!Object.hasOwn(routes, app.path), `${catalog.id} serves ${app.id} itself`);
      } else {
        assert.equal(routes[app.path], `https://${findCatalog(registry, app.catalog).host}/${app.path}`);
      }
    }
  }
  assert.deepEqual(movedAppRoutes(registry), { dicom2vid: '/mri2vid' });
});

test('each 404 page names its catalogue and loads dicompare routing only where dicompare is served', () => {
  for (const [page, catalog] of [['neuro', neuro], ['msk', msk]]) {
    const { document } = new JSDOM(pages[page]).window;
    assert.equal(document.title, `Page not found | ${catalog.title}`);
    assert.match(document.querySelector('a[href="/"]').textContent, new RegExp(catalog.title));
    const servesDicompare = catalogApps(registry, catalog).some(({ id }) => id === 'dicompare');
    assert.equal(Boolean(document.querySelector('script[src="/dicompare/dicompare-routes.js"]')), servesDicompare);
  }
  assert.ok(catalogApps(registry, neuro).some(({ id }) => id === 'dicompare'));
});

test('an app served by several catalogues stays on each of them and redirects elsewhere to its home', () => {
  assert.ok(catalogApps(registry, microscopy).some(({ id }) => id === 'elastix'));
  assert.ok(catalogApps(registry, neuro).some(({ id }) => id === 'elastix'));
  assert.equal(movedAppRoutes(registry, microscopy).elastix, undefined);
  assert.equal(movedAppRoutes(registry, neuro).elastix, undefined);
  assert.equal(movedAppRoutes(registry, msk).elastix, 'https://webapps.neurodesk.org/elastix');
});
