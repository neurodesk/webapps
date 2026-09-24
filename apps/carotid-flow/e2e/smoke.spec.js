// Real browser tests against the built app (see playwright.config.js): boot, the shared shell,
// and the hosted example through detection to the downloads. CAROTID_FLOW_EXAMPLE points at the
// requesting lab's unsigned export, which is not public; its test is skipped without it.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const example = examples[0];
const local = process.env.CAROTID_FLOW_EXAMPLE;

async function ready(page) {
  await page.goto('./');
  await expect(page.locator('#statusText')).toHaveText('Ready · choose an example or drop a phase-contrast series', { timeout: 60000 });
}

test('shared app bar owns information actions and theme', async ({ page }) => {
  await ready(page);
  const bar = page.locator('.nd-app-bar:visible');
  await expect(bar).toHaveCount(1);
  await expect(page.locator('#controls > #aboutBtn')).toBeHidden();
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('standalone_automatic_carotid_flow.m');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  await bar.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test('the example finds both carotids and downloads their flow curves and labels', async ({ page }) => {
  test.setTimeout(120000);
  await ready(page);
  await page.locator('select[data-neurodesk-example]').selectOption(example.id);
  await expect(page.locator('#fileInfo')).toHaveText('carotid_pc_mod.nii.gz · 400 × 400 · 28 cardiac frames', { timeout: 120000 });
  await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  await page.locator('#runButton').click();
  // examples.json expectedResult; the right carotid is within 6 % of PCMCalculator's 225 ml/min.
  await expect(page.locator('#statusText')).toContainText('Both carotids found · left 231 ml/min, right 211 ml/min · systolic peak at frame 4');
  await expect(page.locator('#outputSection')).toHaveAttribute('open', '');
  await expect(page.locator('#flowChart polyline')).toHaveCount(2);
  await expect(page.locator('#flowChart')).toContainText('Flow (ml/min)');
  await expect(page.locator('#meanHeader')).toHaveText('Mean ml/min');
  await expect(page.locator('#metricsBody tr')).toHaveText([/^Left14\.0231344 @ 40\.87$/, /^Right12\.2211323 @ 40\.90$/]);
  await expect(page.locator('#imageLabel')).toHaveText('MEAN AMPLITUDE');

  const csvDownload = page.waitForEvent('download');
  await page.locator('#saveButton').click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe('carotid_pc_mod_carotid_curves.csv');
  const rows = readFileSync(await csv.path(), 'utf8').trim().split('\n');
  expect(rows[0]).toBe('frame,left_velocity_cm_s,left_flow_ml_min,right_velocity_cm_s,right_flow_ml_min');
  expect(rows).toHaveLength(29);

  const labelsDownload = page.waitForEvent('download');
  await page.locator('#resultList .nd-volume-toggle').filter({ hasText: 'Carotid labels' }).getByRole('button', { name: 'Download' }).click();
  const labels = readFileSync(await (await labelsDownload).path());
  const voxels = labels.subarray(352);
  expect(voxels.length).toBe(400 * 400);
  expect(voxels.filter(value => value === 1).length).toBe(39);
  expect(voxels.filter(value => value === 2).length).toBe(34);

  await page.locator('#resultList .nd-volume-toggle').filter({ hasText: 'Velocity temporal SD' }).getByRole('button', { name: 'View' }).click();
  await expect(page.locator('#imageLabel')).toHaveText('VELOCITY TEMPORAL SD');
});

test('an invalid setting is reported beside its field and a corrected run succeeds', async ({ page }) => {
  test.setTimeout(120000);
  await ready(page);
  await page.locator('select[data-neurodesk-example]').selectOption(example.id);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#venc').fill('5000');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Velocity encoding (VENC) must lie between 0 and 1000.');
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#venc')).toBeFocused();
  await expect(page.locator('#saveButton')).toBeDisabled();
  await page.locator('#venc').fill('');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Both carotids found');
});

test('the lab export without a second carotid reports why', async ({ page }) => {
  test.skip(!local, 'needs CAROTID_FLOW_EXAMPLE');
  await ready(page);
  await page.locator('#imageInput').setInputFiles(local);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Both carotids found · left 4 px, right 12 px · systolic peak at frame 20');
  await expect(page.locator('#flowChart')).toContainText('Phase signal (a.u.)');
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#candidatePercentile').fill('99.99');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText(/need two/);
  await expect(page.locator('#saveButton')).toBeDisabled();
});

for (const failure of ['download', 'empty image']) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    let attempts = 0;
    await page.route(example.files[0].url, route => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === 'download' ? 503 : 200, body: '' });
    });
    await ready(page);
    const picker = page.getByRole('combobox', { name: 'Example', exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error');
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(page.locator('#runButton')).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test('cancelling during image reading prevents a late commit and permits retry', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole('combobox', { name: 'Example', exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === 'function', null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Cancel example download', exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#fileInfo')).toBeHidden();
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled();
});
