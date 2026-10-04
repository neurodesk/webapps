import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agenticCatalog } from '../test-utils/agentic-catalog.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';

test('every registered webapp has an e2e catalog entry and its declared examples', async () => {
  const registry = await loadAppsRegistry();
  const catalog = await agenticCatalog('');
  assert.deepEqual(catalog.map(app => app.id), registry.apps.map(app => app.id));
  for (const app of catalog) {
    assert.ok(app.examples.length > 0 || app.id === 'seedseg', `${app.id}: missing example workflow`);
  }
});

test('app selection is exact and rejects unknown ids instead of running no tests', async () => {
  const selected = await agenticCatalog('niimath,seedseg');
  assert.deepEqual(selected.map(app => app.id).sort(), ['niimath', 'seedseg']);
  await assert.rejects(agenticCatalog('niimath,missing-app'), /unknown app/);
});
