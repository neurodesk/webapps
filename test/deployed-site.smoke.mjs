import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('BASE_URL is required (for example https://example.github.io/webapps/)');

const registry = await loadAppsRegistry();
const isolatedApps = [];
for (const app of registry.apps) {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
  if (packageJson.neurodeskWebapp?.static?.coiServiceWorker) isolatedApps.push(app);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const app of isolatedApps) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const url = new URL(`${app.path}/`, baseURL.endsWith('/') ? baseURL : `${baseURL}/`).href;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response?.ok()) throw new Error(`${app.id}: ${url} returned ${response?.status() ?? 'no response'}`);
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
    if (errors.length) throw new Error(`${app.id}: browser errors: ${errors.join('; ')}`);
    console.log(`PASS ${app.id}: crossOriginIsolated at ${url}`);
    await context.close();
  }
} finally {
  await browser.close();
}
