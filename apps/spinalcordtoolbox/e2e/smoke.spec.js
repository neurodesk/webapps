import { test, expect } from "@playwright/test";

// Proves this app's index.html import map resolves the shared @neurodesk/webapp-components
// in a real browser (via a tiny harness reusing the SAME import map + vendored files),
// without needing ONNX models or ORT wasm.
test("import map resolves shared components in-browser", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/harness.html");
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  expect(await page.evaluate(() => document.getElementById("progressBar").style.width)).toBe("50%");
  expect(await page.evaluate(() => window.__fromSharedPackage === true)).toBe(true);
  expect(await page.evaluate(() => window.__fileIoOk === true)).toBe(true);
  expect(errors).toEqual([]);
});
