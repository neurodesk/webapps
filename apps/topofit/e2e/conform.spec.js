import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

function integerVolume(spacing = 2) {
  const buffer = Buffer.alloc(352 + 60 * 2);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  for (const [axis, size] of [3, 4, 5].entries()) {
    buffer.writeInt16LE(size, 42 + axis * 2);
    buffer.writeFloatLE(spacing, 80 + axis * 4);
    buffer.writeFloatLE(spacing, 280 + axis * 20);
    buffer.writeFloatLE(4 + axis, 292 + axis * 16);
  }
  buffer.writeInt16LE(4, 70);
  buffer.writeInt16LE(16, 72);
  buffer.writeFloatLE(352, 108);
  buffer.writeInt16LE(1, 254);
  buffer.write('n+1\0', 344, 'ascii');
  for (let index = 0; index < 60; index += 1) buffer.writeInt16LE(index - 20, 352 + index * 2);
  return { name: 'integer.nii', mimeType: 'application/nifti', buffer };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.inferenceDigests = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (!String(url).includes('inference-worker')) {
          super(url, options);
          return;
        }
        const source = `
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          let digestCount = 0;
          crypto.subtle.digest = async (algorithm, bytes) => {
            const result = await digest(algorithm, bytes);
            self.postMessage({
              type: 'test-inference-digest',
              byteLength: bytes.byteLength,
              sha256: Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join(''),
            });
            if (++digestCount === 2) throw new Error('Conform regression probe complete');
            return result;
          };
          const pending = [];
          self.onmessage = event => pending.push(event);
          await import(${JSON.stringify(String(url))});
          for (const event of pending) self.onmessage(event);
        `;
        const wrapper = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        super(wrapper, { ...options, type: 'module' });
        URL.revokeObjectURL(wrapper);
        this.addEventListener('message', (event) => {
          if (event.data.type !== 'test-inference-digest') return;
          window.inferenceDigests.push(event.data);
          event.stopImmediatePropagation();
        });
      }
    };
  });
  await page.goto('/');
});

test('production worker conforms integer intensities with the reference cubic interpolation', async ({ page }) => {
  await page.locator('#imageInput').setInputFiles(integerVolume());
  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.inferenceDigests.length)).toBeGreaterThanOrEqual(2);
  const inference = await page.evaluate(() => window.inferenceDigests[1]);
  expect(inference.byteLength).toBe(256 ** 3 * 4);
  // nibabel 5.4.2 processing.conform(..., orientation='RAS'), SciPy 1.14.1.
  // Input is arange(60, dtype=int16).reshape((3,4,5), order='F') - 20,
  // affine diag(2,2,2,1) with translation (4,5,6); hash float32 output in Fortran order.
  expect(inference.sha256).toBe('f4cca635ea46f7eb11cec9961456327257afc32db2a96800123d4b783a4b2d69');
  await expect(page.locator('#statusText')).toContainText('Conform regression probe complete');
});

test('production worker preserves an identity 1 mm input grid as BrainNet does', async ({ page }) => {
  await page.locator('#imageInput').setInputFiles(integerVolume(1));
  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.inferenceDigests.length)).toBeGreaterThanOrEqual(2);
  const inference = await page.evaluate(() => window.inferenceDigests[1]);
  const original = Float64Array.from({ length: 60 }, (_, index) => index - 20);
  expect(inference.byteLength).toBe(original.byteLength);
  expect(inference.sha256).toBe(createHash('sha256').update(Buffer.from(original.buffer)).digest('hex'));
  await expect(page.locator('#statusText')).toContainText('Conform regression probe complete');
});
