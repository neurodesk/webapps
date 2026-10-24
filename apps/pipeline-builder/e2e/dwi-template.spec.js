import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const example = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8')).find(value => value.id === 'dwi-preprocessing');
const template = JSON.parse(readFileSync(new URL('../src/workflows/dwi-preprocessing.workflow.json', import.meta.url), 'utf8'));

test('the pinned DWI preprocessing example validates and exports unchanged', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#toolSelect')).toBeEnabled();
  await page.getByRole('combobox', { name: 'Input', exact: true }).selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready');
  await expect(page.locator('#fileInfo')).toHaveText('dwi-preprocessing.workflow.json');
  await expect(page.locator('#stepRows tr')).toHaveCount(6);
  await expect(page.locator('#validationSummary')).toHaveText('Valid · 6 steps.');
  const event = page.waitForEvent('download');
  await page.locator('#runButton').click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('dwi-preprocessing.workflow.json');
  expect(JSON.parse(readFileSync(await download.path(), 'utf8'))).toEqual(template);
});
