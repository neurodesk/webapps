// Browser test: proves MuscleMap's index.html import map resolves the shared
// @neurodesk/webapp-components/ui in a real browser, and that the shared ProgressManager
// drives #progressBar. Uses a tiny harness page that reuses the SAME import map + vendored
// files, so it exercises the real runtime wiring without needing ONNX models or ORT wasm.
import { test, expect } from "@playwright/test";

test("import map resolves shared ProgressManager and it updates #progressBar", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/harness.html");
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });

  const width = await page.evaluate(() => document.getElementById("progressBar").style.width);
  expect(width).toBe("50%");

  const fromShared = await page.evaluate(() => window.__fromSharedPackage === true);
  expect(fromShared).toBe(true);
  // file-io import-map entry resolves and works in-browser.
  expect(await page.evaluate(() => window.__fileIoOk === true)).toBe(true);
  expect(errors).toEqual([]);
});
