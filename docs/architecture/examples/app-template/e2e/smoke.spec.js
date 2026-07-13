// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts _headers (or the COI service worker) worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/");
  const ok = await page.evaluate(async () => {
    // Inline classic worker — mirrors the apps' importScripts worker style.
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    return await new Promise((resolve) => {
      w.onmessage = (e) => resolve(e.data === "pong");
      w.onerror = () => resolve(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});
