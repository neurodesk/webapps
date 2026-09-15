#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadAppExamples } from './lib/app-examples.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const { apps } = await loadAppsRegistry();
const site = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const output = process.env.INTERFACE_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const results = [];
try {
  for (const app of apps) {
    const examples = await loadAppExamples(app);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const result = { app: app.id, width: viewport.width, failures: [] };
      try {
        await page.route(/googletagmanager\.com|google-analytics\.com/, route => route.fulfill({ body: '' }));
        const response = await page.goto(`${site.origin}/${app.path}/`, { waitUntil: 'domcontentloaded' });
        expect(response.status()).toBe(200);
        await expect(page.locator('.nd-app-bar:visible').first()).toBeVisible();
        const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible').first();
        if (await enter.count()) await enter.click();
        const workspace = page.getByRole('link', { name: 'Open Workspace', exact: true });
        if (await workspace.isVisible()) await workspace.click();
        const welcome = page.locator('#welcomeLater');
        if (await welcome.isVisible()) await welcome.click();
        // Loading registration examples resets the Output disclosure. Exercise
        // keyboard controls only after initialization has succeeded or failed.
        if (['ants', 'greedy'].includes(app.id)) {
          await expect(page.locator('#runButton:enabled, #statusText.error').first()).toBeVisible({ timeout: 60000 });
        }
        // Allow the shell observer and disclosure transitions to settle after entry.
        await page.waitForTimeout(300);
        const bar = page.locator('.nd-app-bar:visible');
        for (const name of ['About', 'Cite', 'Privacy']) await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(1);
        await expect(bar.getByRole('button', { name: 'Standalone', exact: true })).toHaveCount(1);
        for (const name of ['More Apps', 'GitHub']) await expect(bar.getByRole('link', { name, exact: true })).toHaveCount(1);
        await expect(bar.locator('[data-neurodesk-theme-toggle]')).toHaveCount(1);
        Object.assign(result, await page.evaluate(() => {
          const visible = node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
          const describe = node => node.id || node.textContent.trim().replace(/\s+/g, ' ').slice(0, 90);
          const actions = ['about', 'cite', 'privacy', 'more apps', 'more neurodesk webapps', 'github'];
          const sourceLink = [...document.querySelectorAll('.nd-app-bar a')].find(node => node.textContent.trim() === 'GitHub');
          const duplicates = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible)
            .filter(node => !node.closest('.nd-app-bar') && actions.includes(
              (node.getAttribute('aria-label') || node.textContent || node.title).trim().toLowerCase()))
            .filter(node => node.textContent.trim().toLowerCase() !== 'github' || node.href === sourceLink?.href)
            .map(describe);
          const headings = [...document.querySelectorAll('.section-title[onclick], .subsection-title[onclick]')];
          const mouseOnly = headings.filter(node => !node.matches('button, summary') &&
            !(node.getAttribute('role') === 'button' && node.tabIndex >= 0 && node.hasAttribute('aria-expanded')));
          const disclosures = [...document.querySelectorAll('details')].filter(visible);
          const panels = [...document.querySelectorAll('.sidebar, .app-sidebar, .nd-imaging-controls, .control-panel')].filter(visible);
          return {
            bars: [...document.querySelectorAll('.nd-app-bar')].filter(visible).length,
            clippedNavigation: [...document.querySelectorAll('.nd-app-bar__action')].filter(visible).filter(node => {
              const rect = node.getBoundingClientRect();
              return rect.left < 0 || rect.right > document.documentElement.clientWidth + 1;
            }).map(describe),
            duplicates,
            legacyDisclosureCount: mouseOnly.length,
            mouseOnlyDisclosures: mouseOnly.filter(visible).map(describe),
            nativeDisclosures: disclosures.map(node => ({ title: describe(node.querySelector('summary') || node), open: node.open })),
            panels: panels.map(node => ({ id: describe(node).slice(0, 50), height: Math.round(node.getBoundingClientRect().height), scrollHeight: node.scrollHeight })),
            headings: [...document.querySelectorAll('h1, h2, h3, summary')].filter(visible).map(describe),
          };
        }));
        if (result.bars !== 1) result.failures.push(`Expected one shared app bar, found ${result.bars}`);
        if (result.legacyDisclosureCount > 0) {
          result.failures.push(`Mouse-only disclosure headings: ${result.legacyDisclosureCount}; use native disclosures or the shared button binding`);
        }
        if (result.clippedNavigation.length) result.failures.push(`Clipped navigation: ${result.clippedNavigation.join(', ')}`);
        if (result.duplicates.length) result.failures.push(`Duplicate navigation: ${result.duplicates.join(', ')}`);
        if (examples) {
          const selector = page.locator('select[data-neurodesk-example]');
          await expect(selector).toBeVisible();
          await expect(selector).toBeEnabled();
          const ids = await selector.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
          expect(ids).toEqual(examples.map(example => example.id));
          await selector.selectOption(examples[0].id);
          await expect(page.locator('#fileInfo')).toContainText(new URL(examples[0].url).pathname.split('/').pop(), { timeout: 120000 });
          await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
        }
        result.uploads = await page.locator('input[type="file"]').evaluateAll(inputs => inputs.map(input => ({
          id: input.id || input.name || 'unnamed file input',
          kind: input.dataset.neurodeskInput,
          accept: input.accept,
          multiple: input.multiple,
        })));
        for (const input of result.uploads) {
          if (!['image', 'model', 'surface', 'protocol', 'gradients', 'metadata', 'dataset'].includes(input.kind)) {
            result.failures.push(`${input.id}: declare data-neurodesk-input; scan fields must use image`);
          } else if (input.kind === 'image' && (input.accept || !input.multiple)) {
            result.failures.push(`${input.id}: use one multi-file NIfTI/DICOM picker without an accept filter, including extensionless DICOM`);
          }
        }
        const initialSections = await page.locator('[data-disclosure]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, collapsed: node.classList.contains('collapsed') })));
        for (const toggle of await page.locator('[data-disclosure-toggle]').all()) {
          if (!await toggle.isVisible()) continue;
          const expanded = await toggle.getAttribute('aria-expanded');
          const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
          const values = () => panel.locator('input, select, textarea').evaluateAll(nodes => nodes.map(node => [node.id, node.value, node.checked]));
          const before = await values();
          await toggle.focus();
          await page.keyboard.press('Space');
          await expect(toggle).toHaveAttribute('aria-expanded', String(expanded !== 'true'));
          if (expanded === 'true') await expect(panel).toBeHidden();
          await page.keyboard.press('Enter');
          await expect(toggle).toHaveAttribute('aria-expanded', expanded);
          expect(await values()).toEqual(before);
        }
        await page.evaluate(states => states.forEach(({ id, collapsed }) => document.getElementById(id).classList.toggle('collapsed', collapsed)), initialSections);
        const summaries = page.locator('details > summary:visible');
        for (const summary of await summaries.all()) {
          if (!await summary.isVisible() || await summary.evaluate(node => Boolean(node.closest('[inert]')))) continue;
          const details = summary.locator('..');
          const wasOpen = await details.evaluate(node => node.open);
          await summary.focus();
          await page.keyboard.press('Enter');
          await expect.poll(() => details.evaluate(node => node.open)).toBe(!wasOpen);
          await page.keyboard.press('Space');
          await expect.poll(() => details.evaluate(node => node.open)).toBe(wasOpen);
        }
        await page.evaluate(() => {
          document.activeElement?.blur();
          window.scrollTo(0, 0);
          document.querySelectorAll('body *').forEach(node => { node.scrollTop = 0; });
        });
        if (output) await page.screenshot({ path: join(output, `${app.id}-${viewport.width}.png`), fullPage: true });
      } catch (error) {
        result.failures.push(error.message);
      } finally {
        await context.close();
      }
      results.push(result);
      console.log(`${result.failures.length ? 'FAIL' : 'PASS'} ${app.id}/${viewport.width}: ${result.failures.join('; ') || 'single shared navigation'}; ${result.mouseOnlyDisclosures?.length ?? '?'} legacy disclosure headings`);
    }
  }
} finally {
  await browser.close();
  await site.close();
}
if (output) await writeFile(join(output, 'audit.json'), JSON.stringify(results, null, 2) + '\n');
if (results.some(result => result.failures.length)) process.exitCode = 1;
