import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const legacyWebappsUrl = 'https://neurodesk.org/getting-started/hosted/webapps/';

test('the start page omits the scientific-assets footer', async () => {
  const builder = await readFile(join(repoRoot, 'scripts/build-site.mjs'), 'utf8');
  assert.ok(!builder.includes('Models and large scientific assets are delivered from Hugging Face'));
});

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
      } catch {}
    }
    assert.ok(file, `${app.id} must expose a source index.html`);
    const html = await readFile(join(repoRoot, file), 'utf8');
    assert.ok(!html.includes(legacyWebappsUrl), `${file} must not link to the old catalog`);
    assert.match(
      html,
      /<a href="\.\.\/" class="header-link"[^>]*title="More Neurodesk web apps">/,
      `${file} must link back to the composite start page in the current tab`,
    );
  }
});

test('shared imaging-workspace apps return to the composite start page', async () => {
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

  const shell = await readFile(
    join(repoRoot, 'packages/components/src/core/mountImagingWorkspace.js'),
    'utf8',
  );
  assert.ok(shell.includes("href: config.moreAppsHref || '../'"));
  assert.ok(shell.includes("title: 'More Neurodesk web apps'"));
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
