import { expect, test } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { createNiftiFromData, createNiftiHeaderFromVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';

// A software phantom tests cropping and memory handling, not model accuracy.
function neckImage([nx, ny, nz]) {
  const data = new Uint8Array(nx * ny * nz);
  const center = [nx / 2, ny / 2, nz - 100];
  const radii = [nx / 2 - 10, ny / 2 - 10, 85];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const head = ((x - center[0]) / radii[0]) ** 2 + ((y - center[1]) / radii[1]) ** 2 + ((z - center[2]) / radii[2]) ** 2;
        const neck = z < center[2] && (x - center[0]) ** 2 + (y - center[1]) ** 2 < 20 ** 2;
        if (head < 1 || neck) data[x + nx * (y + ny * z)] = 50 + (x + y + z) % 100;
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ dims: [nx, ny, nz],
    hdr: { affine: [[1, 0, 0, -nx / 2], [0, 1, 0, -ny / 2], [0, 0, 1, -nz / 2], [0, 0, 0, 1]] } });
  return { name: 'neck.nii.gz', mimeType: 'application/gzip', buffer: gzipSync(createNiftiFromData(data, header)) };
}

async function observeWorker(page) {
  await page.addInitScript(() => {
    window.synthsegMessages = [];
    window.synthsegJobs = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('inference-worker')) {
          this.addEventListener('message', ({ data }) => window.synthsegMessages.push(data));
          const post = this.postMessage.bind(this);
          this.postMessage = (job) => {
            window.synthsegJobs.push(job.options);
            post(job);
          };
        }
      }
    };
  });
  // These cases stop after preprocessing; the real-model fixture suite checks inference.
  await page.route(/synthseg-2\.0\.onnx/, (route) => route.abort());
}

test('an oversized scan crops its neck before loading the model at 1 mm', async ({ page }) => {
  await observeWorker(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(neckImage([128, 128, 512]));
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await expect(page.locator('#statusText')).toContainText('Could not download', { timeout: 60000 });
  const messages = await page.evaluate(() => window.synthsegMessages);
  expect(messages.some(({ message }) => message.includes('Cropping excess neck'))).toBe(true);
  expect(messages.some(({ message }) => message.includes('Neck crop ready'))).toBe(true);
  expect(messages.some(({ message }) => message.includes('resampling to 1 mm'))).toBe(true);
  expect(messages.some(({ recommendation }) => recommendation)).toBe(false);
  await expect(page.locator('#downsampleButton')).toBeHidden();
  await expect(page.locator('#fileInfo')).toContainText('128 × 128 × 512');
  await expect(page.locator('#cancelBtn')).toBeHidden();
});

test('a crop that still exceeds memory offers downsampling and retries only after the choice', async ({ page }) => {
  await observeWorker(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(neckImage([256, 256, 384]));
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await expect(page.locator('#downsampleButton')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#statusText')).toContainText('After neck cropping');
  const first = await page.evaluate(() => window.synthsegMessages.find(({ recommendation }) => recommendation).recommendation);
  expect(first.preparation.robustFov).toBe(true);
  expect(first.preparation.originalShape).toEqual([256, 256, 384]);
  expect(first.preparation.croppedShape[2]).toBeLessThan(384);
  expect(first.voxelSizeMm).toBeGreaterThan(1);
  await expect(page.locator('#voxelSizeMm')).toHaveValue('1');
  await expect(page.locator('#downsampleButton')).toHaveText(`Use ${first.voxelSizeMm} mm and segment`);
  await expect(page.locator('#cancelBtn')).toBeHidden();
  expect(await page.evaluate(() => window.synthsegJobs.length)).toBe(1);
  await page.locator('#preparationSection > summary').click();
  await page.locator('#preparationSection > summary').click();
  await expect(page.locator('#robustFov')).toBeChecked();
  await page.locator('#downsampleButton').click();
  await expect(page.locator('#statusText')).toContainText('Could not download', { timeout: 60000 });
  await expect(page.locator('#voxelSizeMm')).toHaveValue(String(first.voxelSizeMm));
  expect(await page.evaluate(() => window.synthsegJobs.map(({ voxelSizeMm }) => voxelSizeMm))).toEqual([1, first.voxelSizeMm]);
  expect(await page.evaluate(() => window.synthsegMessages.some(({ message }) => message.includes('Prepared')))).toBe(true);
  await expect(page.locator('#fileInfo')).toContainText('256 × 256 × 384');
  await expect(page.locator('#saveBtn')).toBeDisabled();
  await page.locator('#imageInput').setInputFiles('../../exes/synthseg/test/fixtures/small.nii.gz');
  await expect(page.locator('#statusText')).toContainText('Image loaded');
  await expect(page.locator('#voxelSizeMm')).toHaveValue('1');
  await expect(page.locator('#downsampleButton')).toBeHidden();
});

test('cropping can be disabled and preparation choices survive closing the section', async ({ page }) => {
  await observeWorker(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(neckImage([160, 160, 512]));
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#preparationSection > summary').click();
  await page.locator('#robustFov').uncheck();
  await page.locator('#preparationSection > summary').click();
  await page.locator('#processButton').click();
  await expect(page.locator('#downsampleButton')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#robustFov')).not.toBeChecked();
  expect(await page.evaluate(() => window.synthsegMessages.some(({ message }) => message.includes('Cropping excess neck')))).toBe(false);
  await page.locator('#voxelSizeMm').fill('2');
  await page.locator('#voxelSizeMm').press('Tab');
  await expect(page.locator('#downsampleButton')).toBeHidden();
  await page.locator('#preparationSection > summary').click();
  await page.locator('#preparationSection > summary').click();
  await expect(page.locator('#voxelSizeMm')).toHaveValue('2');
});

test('cancelling a neck crop prevents its worker from publishing a retry offer', async ({ page }) => {
  await observeWorker(page);
  let release;
  await page.route(/niimath-.*\.wasm/, async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.continue().catch(() => {});
  });
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(neckImage([256, 256, 384]));
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await expect.poll(() => Boolean(release), { timeout: 30000 }).toBe(true);
  await page.locator('#cancelBtn').click();
  release();
  await expect(page.locator('#statusText')).toContainText('Processing cancelled');
  await expect(page.locator('#downsampleButton')).toBeHidden();
  await expect(page.locator('#processButton')).toBeEnabled();
  await expect(page.locator('#saveBtn')).toBeDisabled();
});
