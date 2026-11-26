import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));

test('app boots with shared bar, dialogs, theme switch and cross-origin isolation', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#viewer')).toBeVisible();
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);

  const bar = page.locator('.nd-app-bar:visible');
  await expect(bar).toHaveCount(1);
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('dialog[open]')).toContainText('Faria Lab');
  await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click();

  await bar.getByRole('button', { name: 'Cite', exact: true }).click();
  await expect(page.locator('dialog[open]').last()).toContainText('Automatic comprehensive radiological reports');
  await page.locator('dialog[open]').last().getByRole('button', { name: 'Close', exact: true }).click();

  await bar.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.locator('dialog[open]').last()).toContainText('never uploaded');
  await page.locator('dialog[open]').last().getByRole('button', { name: 'Close', exact: true }).click();

  await bar.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
});

test('example selector loads StrokeFAIR MNI case, runs reporting + TreeSHAP + StrokeView UMAP, and handles download', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./');
  const select = page.locator('select[data-neurodesk-example]');
  await expect(select).toBeVisible();
  await select.selectOption('strokefair-sub-02e8eb42-mni');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });

  await page.locator('#runButton').click();
  await expect(page.locator('#reportView')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#reportView')).toContainText('Automatic Radiological Report');
  await expect(page.locator('#reportView')).toContainText('MCA ASPECTS');

  // Switch to TreeSHAP tab
  await page.locator('#reportView').getByRole('button', { name: 'Atlases & TreeSHAP' }).click();
  await expect(page.locator('#reportView')).toContainText('TreeSHAP feature attributions');
  await expect(page.locator('.openads-bar-track').first()).toBeVisible();

  // Switch to StrokeView cohort UMAP tab
  await page.locator('#reportView').getByRole('button', { name: 'StrokeView cohort (UMAP)' }).click();
  await expect(page.locator('.openads-umap-svg')).toBeVisible();
  await expect(page.locator('#reportView')).toContainText('Clinical phenotype');

  // Verify download of the generated MNI stroke mask and inspect its NIfTI-1 header
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#resultList .nd-volume-toggle[data-stage="stroke_mni"] .nd-download-btn').click(),
  ]);
  expect(dl.suggestedFilename()).toBe('sub-02e8eb42_stroke-mask_space-MNI152.nii.gz');
  const dlPath = await dl.path();
  const gz = readFileSync(dlPath);
  expect(gz[0]).toBe(0x1f);
  expect(gz[1]).toBe(0x8b);
  const raw = gunzipSync(gz);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect(view.getInt32(0, true)).toBe(348);
  expect([view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)]).toEqual([182, 218, 182]);

  // Verify mask editor opens via start(), applies edits, and feeds the edited mask into re-runs
  await page.locator('#resultList .nd-volume-toggle[data-stage="stroke_mni"] .nd-edit-btn').click();
  const editor = page.locator('nd-mask-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#resultList .nd-volume-toggle[data-stage="stroke_mni"]')).toContainText('(edited)');
  await expect(page.locator('#maskSelect option:checked')).toContainText('sub-02e8eb42_stroke-mask_space-MNI152');
  await expect(page.locator('.openads-edit-note')).toHaveCount(1);
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText(/Done in /, { timeout: 120_000 });
  await expect(page.locator('.openads-edit-note')).toHaveCount(0);
  await expect(page.locator('#resultList .nd-volume-toggle[data-stage="stroke_mni"]')).not.toContainText('(edited)');
});

test('page drop via the shared shell loads and classifies a dropped NIfTI file', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const buf = new ArrayBuffer(352 + 8 * 4);
    const view = new DataView(buf);
    view.setInt32(0, 348, true);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 2, true);
    view.setInt16(70, 16, true);
    view.setInt16(72, 32, true);
    view.setFloat32(80, 1, true);
    view.setFloat32(84, 1, true);
    view.setFloat32(88, 1, true);
    view.setFloat32(108, 352, true);
    view.setFloat32(112, 1, true);
    view.setInt16(254, 1, true);
    view.setFloat32(280, 1, true);
    view.setFloat32(300, 1, true);
    view.setFloat32(320, 1, true);
    new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
    const file = new File([buf], 'sub-drop_stroke_space-MNI152.nii', { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('#maskSelect')).toHaveValue('0', { timeout: 10_000 });
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('example loading handles failure and retry cleanly', async ({ page }) => {
  test.setTimeout(90_000);
  let failing = true;
  let failures = 0;
  await page.route(examples[0].files[0].url, (route) => {
    if (failing) {
      failures++;
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fallback();
  });
  await page.goto('./');
  const select = page.locator('select[data-neurodesk-example]');
  await select.selectOption('strokefair-sub-02e8eb42-mni');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error', { timeout: 30_000 });
  await expect(page.locator('#runButton')).toBeDisabled();
  expect(failures).toBeGreaterThan(0);

  failing = false;
  await select.selectOption('strokefair-sub-02e8eb42-mni');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 60_000 });
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('cancelling an active analysis stops the worker and restores controls', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('./');
  const select = page.locator('select[data-neurodesk-example]');
  await select.selectOption('strokefair-sub-02e8eb42-mni');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });

  await page.locator('#runButton').click();
  await expect(page.locator('#cancelButton')).toBeVisible({ timeout: 15_000 });
  await page.locator('#cancelButton').click();
  await expect(page.locator('#cancelButton')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#statusText')).toContainText('Cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
});
