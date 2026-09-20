// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const exampleUrl = examples[0].files[0].url;
import { writeFreeSurfer } from '../../../packages/topofit/src/results.js';

function niftiFixture(oblique = false) {
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
  if (oblique) {
    buffer.writeFloatLE(0.1, 284);
  }
  buffer.writeFloatLE(1, 300);
  buffer.writeFloatLE(1, 320);
  buffer.write('n+1\0', 344, 'ascii');
  for (let index = 0; index < 8; index += 1) buffer.writeFloatLE(index, 352 + index * 4);
  return { name: 'tiny.nii', mimeType: 'application/nifti', buffer };
}

function surfaceFixture() {
  return Array.from(new Uint8Array(writeFreeSurfer(
    Float32Array.from([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    Int32Array.from([
      0, 2, 1,
      0, 1, 3,
      0, 3, 2,
      1, 2, 3,
    ]),
  )));
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
  await page.locator('#imageInput').setInputFiles(niftiFixture(true));
  const modelRequest = page.waitForRequest(/trega-synth-random\.onnx/, { timeout: 10_000 });
  await page.route('**/trega-synth-random.onnx*', (route) => route.fulfill({ body: '' }));
  await page.locator('#runButton').click();
  await modelRequest;
  await expect(page.locator('#statusText')).toContainText('Model size mismatch');
});

test('optional example is rejected when its checksum differs', async ({ page }) => {
  await page.goto('/');
  await page.route(exampleUrl, (route) => route.fulfill({ body: 'not the scan' }));
  await page.locator('[data-neurodesk-example]').selectOption('openneuro-t1');
  await expect(page.locator('#statusText')).toContainText('checksum for sub-01_T1w.nii.gz did not match');
});

test('cancelling a pending example preserves the selected image and permits retry', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  await page.route(exampleUrl, async route => {
    attempts++;
    if (attempts === 1) await held;
    await route.fulfill({ status: 503 }).catch(() => {});
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  await expect(page.locator('#runButton')).toBeEnabled();
  const original = await page.locator('#fileInfo').textContent();
  const picker = page.locator('[data-neurodesk-example]');
  const request = page.waitForRequest(exampleUrl);
  await picker.selectOption('openneuro-t1');
  await request;
  await page.getByRole('button', { name: 'Cancel example download' }).click();
  release();
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#fileInfo')).toHaveText(original);
  await expect(page.locator('#runButton')).toBeEnabled();
  await picker.selectOption('openneuro-t1');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error');
  await expect(picker).toBeEnabled();
  expect(attempts).toBe(2);
});

test('surface checkboxes show multiple meshes and expose the X-ray control', async ({ page }) => {
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.evaluate((bytes) => {
    class ResultWorker {
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: {
          type: 'result',
          files: ['lh-white', 'rh-white', 'lh-registration'].map((id) => ({
            id,
            name: id === 'lh-registration' ? 'lh.sphere' : id.replace('-', '.'),
            mediaType: 'application/vnd.freesurfer.surface',
            bytes: Uint8Array.from(bytes).buffer,
          })),
          provenance: { surfaceVertices: 4 },
          elapsedSeconds: 1,
        } }));
      }

      terminate() {}
    }
    window.Worker = ResultWorker;
  }, surfaceFixture());
  await page.locator('#runButton').click();

  const left = page.getByRole('checkbox', { name: 'Show Left white surface' });
  const right = page.getByRole('checkbox', { name: 'Show Right white surface' });
  const canvas = page.locator('#gl1');
  const hiddenSurface = await canvas.screenshot();
  await expect(page.locator('#resultList')).not.toContainText(/registration/i);
  await left.check();
  await expect(left).toBeEnabled();
  const visibleSurface = await canvas.screenshot();
  expect(visibleSurface.equals(hiddenSurface)).toBe(false);
  await expect(page.getByRole('radio', { name: 'Multi+Render', exact: true })).toHaveAttribute('data-state', 'on');
  await expect(page.locator('#meshXRay')).toHaveValue('0');
  await left.uncheck();
  await expect(left).toBeEnabled();
  const hiddenAgain = await canvas.screenshot();
  expect(hiddenAgain.equals(visibleSurface)).toBe(false);
  await expect(page.locator('#imageLabel')).toHaveText('ORIGINAL IMAGE');
  await page.evaluate(() => {
    const [leftSurface, rightSurface] = document.querySelectorAll('.nd-result-visibility input');
    leftSurface.click();
    rightSurface.click();
  });
  await expect(left).toBeEnabled();
  await expect(left).toBeChecked();
  await expect(right).not.toBeChecked();
  await right.check();
  await expect(right).toBeEnabled();
  await expect(page.locator('#imageLabel')).toHaveText('LEFT WHITE SURFACE · RIGHT WHITE SURFACE');
  await page.locator('#meshXRay').fill('0.25');
  await expect(page.locator('#meshXRayValue')).toHaveText('25%');
  await left.uncheck();
  await expect(page.locator('#imageLabel')).toHaveText('RIGHT WHITE SURFACE');
  const selectedSurface = await canvas.screenshot();
  await page.evaluate(() => {
    class PendingWorker {
      postMessage() {}
      terminate() {}
    }
    window.Worker = PendingWorker;
  });
  await page.locator('#runButton').click();
  await expect(page.locator('#imageLabel')).toHaveText('ORIGINAL IMAGE');
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(0);
  expect((await canvas.screenshot()).equals(selectedSurface)).toBe(false);
  await page.locator('#cancelButton').click();
});

test('FreeBrowse initialization failure releases the viewer for retry', async ({ page }) => {
  await page.addInitScript(() => {
    window.rejectViewerContext = true;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (window.rejectViewerContext && type === 'webgl2') return null;
      return getContext.call(this, type, ...args);
    };
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#imageInput')).toBeEnabled();
  await page.evaluate(() => { window.rejectViewerContext = false; });
  await page.locator('#imageInput').setInputFiles(niftiFixture());
  await expect(page.locator('#statusText')).toContainText('Image loaded');
  await expect(page.locator('.freebrowse-root')).toBeVisible();
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('.freebrowse-root')).toBeVisible();
  await page.getByRole('radio', { name: 'Axial view', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Axial view', exact: true })).toHaveAttribute('data-state', 'on');
});
