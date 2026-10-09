// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#controls")).toBeVisible();
  await expect(page.locator("#filePicker[data-neurodesk-input='image']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "About" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Privacy" })).toBeVisible();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nd-app-bar")).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.locator("#aboutDlg")).toBeVisible();
  await page.locator("#aboutDlg").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts _headers (or the COI service worker) worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test('vector generator preserves settings across closing and downloads a scheme', async ({ page }) => {
  await page.goto('/');
  await page.locator('#viewSection').evaluate((section) => { section.open = true; });
  await page.locator('#genVecBtn').click();
  const dialog = page.locator('#genVecDlg');
  await expect(dialog).toBeVisible();
  await dialog.locator('#genVecShells input').first().fill('12');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#genVecBtn').click();
  await expect(dialog.locator('#genVecShells input').first()).toHaveValue('12');
  await expect(dialog.locator('#genVecSaveBtn')).toBeEnabled({ timeout: 60000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.locator('#genVecSaveBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.dvs$/);
});
