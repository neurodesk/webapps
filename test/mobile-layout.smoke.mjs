#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveSite } from '../test-utils/serve-site.mjs';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { verifyMobileImageImport, verifyMobileMeasurement } from '../test-utils/mobile-imaging.mjs';

const dist = join(repoRoot, 'dist');
const registry = await loadAppsRegistry();
const requestedAppIds = new Set((process.env.SMOKE_APPS ?? '').split(',').filter(Boolean));
const appsUnderTest = requestedAppIds.size
  ? registry.apps.filter(({ id }) => requestedAppIds.has(id))
  : registry.apps;
if (appsUnderTest.length !== (requestedAppIds.size || registry.apps.length)) {
  const found = new Set(appsUnderTest.map(({ id }) => id));
  const missing = [...requestedAppIds].filter((id) => !found.has(id));
  throw new Error(`Unknown SMOKE_APPS entries: ${missing.join(', ')}`);
}
const { origin, close } = await serveSite(dist);
const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const failures = [];
const screenshotDir = process.env.MOBILE_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
];

async function checkLayout(page, label) {
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const visible = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const describe = element => element.id || `${element.tagName.toLowerCase()}.${String(element.className).trim().replaceAll(' ', '.')}`;
    const scrollableAncestor = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const rect = parent.getBoundingClientRect();
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)
            && rect.left >= 0 && rect.right <= width + 1 && parent.scrollWidth > parent.clientWidth) return true;
      }
      return false;
    };
    return {
      pageOverflow: document.documentElement.scrollWidth > width + 1,
      dialogOverflow: [...document.querySelectorAll('.nd-dialog-body')].filter(visible)
        .filter(element => element.scrollWidth > element.clientWidth + 1).map(describe),
      overflow: [...document.querySelectorAll('body *')].filter(visible).filter(element => {
        const rect = element.getBoundingClientRect();
        return (rect.right > width + 1 || rect.left < -1) && !scrollableAncestor(element);
      }).slice(0, 8).map(describe),
      smallNavigation: [...document.querySelectorAll('.nd-app-bar__action')].filter(visible)
        .filter(element => element.getBoundingClientRect().width < 44 || element.getBoundingClientRect().height < 44).map(describe),
      smallInputs: [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="number"], input[type="url"], select, textarea')]
        .filter(visible).filter(element => Number.parseFloat(getComputedStyle(element).fontSize) < 16).map(describe),
    };
  });
  const failed = result.pageOverflow || result.dialogOverflow.length || result.overflow.length || result.smallNavigation.length || result.smallInputs.length;
  if (failed) failures.push(`${label}: ${JSON.stringify(result)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${label.replaceAll('/', '-')}.png`) });
  console.log(`${failed ? 'FAIL' : 'PASS'} ${label}${failed ? ' ' + JSON.stringify(result) : ''}`);
}

