import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const appRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', appRoot)));
const site = await serveSite(new URL('dist/', appRoot).pathname);
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const artifacts = join(process.env.TMPDIR || process.env.RUNNER_TEMP || 'test-results', 'qsmbly-upstream-browser');
await mkdir(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(site.origin);
  const selector = page.getByRole('combobox', { name: 'Example', exact: true });
  await expect(selector).toBeEnabled({ timeout: 120000 });
  await page.locator('.nd-app-bar:visible').first().getByRole('button', { name: 'About', exact: true }).click();
  const about = page.locator('#aboutModal');
  await expect(about.getByRole('link', { name: 'QSMbly (upstream)' })).toHaveAttribute('href', 'https://github.com/astewartau/qsmbly');
  await expect(about.getByRole('link', { name: 'QSMbly (upstream)' })).toBeVisible();
  await expect(about).toContainText('Ashley Stewart');
  await page.screenshot({ path: join(artifacts, 'about-desktop.png'), animations: 'disabled' });
  await about.locator('.modal-close').click();
  await selector.selectOption('real-brain-qsm');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 180000 });
  await page.locator('#prepareMaskInput').click();
  await expect(page.locator('#runHdBet')).toBeEnabled({ timeout: 120000 });
  await page.locator('#runHdBet').click();
  await expect(page.locator('#hdBetSettingsModal')).toBeVisible();
  await expect(page.locator('#hdBetWeightsNote')).toBeVisible();
  await page.getByLabel('Patch step').selectOption('0.75');
  await page.locator('#resetHdBetSettings').click();
  await expect(page.getByLabel('Patch step')).toHaveValue('0.5');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'hd-bet-phone.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#runMouseBet').click();
  const mouse = page.locator('#mouseBrainModal');
  await expect(mouse).toBeVisible();
  await expect(mouse).toContainText('GPL-3.0');
  await page.screenshot({ path: join(artifacts, 'mouse-brain-desktop.png') });
  await page.locator('#runMouseScaledBet').click();
  await expect(mouse).toBeHidden();
  await expect(page.locator('#betSettingsTitle')).toHaveText('Mouse BET Settings');
  await expect(page.locator('#betVoxelScale')).toHaveValue('10');
  await page.locator('#runBetWithSettings').click();
  await page.waitForFunction(() => window.app?.maskController?.currentMaskData?.some(value => value > 0), null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.app.maskVoxelScale), 10);
  console.log('PASS QSMbly: mouse brain dialog and voxel-scaled BET fallback');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  console.log('PASS QSMbly: About upstream link, shared HD-BET dialog, and cross-origin isolation');

  const result = await page.evaluate(async ({ origin, version }) => {
    const source = `
      import init, * as base from '${origin}/wasm/qsm_wasm.js';
      import { fetchModelWeights, loadDlWasm, parseRegistry } from '${origin}/js/modules/ModelWeights.js';
      import { MODEL_WEIGHT_BASE_URL } from '${origin}/js/app/config.js';
      try {
        await init();
        await base.initThreadPool(2);
        const model = parseRegistry(base.get_model_registry_wasm()).xqsm;
        const [weights] = await fetchModelWeights(model, null, MODEL_WEIGHT_BASE_URL);
        const dl = await loadDlWasm('${origin}', '${version}');
        await dl.initThreadPool(1);
        const n = 16;
        const field = Float64Array.from({ length: n ** 3 }, (_, i) => Math.sin(i / 19) * 0.01);
        const mask = new Uint8Array(n ** 3).fill(1);
        const output = dl.run_dl_field_inversion_wasm('xqsm', field, mask, n, n, n,
          1, 1, 1, 0, 0, 1, weights, new Uint8Array(), false, 16, 4, () => {});
        self.postMessage({ length: output.length, finite: output.every(Number.isFinite),
          nonzero: output.some(value => value !== 0) });
      } catch (error) { self.postMessage({ error: error.message || String(error) }); }
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DL inference timed out')), 180000);
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, { origin: site.origin, version: manifest.version });
  assert.deepEqual(result, { length: 4096, finite: true, nonzero: true });
  console.log('PASS QSMbly: pinned xQSM weights, lazy DL bundle, Rayon workers and real inference');
} finally {
  await browser.close();
  await site.close();
}
