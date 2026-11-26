import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

  // Verify download from output result list
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#resultList .nd-download-btn').first().click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.nii\.gz$/);
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
