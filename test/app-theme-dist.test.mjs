import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyAppTheme } from '../scripts/lib/app-theme-dist.mjs';

test('adds the shared theme to a standalone app distribution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-app-theme-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const distDir = join(root, 'dist');
  const themeFile = join(root, 'theme.css');
  const themeScriptFile = join(root, 'theme.js');
  const shellFile = join(root, 'app-shell.js');
  const analyticsFile = join(root, 'analytics.js');
  const iconFile = join(root, 'neurodesk-logo.svg');
  await mkdir(distDir);
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><html lang="en"><head><title>App</title></head><body></body></html>',
  );
  await writeFile(join(distDir, 'engine.wasm'), 'final runtime binary');
  await writeFile(themeFile, ':root { --neurodesk-primary: #6aa329; }');
  await mkdir(join(root, 'fonts'));
  await writeFile(themeScriptFile, '/* shared theme controller */');
  await writeFile(shellFile, '/* shared app shell */');
  await writeFile(analyticsFile, '/* page-view analytics */');
  await writeFile(iconFile, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  await applyAppTheme({
    app: {
      id: 'example-app',
      title: 'Example App',
      description: 'An example scientific app.',
    },
    version: '1.2.3',
    measurementId: 'G-4Z9774J59Y',
    distDir,
    themeFile,
    themeScriptFile,
    shellFile,
    analyticsFile,
    iconFile,
  });

  const themedHtml = await readFile(join(distDir, 'index.html'), 'utf8');
  const manifestName = themedHtml.match(/content="\.\/(runtime-cache-manifest\.[a-f0-9]{64}\.json)"/)[1];
  const manifest = JSON.parse(await readFile(join(distDir, manifestName), 'utf8'));
  assert.equal(manifest.assets[0].url, './engine.wasm');
  assert.equal(manifest.assets[0].bytes, 20);
  const html = await readFile(join(distDir, 'index.html'), 'utf8');
  assert.match(html, /src="\.\/coi-serviceworker\.js"/);
  assert.match(html, /<html data-neurodesk-app="example-app" data-neurodesk-shell="static-html" data-neurodesk-theme="dark" lang="en">/);
  assert.match(html, /href="\.\/app-theme\.css" data-neurodesk-app-theme/);
  assert.match(html, /src="\.\/theme\.js" data-neurodesk-theme-controller/);
  assert.match(html, /src="\.\/app-shell\.js" data-neurodesk-app-shell/);
  assert.match(html, /data-app-title="Example App"/);
  assert.match(html, /data-ga4-measurement-id="G-4Z9774J59Y"/);
  assert.match(html, /<title>Example App \| Neurodesk Webapps<\/title>/);
  assert.match(html, /<meta name="description" content="An example scientific app\.">/);
  assert.match(html, /<meta property="og:title" content="Example App \| Neurodesk Webapps">/);
  assert.doesNotMatch(html, /og:url/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\.\/neurodesk-logo\.svg" data-neurodesk-app-icon>/);
  assert.equal(
    await readFile(join(distDir, 'neurodesk-logo.svg'), 'utf8'),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  assert.equal(
    await readFile(join(distDir, 'app-theme.css'), 'utf8'),
    ':root { --neurodesk-primary: #6aa329; }',
  );
  assert.equal(await readFile(join(distDir, 'theme.js'), 'utf8'), '/* shared theme controller */');
  assert.equal(await readFile(join(distDir, 'app-shell.js'), 'utf8'), '/* shared app shell */');
  assert.equal(await readFile(join(distDir, 'analytics.js'), 'utf8'), '/* page-view analytics */');
});

test('keeps an app-provided favicon and does not copy the site mark', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-app-theme-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const distDir = join(root, 'dist');
  await mkdir(distDir);
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><html><head><link rel="icon" href="favicon.ico"><title>App</title></head><body></body></html>',
  );
  const files = {};
  for (const name of ['theme.css', 'theme.js', 'app-shell.js', 'analytics.js', 'neurodesk-logo.svg']) {
    files[name] = join(root, name);
    await writeFile(files[name], `/* ${name} */`);
  }
  await mkdir(join(root, 'fonts'));

  await applyAppTheme({
    app: { id: 'example-app', title: 'Example App', description: 'An example scientific app.' },
    version: '1.2.3',
    measurementId: 'G-4Z9774J59Y',
    distDir,
    themeFile: files['theme.css'],
    themeScriptFile: files['theme.js'],
    shellFile: files['app-shell.js'],
    analyticsFile: files['analytics.js'],
    iconFile: files['neurodesk-logo.svg'],
  });

  const html = await readFile(join(distDir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="favicon\.ico">/);
  assert.doesNotMatch(html, /data-neurodesk-app-icon/);
  await assert.rejects(readFile(join(distDir, 'neurodesk-logo.svg')), { code: 'ENOENT' });
});
