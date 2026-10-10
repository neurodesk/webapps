import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const legacyWebappsUrl = 'https://neurodesk.org/getting-started/hosted/webapps/';

test('static app More Apps links return to the composite start page', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps.filter(({ shell }) => shell === 'static-html')) {
    const candidates = [`apps/${app.id}/web/index.html`, `apps/${app.id}/index.html`];
    let file;
    for (const candidate of candidates) {
      try {
        await access(join(repoRoot, candidate));
        file = candidate;
        break;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    assert.ok(file, `${app.id} must expose a source index.html`);
    const html = await readFile(join(repoRoot, file), 'utf8');
    assert.ok(!html.includes(legacyWebappsUrl), `${file} must not link to the old catalog`);
    const links = new JSDOM(html).window.document.querySelectorAll('a[title="More Neurodesk web apps"]');
    assert.equal(links.length, 1, `${file} must offer one More Apps link`);
    assert.equal(links[0].getAttribute('href'), '../', `${file} must link back to the composite start page`);
    assert.equal(links[0].hasAttribute('target'), false, `${file} must navigate in the current tab`);
  }
});

// The link the shared shell renders is asserted in packages/components/test/imaging-workspace.test.js
// and clicked in every app by test/composite-site.smoke.mjs.
test('shared imaging-workspace apps mount the shared shell', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps.filter(({ shell }) => shell === 'imaging-workspace')) {
    const appRoot = join(repoRoot, 'apps', app.id);
    const sources = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'public'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name)) sources.push(await readFile(path, 'utf8'));
      }
    }
    await visit(appRoot);
    assert.ok(sources.some(source => source.includes('mountImagingWorkspace({')), `${app.id} must use shared imaging chrome`);
  }
});

test('dicompare More Apps links use its deployment base and the current tab', async () => {
  const pagesDir = join(repoRoot, 'apps/dicompare/src/pages');
  const files = (await readdir(pagesDir))
    .filter(name => name.endsWith('.tsx'))
    .map(name => `apps/dicompare/src/pages/${name}`);
  let links = 0;

  for (const file of files) {
    const source = await readFile(join(repoRoot, file), 'utf8');
    assert.ok(!source.includes(legacyWebappsUrl), `${file} must not link to the old catalog`);
    assert.ok(source.includes('href={`${import.meta.env.BASE_URL}../`}'), `${file} must use the Vite base path`);
    const titleIndex = source.indexOf('title="More Neurodesk web apps"');
    if (titleIndex < 0) continue;
    links++;
    const anchorStart = source.lastIndexOf('<a', titleIndex);
    const anchorEnd = source.indexOf('</a>', titleIndex);
    assert.ok(titleIndex >= 0 && anchorStart >= 0 && anchorEnd >= 0, `${file} must contain a More Apps link`);
    const moreAppsAnchor = source.slice(anchorStart, anchorEnd + 4);
    assert.ok(!moreAppsAnchor.includes('target="_blank"'), `${file} must navigate in the current tab`);
  }
  assert.ok(links > 0, 'dicompare must expose at least one More Apps link');
});
