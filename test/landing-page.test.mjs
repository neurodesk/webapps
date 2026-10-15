import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry, SUPPORT_STATUSES } from '../scripts/lib/apps-registry.mjs';
import { renderLandingPage } from '../scripts/lib/landing-page.mjs';

test('landing page renders categorized, searchable app cards', async () => {
  const registry = await loadAppsRegistry();
  const html = renderLandingPage(registry);

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
