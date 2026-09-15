import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { injectCompositeTheme } from '../scripts/lib/composite-theme.mjs';
import { neurodeskViteConfig } from '../scripts/lib/vite-app-config.mjs';

const document = '<!doctype html><html lang="en"><head><title>Example</title></head><body></body></html>';
const metadata = {
  appId: 'example-app',
  title: 'Example App',
  description: 'A short explanation.',
  version: '1.2.3',
  measurementId: 'G-4Z9774J59Y',
};

test('injects the hosted app identity, theme, and shared top-bar contract', () => {
  const themed = injectCompositeTheme(document, metadata);

  assert.match(themed, /<html data-neurodesk-app="example-app" data-neurodesk-shell="static-html" data-neurodesk-theme="dark" lang="en">/);
  assert.match(themed, /<script src="\.\.\/theme\.js" data-neurodesk-theme-controller><\/script>/);
  assert.match(themed, /<link rel="stylesheet" href="\.\.\/app-theme\.css" data-neurodesk-app-theme>/);
  assert.match(themed, /src="\.\.\/app-shell\.js" data-neurodesk-app-shell/);
  assert.match(themed, /data-app-title="Example App"/);
  assert.match(themed, /data-app-description="A short explanation\."/);
  assert.match(themed, /data-app-version="1\.2\.3"/);
  assert.match(themed, /<title>Example App \| Neurodesk Webapps<\/title>/);
  assert.match(themed, /<meta name="description" content="A short explanation\.">/);
  assert.match(themed, /<meta property="og:type" content="website">/);
  assert.match(themed, /<meta property="og:title" content="Example App \| Neurodesk Webapps">/);
  assert.match(themed, /<meta property="og:description" content="A short explanation\.">/);
  assert.match(themed, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(themed, /og:url/);
  assert.match(themed, /<link rel="icon" type="image\/svg\+xml" href="\.\.\/neurodesk-logo\.svg" data-neurodesk-app-icon>/);
  assert.match(themed, /data-ga4-measurement-id="G-4Z9774J59Y"/);
  assert.match(themed, /data-analytics-href="\.\.\/analytics\.js"/);
  assert.match(themed, /data-source-href="https:\/\/github\.com\/neurodesk\/webapps\/tree\/main\/apps\/example-app"/);
});

test('theme injection is idempotent', () => {
  const themed = injectCompositeTheme(document, metadata);
  const repeated = injectCompositeTheme(themed, metadata);

  assert.equal(repeated, themed);
  assert.equal((repeated.match(/data-neurodesk-app-theme/g) ?? []).length, 1);
  assert.equal((repeated.match(/data-neurodesk-theme-controller/g) ?? []).length, 1);
  assert.equal((repeated.match(/data-neurodesk-app-shell/g) ?? []).length, 1);
  assert.equal((repeated.match(/data-neurodesk-theme="/g) ?? []).length, 1);
  assert.equal((repeated.match(/<title>/g) ?? []).length, 1);
  assert.equal((repeated.match(/name="description"/g) ?? []).length, 1);
  assert.equal((repeated.match(/property="og:title"/g) ?? []).length, 1);
  assert.equal((repeated.match(/data-neurodesk-app-icon/g) ?? []).length, 1);
});

test('normalizes head metadata from the registry', () => {
  const legacy = [
    '<!doctype html><html lang="en"><head>',
    '  <meta charset="utf-8">',
    '  <title>CALMaR | Co-designed Automated Lesion Mapping</title>',
    '  <meta name="description" content="Stale copy from the app">',
    '  <meta property="og:title" content="Stale share title">',
    '</head><body></body></html>',
  ].join('\n');
  const themed = injectCompositeTheme(legacy, { ...metadata, url: 'https://webapps.neurodesk.org/example/' });

  assert.equal((themed.match(/<title>/g) ?? []).length, 1);
  assert.match(themed, /<title>Example App \| Neurodesk Webapps<\/title>/);
  assert.equal((themed.match(/name="description"/g) ?? []).length, 1);
  assert.match(themed, /<meta name="description" content="A short explanation\.">/);
  assert.doesNotMatch(themed, /Stale/);
  assert.match(themed, /<meta property="og:url" content="https:\/\/webapps\.neurodesk\.org\/example\/">/);
  assert.match(themed, /<meta charset="utf-8">\n  <title>/);
  assert.equal(injectCompositeTheme(themed, { ...metadata, url: 'https://webapps.neurodesk.org/example/' }), themed);
});

test('inserts title and metadata when the app ships none', () => {
  const bare = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
  const themed = injectCompositeTheme(bare, metadata);

  assert.match(themed, /<title>Example App \| Neurodesk Webapps<\/title>/);
  assert.match(themed, /<meta name="description" content="A short explanation\.">/);
  assert.equal(injectCompositeTheme(themed, metadata), themed);
});

test('escapes registry copy in the metadata block', () => {
  const themed = injectCompositeTheme(document, { ...metadata, title: 'T1 & B1 <Maps>', description: 'Say "hi"' });

  assert.match(themed, /<title>T1 &amp; B1 &lt;Maps&gt; \| Neurodesk Webapps<\/title>/);
  assert.match(themed, /<meta name="description" content="Say &quot;hi&quot;">/);
  assert.match(themed, /data-app-title="T1 &amp; B1 &lt;Maps&gt;"/);
});

test('keeps an app-provided favicon and drops data: placeholders', () => {
  const branded = document.replace('</head>', '<link rel="icon" type="image/png" href="img/app.png" sizes="64x64"></head>');
  const themedBranded = injectCompositeTheme(branded, metadata);
  assert.match(themedBranded, /href="img\/app\.png"/);
  assert.doesNotMatch(themedBranded, /data-neurodesk-app-icon/);

  const multi = document.replace('</head>', '<link rel="icon" href="/x/favicon.svg" type="image/svg+xml" /><link rel="apple-touch-icon" href="/x/logo192.png" /></head>');
  assert.doesNotMatch(injectCompositeTheme(multi, metadata), /data-neurodesk-app-icon/);

  const placeholder = document.replace('</head>', '<link rel="icon" href="data:," /></head>');
  const themedPlaceholder = injectCompositeTheme(placeholder, metadata);
  assert.doesNotMatch(themedPlaceholder, /data:,/);
  assert.equal((themedPlaceholder.match(/rel="icon"/g) ?? []).length, 1);
  assert.match(themedPlaceholder, /data-neurodesk-app-icon/);
  assert.equal(injectCompositeTheme(themedPlaceholder, metadata), themedPlaceholder);
});

test('adds the controller to an app that already has the shared stylesheet', () => {
  const legacy = document.replace(
    '</head>',
    '<link rel="stylesheet" href="../app-theme.css" data-neurodesk-app-theme></head>',
  );
  const themed = injectCompositeTheme(legacy, metadata);

  assert.match(themed, /data-neurodesk-theme-controller/);
  assert.equal((themed.match(/data-neurodesk-app-theme/g) ?? []).length, 1);
});

test('rejects invalid app ids and incomplete documents', () => {
  assert.throws(() => injectCompositeTheme(document, { ...metadata, appId: 'Not Valid' }), /Invalid app id/);
  assert.throws(() => injectCompositeTheme(document, { ...metadata, title: '' }), /title must be a non-empty string/);
  assert.throws(() => injectCompositeTheme('<html><body></body></html>', metadata), /missing <\/head>/);
  assert.throws(() => injectCompositeTheme(document, { ...metadata, url: 'example/' }), /url must be an absolute/);
});

test('shared Vite development config injects the production shell contract', async () => {
  const config = await neurodeskViteConfig({ appId: 'deface' });
  const plugin = config.plugins.find(({ name }) => name === 'neurodesk-dev-shell');
  const themed = plugin.transformIndexHtml(document);

  assert.equal(plugin.apply, 'serve');
  assert.match(themed, /data-neurodesk-app="deface"/);
  assert.match(themed, /href="@fs\/.*\/site\/app-theme\.css"/);
  assert.match(themed, /src="@fs\/.*\/site\/app-shell\.js"/);
  const pkg = JSON.parse(await readFile(new URL('../apps/deface/package.json', import.meta.url), 'utf8'));
  assert.ok(themed.includes(`data-app-version="${pkg.version}"`));
  assert.match(themed, /data-neurodesk-app-information/);
  assert.match(themed, /lightniing.org/);
  assert.match(themed, /data-analytics-href="data:text\/javascript/);
});

test('composite assembly redirects baked standalone controls to shared root assets', () => {
  const standalone = injectCompositeTheme(document, metadata);
  const composite = injectCompositeTheme(standalone, { ...metadata, standaloneHref: '../standalone.json', componentsHref: '../shell-adapters/components/' });
  assert.match(composite, /data-standalone-href="\.\.\/standalone.json"/);
  assert.match(composite, /data-components-href="\.\.\/shell-adapters\/components\/"/);
  assert.equal(injectCompositeTheme(composite, { ...metadata, standaloneHref: '../standalone.json', componentsHref: '../shell-adapters/components/' }), composite);
});
