#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const dist = join(repoRoot, 'dist');
const registry = await loadAppsRegistry();
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
]);

function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (relative.startsWith('..')) return null;
  return join(dist, relative);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let path = resolveRequest(url.pathname);
    if (!path) {
      response.writeHead(400).end('Bad request');
      return;
    }

    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      response.writeHead(404).end('Not found');
      return;
    }

    if (metadata.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      path = join(path, 'index.html');
      metadata = await stat(path);
    }

    response.writeHead(200, {
      'content-length': metadata.size,
      'content-type': mimeTypes.get(extname(path)) ?? 'application/octet-stream',
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-opener-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).pipe(response);
  } catch (error) {
    response.writeHead(500).end(error.message);
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];

try {
  const landing = await browser.newPage();
  await landing.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const cards = await landing.locator('a.app').count();
  const landingText = await landing.locator('body').innerText();
  if (cards !== registry.apps.length) failures.push(`landing page has ${cards} app cards, expected ${registry.apps.length}`);
  if (landingText.includes('Models and large scientific assets are delivered from Hugging Face')) {
    failures.push('landing page still contains the removed scientific-assets message');
  }
  await landing.close();

  for (const app of registry.apps) {
    const page = await browser.newPage();
    const pageErrors = [];
    const responseErrors = [];
    const subpathLeaks = [];
    let returningHome = false;

    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) {
        responseErrors.push(`${response.status()} ${url.pathname}`);
      }
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin || url.pathname === `/favicon.ico`) return;
      if (returningHome && url.pathname === '/') return;
      if (url.pathname !== `/${app.path}/` && !url.pathname.startsWith(`/${app.path}/`)) {
        subpathLeaks.push(url.pathname);
      }
    });

    const response = await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(app.id === 'seedseg' ? 4_000 : 1_000);
    const title = await page.title();
    const bodyText = await page.locator('body').innerText();

    if (!response?.ok()) failures.push(`${app.id}: document returned ${response?.status() ?? 'no response'}`);
    if (!title.trim()) failures.push(`${app.id}: empty document title`);
    if (!bodyText.trim()) failures.push(`${app.id}: empty rendered body`);
    if (pageErrors.length) failures.push(`${app.id}: page errors: ${[...new Set(pageErrors)].join(' | ')}`);
    if (responseErrors.length) failures.push(`${app.id}: failed same-origin responses: ${[...new Set(responseErrors)].join(' | ')}`);
    if (subpathLeaks.length) failures.push(`${app.id}: assets escaped app subpath: ${[...new Set(subpathLeaks)].join(', ')}`);
    if (app.id === 'seedseg') {
      const consoleText = await page.locator('#consoleOutput').innerText();
      if (!consoleText.includes('ONNX Runtime ready')) failures.push(`seedseg: worker did not initialize: ${consoleText.trim()}`);
    }

    const moreApps = page.locator('[title="More Neurodesk web apps"]').first();
    if (await moreApps.count() !== 1) {
      failures.push(`${app.id}: More Apps link is missing`);
    } else {
      returningHome = true;
      await Promise.all([
        page.waitForURL(`${origin}/`),
        moreApps.click(),
      ]);
      if (await page.title() !== 'Neurodesk Webapps') {
        failures.push(`${app.id}: More Apps did not render the composite start page`);
      }
    }

    console.log(`PASS /${app.path}/ — ${title}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) throw new Error(`Composite-site smoke failures:\n- ${failures.join('\n- ')}`);
console.log(`Composite-site smoke passed for all ${registry.apps.length} webapps.`);
