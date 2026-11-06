import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { catalogApps, loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { renderHubPage } from '../scripts/lib/hub-page.mjs';

test('the hub shows one card per catalogue with its title, description, app count and link', async () => {
  const registry = await loadAppsRegistry();
  const { document } = new JSDOM(renderHubPage(registry)).window;
  const cards = [...document.querySelectorAll('[data-catalog-card]')];
  assert.deepEqual(cards.map(card => card.dataset.catalogId), registry.site.catalogs.map(({ id }) => id));
  for (const catalog of registry.site.catalogs) {
    const card = document.querySelector(`[data-catalog-id="${catalog.id}"]`);
    assert.equal(card.getAttribute('href'), `https://${catalog.host}/`);
    assert.equal(card.querySelector('h3').textContent, catalog.title);
    assert.equal(card.querySelector('p').textContent, catalog.description);
    assert.equal(card.querySelector('.app-card__category').textContent, `${catalogApps(registry, catalog).length} apps`);
  }
  assert.equal(document.title, registry.site.hub.title);
  assert.equal(document.querySelectorAll('[data-app-card]').length, 0, 'the hub hosts no apps');
});
