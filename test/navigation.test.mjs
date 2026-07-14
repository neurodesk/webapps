import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const legacyWebappsUrl = 'https://neurodesk.org/getting-started/hosted/webapps/';

test('the start page omits the scientific-assets footer', async () => {
  const builder = await readFile(join(repoRoot, 'scripts/build-site.mjs'), 'utf8');
  assert.ok(!builder.includes('Models and large scientific assets are delivered from Hugging Face'));
});

test('static app More Apps links return to the composite start page', async () => {
  const files = [
    'apps/calmar/web/index.html',
    'apps/musclemap/web/index.html',
    'apps/qsmbly/index.html',
    'apps/seedseg/web/index.html',
    'apps/spinalcordtoolbox/web/index.html',
    'apps/vesselboost/web/index.html',
    'apps/easy-mp2rage/web/index.html',
    'apps/dicom2vid/web/index.html',
  ];

  for (const file of files) {
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
  const files = [
    'apps/deface/src/main.ts',
    'apps/niimath/main.js',
  ];

  for (const file of files) {
    const source = await readFile(join(repoRoot, file), 'utf8');
    assert.ok(source.includes('mountImagingWorkspace({'), `${file} must use the shared imaging chrome`);
  }

  const shell = await readFile(
    join(repoRoot, 'packages/components/src/core/mountImagingWorkspace.js'),
    'utf8',
  );
  assert.ok(shell.includes("href: config.moreAppsHref || '../'"));
  assert.ok(shell.includes("title: 'More Neurodesk web apps'"));
});

test('dicompare More Apps links use its deployment base and the current tab', async () => {
  const files = [
    'apps/dicompare/src/pages/LandingPage.tsx',
    'apps/dicompare/src/pages/SchemaViewerPage.tsx',
    'apps/dicompare/src/pages/UnifiedWorkspacePage.tsx',
  ];

  for (const file of files) {
    const source = await readFile(join(repoRoot, file), 'utf8');
    assert.ok(!source.includes(legacyWebappsUrl), `${file} must not link to the old catalog`);
    assert.ok(source.includes('href={`${import.meta.env.BASE_URL}../`}'), `${file} must use the Vite base path`);
    const titleIndex = source.indexOf('title="More Neurodesk web apps"');
    const anchorStart = source.lastIndexOf('<a', titleIndex);
    const anchorEnd = source.indexOf('</a>', titleIndex);
    assert.ok(titleIndex >= 0 && anchorStart >= 0 && anchorEnd >= 0, `${file} must contain a More Apps link`);
    const moreAppsAnchor = source.slice(anchorStart, anchorEnd + 4);
    assert.ok(!moreAppsAnchor.includes('target="_blank"'), `${file} must navigate in the current tab`);
  }
});
