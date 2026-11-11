import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry, SUPPORT_STATUSES } from '../scripts/lib/apps-registry.mjs';
import { renderLandingPage } from '../scripts/lib/landing-page.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';

test('landing page renders categorized, searchable app cards', async () => {
  const registry = await loadAppsRegistry();
  const html = renderLandingPage(registry, await loadStandalone(registry));

  assert.equal((html.match(/data-app-card/g) ?? []).length, registry.apps.reduce((count, app) => count + app.categories.length, 0));
  assert.equal((html.match(/data-category-section=/g) ?? []).length, registry.site.categories.length);
  assert.match(html, /id="app-search" type="search"/);
  assert.match(html, /data-search="[^"]*dicom[^"]*"/i);
  assert.match(html, /id="no-results"/);
  assert.match(html, /id="analytics"/);
  assert.match(html, /data-analytics-apps/);
  assert.match(html, /page-view statistics only/);
  assert.match(html, /Do Not Track and Global Privacy Control/);
  assert.match(html, /name="neurodesk-ga4-measurement-id" content="G-4Z9774J59Y"/);
  assert.match(html, /src="\.\/neurodesk-logo\.svg" alt="Neurodesk"/);
  assert.match(html, /<html lang="en" data-neurodesk-theme="dark">/);
  assert.match(html, /src="\.\/theme\.js" data-neurodesk-theme-controller/);
  assert.match(html, /data-neurodesk-theme-toggle/);
  assert.match(html, /data-neurodesk-theme-label>Light</);
  assert.equal(
    (html.match(/href="https:\/\/github\.com\/neurodesk\/webapps"/g) ?? []).length,
    2,
    'header and footer GitHub links point to the webapps repository',
  );
  assert.ok(!html.includes('href="https://github.com/neurodesk"'));
  assert.ok(!html.includes('https://neurodesk.org/overview/'));
  assert.ok(!html.includes('https://neurodesk.org/getting-started/'));
});

test('app cards omit experimental badges for every support status', async () => {
  const registry = await loadAppsRegistry();
  for (const support_status of SUPPORT_STATUSES) {
    const app = { ...registry.apps[0], support_status };
    const html = renderLandingPage({ ...registry, apps: [app] });
    const { document } = new JSDOM(html).window;
    const cards = [...document.querySelectorAll('[data-app-card]')];

    assert.equal(cards.length, app.categories.length);
    for (const card of cards) {
      assert.equal(card.querySelector('h3').textContent, app.title);
      assert.equal(card.getAttribute('href'), `./${app.path}/`);
      const category = registry.site.categories.find(({ id }) => id === card.dataset.category);
      assert.equal(card.querySelector('.app-card__topline').textContent.trim(), category.title,
        'Catalog cards show the task category; support status is internal metadata.');
      assert.doesNotMatch(card.textContent, /\bexperimental\b/i,
        'Remove the Experimental badge from app cards.');
    }
  }
});

test('app cards show data, hardware and command-line facts', async () => {
  const registry = await loadAppsRegistry();
  const html = renderLandingPage(registry, await loadStandalone(registry));
  const card = (id) => html.match(new RegExp(`<a class="app-card"[^>]*data-app-id="${id}"[\\s\\S]*?</a>`))[0];

  const synthseg = card('synthseg');
  assert.match(synthseg, /<li>Brain · MRI, CT<\/li>/);
  assert.match(synthseg, /<li>DICOM, NIfTI<\/li>/);
  assert.match(synthseg, /<li data-hardware="webgpu-required">Needs WebGPU<\/li>/);
  assert.match(synthseg, /<li>Command line<\/li>/);

  const zarro = card('zarro');
  assert.match(zarro, /<li>Microscopy<\/li>/, 'any anatomy is not shown');
  assert.match(zarro, /<li data-hardware="cpu">No GPU needed<\/li>/);
  assert.doesNotMatch(zarro, /Command line/, 'no CLI download is listed for ZARRo');

  assert.match(card('nesvor'), /<li>Compute server option<\/li>/);
  assert.match(card('pipeline-builder'), /<li>NeuroFlow workflow<\/li>/, 'Pipeline builder reads workflows, not images');
  assert.match(card('lcmodel'), /data-search="[^"]*vendor mrs[^"]*"/, 'facet labels are searchable');
  assert.match(card('brain-extraction'), /data-search="[^"]*skull stripping[^"]*"/, 'keywords stay searchable');
});

