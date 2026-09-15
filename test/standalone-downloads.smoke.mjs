import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const registry = await loadAppsRegistry();
const catalog = JSON.parse(await readFile(join(repoRoot, 'registry/standalone.json')));
assert.ok(catalog.suite?.downloads.length, 'The tested suite must be published before checking its interface links');
const server = process.env.BASE_URL ? null : await serveSite(join(repoRoot, 'dist'));
const base = `${(process.env.BASE_URL || server.origin).replace(/\/$/, '')}/`;
const browser = await chromium.launch({ headless: true });
try {
  for (const app of registry.apps) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route(/googletagmanager\.com|google-analytics\.com/, route => route.fulfill({ body: '' }));
      if (app.id === 'browserqc') await page.route(/\/browserqc\/t1_crop\.nii\.gz$/, route => route.abort());
      const response = await page.goto(new URL(`${app.path}/`, base).href, { waitUntil: 'domcontentloaded' });
      assert.ok(response?.ok(), `${app.id} page must load`);
      const bar = page.locator('.nd-app-bar:visible').first();
      await expect(bar).toBeVisible();
      const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible').first();
      if (await enter.count()) await enter.click();
      const workspace = page.getByRole('link', { name: 'Open Workspace', exact: true });
      if (await workspace.isVisible()) await workspace.click();
      const welcome = page.locator('#welcomeLater');
      if (await welcome.isVisible()) await welcome.click();
      await expect(bar.getByRole('link', { name: /lightNIIng/i })).toHaveCount(0);
      let releaseStyles;
      let stylesheetRequest;
      if (app.id === 'calmar') {
        const stylesReady = new Promise(resolve => { releaseStyles = resolve; });
        await page.route('**/shell-adapters/components/styles/imaging-workspace.css', async route => {
          await stylesReady;
          await route.continue();
        });
        stylesheetRequest = page.waitForRequest('**/shell-adapters/components/styles/imaging-workspace.css');
      }
      await bar.getByRole('button', { name: 'Standalone', exact: true }).click();
      const dialog = page.locator('#neurodeskStandaloneDialog');
      if (stylesheetRequest) {
        try {
          await stylesheetRequest;
          await expect(dialog).toBeHidden();
        } finally {
          releaseStyles();
        }
      }
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Models included');
      await expect(dialog).not.toContainText(/cargo build|compile from source|make macos-release/i);
      const links = await dialog.locator('a').evaluateAll(elements => elements.map(element => element.href));
      for (const download of [...catalog.suite.downloads, ...catalog.apps[app.id].downloads]) {
        for (const file of [download, ...(download.parts || [])]) {
          assert.ok(links.includes(file.url), `${app.id}: missing visible ${download.platform} download ${file.url}`);
        }
      }
      console.log(`PASS ${app.id}: published desktop and HPC downloads are visible`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server?.close();
}
