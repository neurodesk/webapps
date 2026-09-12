// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";

function niftiFixture() {
  const buffer = Buffer.alloc(352 + 2 * 2 * 2 * 4);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  for (let axis = 1; axis <= 3; axis += 1) buffer.writeInt16LE(2, 40 + axis * 2);
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  for (let axis = 1; axis <= 3; axis += 1) buffer.writeFloatLE(1, 76 + axis * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeInt16LE(1, 254);
  buffer.writeFloatLE(1, 280);
  buffer.writeFloatLE(1, 300);
  buffer.writeFloatLE(1, 320);
  buffer.write('n+1\0', 344, 'ascii');
  for (let index = 0; index < 8; index += 1) buffer.writeFloatLE(index, 352 + index * 4);
  return { name: 'tiny.nii', mimeType: 'application/nifti', buffer };
}

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const layout = await page.evaluate(() => {
    const controls = document.querySelector('#controls').getBoundingClientRect();
    const viewer = document.querySelector('#viewer').getBoundingClientRect();
    const uploadIcon = document.querySelector('.nd-file svg').getBoundingClientRect();
    return { controlsWidth: controls.width, viewerLeft: viewer.left, uploadIconHeight: uploadIcon.height };
  });
  expect(layout.controlsWidth).toBeLessThan(400);
  expect(layout.viewerLeft).toBeGreaterThanOrEqual(layout.controlsWidth - 1);
  expect(layout.uploadIconHeight).toBeLessThan(32);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts the shared isolation policy worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/");
  const ok = await page.evaluate(async () => {
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    return await new Promise((resolve) => {
      const finish = (result) => {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      w.onmessage = (e) => finish(e.data === "pong");
      w.onerror = () => finish(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});

test('input, cancellation, and privacy workflow preserve the scan', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#runButton')).toBeDisabled();
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#statusText')).toContainText('ready to reconstruct');
  await page.route('**/trega-synth-random.onnx*', () => {});
  await page.locator('#runButton').click();
  await expect(page.locator('#cancelButton')).toBeVisible();
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
  const bar = page.locator('.nd-app-bar:visible');
  await bar.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('stay in this browser');
});

test('production inference worker starts the verified model request', async ({ page }) => {
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  const modelRequest = page.waitForRequest(/trega-synth-random\.onnx/, { timeout: 10_000 });
  await page.route('**/trega-synth-random.onnx*', (route) => route.fulfill({ body: '' }));
  await page.locator('#runButton').click();
  await modelRequest;
  await expect(page.locator('#statusText')).toContainText('Model size mismatch');
});

test('optional example is rejected when its checksum differs', async ({ page }) => {
  await page.goto('/');
  await page.route('https://s3.amazonaws.com/openneuro.org/**', (route) => route.fulfill({ body: 'not the scan' }));
  await page.locator('#exampleImages > summary').click();
  await page.locator('#exampleButton').click();
  await expect(page.locator('#statusText')).toContainText('checksum did not match');
});