test('each catalogue lists only its own apps under its own brand', async () => {
  const { catalogApps, findCatalog } = await import('../scripts/lib/apps-registry.mjs');
  const registry = await loadAppsRegistry();
  const standalone = await loadStandalone(registry);
  for (const catalog of registry.site.catalogs) {
    const { id } = catalog;
    const apps = catalogApps(registry, catalog);
    const html = renderLandingPage({ ...registry, apps }, standalone, catalog);
    const { document } = new JSDOM(html).window;
    const listed = new Set([...document.querySelectorAll('[data-app-card]')].map(card => card.dataset.appId));
    assert.deepEqual([...listed].sort(), apps.map(({ id: appId }) => appId).sort());
    assert.equal(document.title, catalog.title);
    assert.equal(document.querySelector('h1').textContent, catalog.heading);
    assert.equal(document.querySelector('.brand img').getAttribute('src'), `./${catalog.brand.logo}`);
    assert.equal(document.querySelector('.brand').getAttribute('href'), catalog.brand.home);
    const hub = `a[href="https://${registry.site.hub.host}/"]`;
    assert.ok(document.querySelector(`.site-nav ${hub}`), 'the top bar links to the hub');
    assert.ok(document.querySelector(`.site-footer ${hub}`), 'the footer links to the hub');
    for (const section of document.querySelectorAll('[data-category-section]')) {
      assert.ok(section.querySelector('[data-app-card]'), `${id} shows no empty category`);
    }
    const primary = catalog.host === registry.site.domain;
    assert.ok(document.querySelector('#analytics'), `${id} reports usage`);
    assert.equal(Boolean(document.querySelector('a[href="./surf/"]')), primary, 'only the primary host serves the game');
  }
  const neuro = renderLandingPage({ ...registry, apps: catalogApps(registry, findCatalog(registry, 'neuro')) }, standalone, findCatalog(registry, 'neuro'));
  for (const moved of ['musclemap', 'seedseg', 'carotid-flow']) assert.doesNotMatch(neuro, new RegExp(`data-app-id="${moved}"`));
});

test('each catalogue links its own desktop suite, and none before its first release', async () => {
  const { catalogApps, findCatalog } = await import('../scripts/lib/apps-registry.mjs');
  const registry = await loadAppsRegistry();
  const standalone = await loadStandalone(registry);
  const msk = findCatalog(registry, 'msk');
  const page = (catalog, suites) => new JSDOM(renderLandingPage({ ...registry, apps: catalogApps(registry, catalog) }, { ...standalone, suites }, catalog)).window.document;
  const suite = { ...standalone.suites.neuro, version: '0.49.20261111' };
  const published = page(msk, { neuro: standalone.suites.neuro, msk: suite }).querySelectorAll('.desktop-link');
  assert.equal(published.length, 1);
  assert.equal(published[0].getAttribute('href'), 'https://github.com/neurodesk/webapps/releases/tag/msk-webapps-v0.49.20261111');
  assert.match(published[0].getAttribute('title'), /Download MSK Webapps for/);
  assert.equal(page(msk, { neuro: standalone.suites.neuro }).querySelector('.desktop-link'), null);
  const neuro = page(findCatalog(registry, 'neuro'), { neuro: suite }).querySelector('.desktop-link');
  assert.equal(neuro.getAttribute('href'), 'https://github.com/neurodesk/webapps/releases/tag/webapps-v0.49.20261111');
  // The link is rendered from the catalogue's own record; nothing rewrites it to another suite's release.
  assert.equal(page(msk, { msk: suite }).querySelector('.standalone-link'), null);
  assert.doesNotMatch(await readFile(new URL('../site/landing.js', import.meta.url), 'utf8'), /api\.github\.com|releases/);
});