try {
  for (const app of [{ id: 'catalog', path: '' }, ...appsUnderTest]) {
    const context = await browser.newContext({ viewport: viewports[1], isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // This suite measures layout, not inference. Avoid blocking Chromium's
    // renderer on BrowserQC's automatic full sample segmentation.
    if (app.id === 'browserqc') {
      await page.route(/\/browserqc\/t1_crop\.nii\.gz$/, route => route.abort());
    }
    await page.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/,
      route => route.fulfill({ status: 200, body: '' }));
    try {
      const response = await page.goto(`${origin}/${app.path}${app.path ? '/' : ''}`, { waitUntil: 'domcontentloaded' });
      expect(response.status()).toBe(200);
      if (app.id !== 'catalog') await expect(page.locator('.nd-app-bar:visible').first()).toBeVisible();
      for (const phase of ['entry', 'workspace']) {
        if (phase === 'workspace') {
          const enter = page.locator('#enterAppButton, #landingLaunch').filter({ visible: true }).first();
          if (await enter.count()) await enter.tap();
          if (app.id === 'dicompare') {
            await page.getByRole('link', { name: 'Open Workspace', exact: true }).tap();
            await expect(page.locator('header').filter({ has: page.locator('h1').filter({ hasText: /^Workspace$/ }) }).locator('.nd-app-bar')).toBeVisible();
          }
          const welcome = page.locator('#welcomeLater');
          if (await welcome.isVisible()) await welcome.tap();
          if (app.id !== 'catalog') await expect(page.locator('.nd-app-bar:visible')).toHaveCount(1);
        }
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await checkLayout(page, `${app.id}/${phase}/${viewport.width}`);
          if (phase === 'entry') {
            const enter = page.locator('#enterAppButton, #landingLaunch').filter({ visible: true }).first();
            if (await enter.count()) await enter.tap({ trial: true });
          }
        }
      }
      if (app.id !== 'catalog') {
        await page.setViewportSize(viewports[0]);
        const theme = page.locator('.nd-app-bar:visible [data-neurodesk-theme-toggle]').first();
        const previous = await page.locator('html').getAttribute('data-neurodesk-theme');
        await theme.tap();
        await expect(page.locator('html')).not.toHaveAttribute('data-neurodesk-theme', previous);
        await checkLayout(page, `${app.id}/light/320`);
        for (const viewport of [viewports[0], viewports[3]]) {
          await page.setViewportSize(viewport);
          await page.locator('.nd-app-bar:visible button[title="Privacy"]').first().tap();
          const dialog = page.locator('dialog[open], .modal-overlay.active .modal, .nd-modal-overlay.active .nd-modal, [role="dialog"][aria-label="Privacy"]').last();
          await expect(dialog).toBeVisible();
          const bounds = await dialog.boundingBox();
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
          await checkLayout(page, `${app.id}/privacy/${viewport.width}`);
          await dialog.locator('.modal-close, .nd-modal-close, .nd-dialog-close, .nd-app-dialog__close, [aria-label="Close privacy"]').first().tap();
          await expect(dialog).toBeHidden();
          await page.locator('.nd-app-bar:visible [data-neurodesk-shell-control="standalone"]').first().tap();
          const standalone = page.locator('#neurodeskStandaloneDialog');
          await expect(standalone).toBeVisible();
          await checkLayout(page, `${app.id}/standalone/${viewport.width}`);
          await standalone.getByRole('button', { name: 'Close', exact: true }).tap();
          await expect(standalone).toBeHidden();
        }
      }
      if (app.id === 'qsmbly') {
        for (const viewport of [viewports[0], viewports[3]]) {
          await page.setViewportSize(viewport);
          for (const tab of ['viewer', 'console', 'controls']) {
            await page.locator(`.mobile-tab[data-tab="${tab}"]`).tap();
            await expect(page.locator('.app-container')).toHaveAttribute('data-mobile-tab', tab);
            await checkLayout(page, `${app.id}/${tab}/${viewport.width}`);
            if (tab === 'viewer') {
              const canvas = await page.locator('.viewer-canvas-wrapper').boundingBox();
              expect(canvas.height).toBeGreaterThanOrEqual(120);
              expect(canvas.y + canvas.height).toBeLessThanOrEqual(viewport.height);
            }
          }
        }
      }
      if (app.id === 'musclemap') {
        await verifyMobileImageImport(page);
        await checkLayout(page, `${app.id}/image-import/320`);
      }
      if (await page.locator('.nd-viewer-panel-grid:visible').count()) {
        // All three viewer panels must be square (height capped at 360px), inside the page width, and reachable by scrolling.
        for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
          await page.setViewportSize(viewport);
          const panels = await page.locator('.nd-viewer-panel').evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom + window.scrollY, page: document.documentElement.scrollHeight };
          }));
          expect(panels).toHaveLength(3);
          for (const panel of panels) {
            expect(panel.width).toBeGreaterThanOrEqual(200);
            expect(panel.height).toBeGreaterThanOrEqual(Math.min(panel.width, 360) - 3);
            expect(panel.height).toBeLessThanOrEqual(panel.width + 1);
            expect(panel.right).toBeLessThanOrEqual(viewport.width + 1);
            expect(panel.bottom).toBeLessThanOrEqual(panel.page + 1);
          }
          console.log(`PASS ${app.id}/panels/${viewport.width}x${viewport.height}`);
        }
      }
      if (app.id === 'zarro') {
        await verifyMobileMeasurement(page, origin);
        await checkLayout(page, `${app.id}/touch-measurement/390`);
      }
    } catch (error) {
      failures.push(`${app.id}: ${error.message}`);
      console.error(`FAIL ${app.id}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await close();
}
if (failures.length) throw new Error(`Mobile failures:\n${failures.join('\n')}`);
console.log(`Mobile layouts and touch navigation passed for all ${appsUnderTest.length} apps and the catalog.`);
