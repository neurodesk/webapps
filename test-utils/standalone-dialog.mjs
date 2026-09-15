import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const catalog = JSON.parse(await readFile(new URL('../registry/standalone.json', import.meta.url)));

export async function verifyStandaloneDialog(page, id) {
  await page.locator('[data-neurodesk-shell-control="standalone"]:visible').first().click();
  const dialog = page.locator('#neurodeskStandaloneDialog');
  await expect(dialog).toBeVisible();
  for (const download of [...catalog.apps[id].downloads, ...(catalog.suite?.downloads || [])]) {
    await expect(dialog.locator(`a[href="${download.url}"]`)).toBeVisible();
    await expect(dialog).toContainText(download.sha256);
  }
  await expect(dialog).not.toContainText('cargo build');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}
