import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppContract } from '../scripts/lib/app-automation.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const { origin, close } = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: process.platform === 'linux' ? [
  '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader',
  '--enable-features=Vulkan', '--disable-vulkan-surface',
] : [] });
const entries = [];
try {
  for (const app of (await loadAppsRegistry()).apps) {
    const page = await browser.newPage();
    try {
      await page.context().route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
      await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), null, { timeout: 60000 });
      const actual = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('describe'));
      const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
      const expected = await loadAppContract(app, version);
      assert.deepEqual(actual, expected, `${app.id}: published contract differs from source`);
      entries.push({ app: app.id, version, operations: Object.keys(actual.operations), passed: true });
      console.log(`PASS ${app.id}: ${Object.keys(actual.operations).join(', ')}`);
    } catch (error) {
      entries.push({ app: app.id, passed: false, error: error.message });
      console.error(`FAIL ${app.id}: ${error.message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await close();
}
if (process.env.AUTOMATION_CATALOG_REPORT) {
  await writeFile(process.env.AUTOMATION_CATALOG_REPORT, JSON.stringify({
    scope: 'Production contract publication and operation registration; scientific execution is checked by app tests.',
    entries,
  }, null, 2));
}
assert.ok(entries.every(entry => entry.passed), 'Catalog automation registration failed');
