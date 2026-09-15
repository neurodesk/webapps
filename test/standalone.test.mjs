import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { openStandalone } from '../packages/components/src/ui/renderStandalone.js';

test('standalone catalog covers the entire app registry', async () => {
  const registry = await loadAppsRegistry();
  const catalog = await loadStandalone(registry);
  assert.equal(Object.keys(catalog.apps).length, registry.apps.length);
});

test('a future app cannot be silently omitted from desktop packaging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'standalone-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'registry'));
  await writeFile(join(root, 'registry/standalone.json'), JSON.stringify({ schema_version: 1, apps: {} }));
  await assert.rejects(loadStandalone({ apps: [{ id: 'new-app' }] }, root), /every registered app/);
});

test('shared dialog displays verified releases and keeps unpublished platforms unlinked', () => {
  const dom = new JSDOM('<html><body></body></html>');
  const app = { downloads: [{ kind: 'desktop', platform: 'macOS ARM64', version: '0.1.20260915', url: 'https://github.com/neurodesk/webapps/releases/download/demo-v0.1.20260915/demo.zip', modelsIncluded: true }], containers: [] };
  const dialog = openStandalone({ title: 'Demo', app }, dom.window.document);
  assert.match(dialog.root.textContent, /Models included/);
  assert.equal(dialog.root.querySelectorAll('a').length, 1);
  assert.match(dialog.root.querySelector('a').href, /demo.zip$/);
  assert.equal(dialog.root.querySelector('dialog'), null);
  dom.window.close();
});