test('microscopy catalogue groups apps by task without repeating its domain', async () => {
  const { catalogApps, findCatalog } = await import('../scripts/lib/apps-registry.mjs');
  const registry = await loadAppsRegistry();
  const catalog = findCatalog(registry, 'microscopy');
  const html = renderLandingPage({ ...registry, apps: catalogApps(registry, catalog) }, await loadStandalone(registry), catalog);
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelector('[data-category-filter="microscopy"]'), null);
  const expected = {
    stardist: 'segmentation',
    microsam: 'segmentation',
    'spot-detection': 'spot-detection',
    'calcium-imaging': 'calcium-imaging',
    zarro: 'visualization',
    elastix: 'registration',
    neuromorph: 'morphometry',
    stitching: 'registration',
    'cryo-em': 'reconstruction',
    'structure-tensor': 'fibre-orientation',
    'microscope-qc': 'quality-control',
    niimath: 'preprocessing',
    mri2vid: 'visualization',
    deconvolution: 'preprocessing',
  };
  const cards = [...document.querySelectorAll('[data-app-card]')];
  assert.equal(cards.length, Object.keys(expected).length);
  for (const [id, category] of Object.entries(expected)) {
    assert.deepEqual(cards.filter(card => card.dataset.appId === id).map(card => card.dataset.category), [category]);
  }
});

test('a catalogue offers the apps other catalogues serve, linking to their home', async () => {
  const { appCatalogIds, appUrl, catalogApps, findApp, findCatalog } = await import('../scripts/lib/apps-registry.mjs');
  const registry = await loadAppsRegistry();
  const standalone = await loadStandalone(registry);
  for (const catalog of registry.site.catalogs) {
    const apps = catalogApps(registry, catalog);
    const html = renderLandingPage({ ...registry, apps }, standalone, catalog, { allApps: registry.apps });
    const { document } = new JSDOM(html).window;
    const elsewhere = JSON.parse(document.querySelector('script#elsewhere-apps[type="application/json"]').textContent);
    const expected = registry.apps.filter((app) => !appCatalogIds(app).includes(catalog.id)).map(({ id }) => id);
    assert.deepEqual(elsewhere.map(({ id }) => id), expected, `${catalog.id} offers every app it does not serve, and no other`);
    for (const entry of elsewhere) {
      const app = findApp(registry, entry.id);
      const home = findCatalog(registry, app.catalog);
      assert.equal(entry.url, appUrl(registry, app));
      assert.match(entry.url, /^https:\/\//);
      assert.equal(entry.host, home.host);
      assert.equal(entry.catalogTitle, home.title);
      assert.equal(entry.title, app.title);
      assert.equal(entry.description, app.description);
    }
    assert.ok(document.querySelector('#no-results #elsewhere[hidden] #elsewhere-results.app-grid'));
    // A category can hide a local match, so the heading claims nothing about the whole site.
    assert.equal(document.querySelector('#no-results h2').textContent, 'No apps match these filters');
  }

  const neuro = findCatalog(registry, 'neuro');
  const html = renderLandingPage({ ...registry, apps: catalogApps(registry, neuro) }, standalone, neuro, { allApps: registry.apps });
  const elsewhere = JSON.parse(new JSDOM(html).window.document.querySelector('#elsewhere-apps').textContent);
  const musclemap = elsewhere.find(({ id }) => id === 'musclemap');
  assert.equal(musclemap.url, 'https://mskapps.sciget.org/musclemap/');
  assert.match(musclemap.search, /muscle/);
  assert.equal(elsewhere.find(({ id }) => id === 'stardist').search, elsewhere.find(({ id }) => id === 'stardist').search.toLocaleLowerCase());
  const stardist = renderLandingPage({ ...registry, apps: [findApp(registry, 'stardist')] }, standalone);
  const cardSearch = new JSDOM(stardist).window.document.querySelector('[data-app-card]').dataset.search;
  assert.equal(elsewhere.find(({ id }) => id === 'stardist').search, cardSearch, 'the fallback matches the text a local card would');
});

test('the offline desktop landing page carries no fallback to other hosts', async () => {
  const registry = await loadAppsRegistry();
  const html = renderLandingPage({ ...registry, apps: registry.apps.slice(0, 3) }, await loadStandalone(registry));
  assert.doesNotMatch(html, /elsewhere/);
  assert.doesNotMatch(html, /https:\/\/[a-z]+apps\.sciget\.org\/[a-z0-9-]+\//);
});
