import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { DIALOG_FORBIDDEN } from '../scripts/lib/standalone.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const registry = await loadAppsRegistry();
const catalog = JSON.parse(await readFile(join(repoRoot, 'registry/standalone.json')));
const server = process.env.BASE_URL ? null : await serveSite(join(repoRoot, 'dist'));
const base = `${(process.env.BASE_URL || server.origin).replace(/\/$/, '')}/`;
const browser = await chromium.launch({ headless: true });
try {
  for (const app of registry.apps) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.context().route(/googletagmanager\.com|google-analytics\.com/, route => route.fulfill({ body: '' }));
      if (app.id === 'browserqc') await page.context().route(/\/browserqc\/t1_crop\.nii\.gz$/, route => route.abort());
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
        await page.context().route('**/shell-adapters/components/styles/imaging-workspace.css', async route => {
          await stylesReady;
          await route.continue();
        });
        stylesheetRequest = page.context().waitForEvent('request', request => request.url().endsWith('/shell-adapters/components/styles/imaging-workspace.css'));
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
      await expect(dialog).not.toContainText(DIALOG_FORBIDDEN);
      const sections = await dialog.locator('section > h3').allTextContents();
      const downloads = catalog.apps[app.id].downloads;
      assert.equal(sections.includes('Command line'), downloads.length > 0, `${app.id}: lists a command line exactly when it has released one`);
      const computeServer = catalog.apps[app.id].computeServer;
      if (computeServer) {
        assert.equal(sections[0], 'Compute server · Linux with NVIDIA GPU');
        await expect(dialog.locator('#standalone-compute')).toBeVisible();
      } else if (catalog.apps[app.id].containers.length) {
        assert.equal(sections[0], 'Neurodesk containers');
      }
      const openrecon = catalog.apps[app.id].openrecon;
      const scanner = dialog.locator('section[aria-labelledby="standalone-openrecon"]');
      await expect(scanner).toHaveCount(openrecon ? 1 : 0);
      if (openrecon) {
        if (downloads.length) assert.ok(sections.indexOf('OpenRecon · MRI scanner console') < sections.indexOf('Command line'));
        await expect(scanner).toContainText(`Run the ${openrecon.label} container on the MRI scanner console`);
        await expect(scanner.getByRole('link', { name: 'Siemens teamplay C2P exchange' })).toHaveAttribute('href', 'https://webclient.us.api.teamplay.siemens-healthineers.com/c2p');
        await expect(scanner.getByRole('link', { name: 'neurodesk/openrecon', exact: true })).toHaveAttribute('href', 'https://github.com/neurodesk/openrecon/');
        await expect(scanner.getByRole('link', { name: `${openrecon.label} recipe` })).toHaveAttribute('href', `https://github.com/neurodesk/openrecon/tree/main/recipes/${openrecon.recipe}`);
      }
      const links = await dialog.locator('a').evaluateAll(elements => elements.map(element => element.href));
      if (computeServer?.download) {
        assert.ok(links.includes(computeServer.download.url), `${app.id}: missing compute-server download`);
      }
      for (const download of downloads) assert.ok(links.includes(download.url), `${app.id}: missing visible ${download.platform} download ${download.url}`);
      assert.ok(links.every(href => !/\/releases\/download\/webapps-v/.test(href)), `${app.id}: links the all-apps desktop suite instead of its own release`);
      console.log(`PASS ${app.id}: its own released downloads are visible`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server?.close();
}
