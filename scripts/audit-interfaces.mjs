#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadAppExamples } from './lib/app-examples.mjs';
import { loadVerifiedExampleCache } from './lib/example-asset-cache.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const { apps } = await loadAppsRegistry();
const requested = new Set((process.env.SMOKE_APPS ?? '').split(',').filter(Boolean));
const selected = requested.size ? apps.filter(app => requested.has(app.id)) : apps;
if (requested.size && selected.length !== requested.size) throw new Error('SMOKE_APPS contains an unknown app');
const cacheDirectory = process.env.EXAMPLE_ASSET_CACHE;
const assetLock = cacheDirectory ? JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json'), 'utf8')) : null;
if (cacheDirectory) console.log(`Example source: checksum-verified-cache (${cacheDirectory}); every declared example file must match the offline lock, with no missing-file network fallback`);
const site = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const output = process.env.INTERFACE_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const results = [];
try {
  for (const app of selected) {
    const examples = await loadAppExamples(app);
    const cachedExamples = cacheDirectory
      ? await loadVerifiedExampleCache(examples.flatMap(example => example.files), { directory: cacheDirectory, assets: assetLock.assets })
      : null;
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const result = { app: app.id, width: viewport.width, exampleSource: cachedExamples ? 'checksum-verified-cache' : 'hosted-network', failures: [] };
      try {
        if (cachedExamples) {
          await page.route(url => cachedExamples.has(url.href), route => {
            const asset = cachedExamples.get(route.request().url());
            return route.fulfill({
              body: asset.body,
              contentType: asset.contentType,
              headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
            });
          });
        }
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
        const selector = page.locator('select[data-neurodesk-example]');
        if (examples.length === 0) {
          await expect(selector).toHaveCount(0);
        } else {
          await expect(selector).toHaveCount(1);
          await expect(selector).toBeVisible();
          await expect(selector).toHaveAccessibleName('Example');
          // DICOMpare mounts its picker on From data; Zarro uses remote URLs.
          if (app.id === 'dicompare') await page.getByRole('button', { name: 'From data', exact: true }).click();
          const replacementInput = app.id === 'zarro' ? '#zarrUrl' : 'input[type="file"]';
          await expect.poll(() => selector.evaluate((select, input) =>
            Boolean(select.closest('nd-example-selector')?.uploadScope?.querySelector(input)), replacementInput),
          { message: `${app.id}: example upload scope must contain its replacement input` }).toBe(true);
          const ids = await selector.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
          expect(ids).toEqual(examples.map(example => example.id));
          const state = page.locator('[data-neurodesk-examples]');
          await expect(state).toHaveAttribute('data-example-state', 'idle');
          const gpuCapability = await page.evaluate(async () => {
            if (!navigator.gpu) return 'api-unavailable';
            return await navigator.gpu.requestAdapter() === null ? 'adapter-unavailable' : 'available';
          });
          const unsupportedMessage = async () => {
            const messages = await page.locator('#statusMsg:visible, #statusText:visible').allTextContents();
            return messages.find(message => /can[’']t initialize WebGPU/i.test(message)) ?? '';
          };
          await expect.poll(async () => {
            if (await selector.isEnabled()) return 'enabled';
            if (gpuCapability !== 'available' && await unsupportedMessage()) return 'unsupported';
            return 'waiting';
          }, { timeout: 120000 }).not.toBe('waiting');
          if (await selector.isDisabled()) {
            const message = await unsupportedMessage();
            expect(gpuCapability).not.toBe('available');
            expect(message).toMatch(/can[’']t initialize WebGPU/i);
            result.exampleImport = {
              status: 'skipped',
              example: examples[0].id,
              reason: message,
              capability: gpuCapability,
            };
            console.log(`SKIP ${app.id}/${viewport.width} example import: ${gpuCapability}; ${message}`);
          } else {
            await selector.selectOption(examples[0].id);
            await expect.poll(() => state.getAttribute('data-example-state', { timeout: 180000 }), { timeout: 180000 }).not.toBe('loading');
            await expect(state).toHaveAttribute('data-example-state', 'ready');
            await expect(state).toHaveAttribute('data-example-id', examples[0].id);
            result.example = examples[0].id;
            result.exampleImport = { status: 'passed', example: examples[0].id };
          }
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
        const example = page.locator('[data-neurodesk-examples]');
        if (await example.count()) result.failures.push(await example.locator('[role="status"]').textContent());
        if (output) await page.screenshot({ path: join(output, `${app.id}-${viewport.width}-failure.png`), fullPage: true }).catch(() => {});
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
