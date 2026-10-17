import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readVolume } from '../../../packages/synthsr/src/volume.js';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const source = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function finish(page, timeout) {
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout, intervals: [250, 1000, 2000] }).toBe('succeeded');
}

async function download(page) {
  const downloading = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'image' });
  return readVolume(source(await readFile(await (await downloading).path())));
}

// A defaced image is the input on its own grid with some voxels zeroed and the rest unchanged.
function expectMaskedCopy(output, input) {
  expect(output.dims).toEqual(input.dims);
  expect(output.affine).toEqual(input.affine);
  let removed = 0;
  let kept = 0;
  for (let index = 0; index < input.data.length; index++) {
    if (input.data[index] !== 0 && output.data[index] === 0) removed++;
    if (output.data[index] !== 0) {
      kept++;
      if (output.data[index] !== input.data[index]) throw new Error(`Unmasked voxel ${index} changed intensity`);
    }
  }
  expect(removed).toBeGreaterThan(100);
  expect(kept).toBeGreaterThan(100);
}

test('cancel terminates the worker and retry returns the actual native-grid defaced image', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  const workerCreated = page.waitForEvent('worker', { predicate: worker => /\/worker-[^/]+\.js$/.test(worker.url()) });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate_hel' } });
  const worker = await workerCreated;
  const closed = new Promise(resolve => worker.once('close', resolve));
  await dispatch(page, 'cancel');
  await closed;
  const cancelled = await dispatch(page, 'snapshot');
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.report).toBeUndefined();
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate' } });
  await finish(page, 120000);
  expectMaskedCopy(await download(page), readVolume(source(await readFile(fixture))));
  expect((await dispatch(page, 'snapshot')).report.provenance.method).toBe('allineate');
});

test('a niimath startup failure reports an error and a retry produces a defaced image', async ({ page }) => {
  await page.context().route('**/niimath-*.wasm', route => route.abort('failed'));
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 10000 }).toBe('failed');
  const failed = await dispatch(page, 'snapshot');
  expect(failed.error.message).toMatch(/wasm|WebAssembly|fetch|niimath/i);
  expect(failed.report).toBeUndefined();
  await expect(page.locator('#saveBtn')).toBeDisabled();
  await page.context().unroute('**/niimath-*.wasm');
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate' } });
  await finish(page, 120000);
  expectMaskedCopy(await download(page), readVolume(source(await readFile(fixture))));
});

// The page is cross-origin isolated and the runner's WebGPU and WebGL2 are SwiftShader, so the
// shared MindGrab runtime picks its threaded CPU module, the backend the command line runs.
test('MindGrab with an 8 mm border zeroes the face and keeps the brain unchanged', async ({ page }) => {
  test.setTimeout(660000);
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'mindgrab8' } });
  await finish(page, 600000);
  expectMaskedCopy(await download(page), readVolume(source(await readFile(fixture))));
  expect((await dispatch(page, 'snapshot')).report.provenance).toMatchObject({ method: 'mindgrab8', engine: 'mindgrab-niimath' });
});

test('an unsupported WebGPU adapter fails the operation with the app initialization error', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface' });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.message).toContain('initialize WebGPU');
  expect(snapshot.report).toBeUndefined();
  expect(await dispatch(page, 'viewers.list')).toEqual([]);
  await expect(page.locator('#applyBtn')).toBeDisabled();
  await expect(page.locator('#saveBtn')).toBeDisabled();
});

test('a teardown failure reaches the status bar instead of an unhandled rejection', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('./');
  // Initialization has settled, so no later status update can replace the failure.
  await expect(page.locator('#statusMsg')).toHaveText(/Drag and drop files|WebGPU/);
  await page.evaluate(() => {
    const selector = document.querySelector('#exampleControl nd-example-selector');
    selector.destroy = () => { throw new Error('teardown canary'); };
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
  await expect(page.locator('#statusMsg')).toHaveText('Failed: teardown canary');
  await expect(page.locator('#consoleOutput')).toContainText('Failed: teardown canary');
  // Teardown continued past the failing first step: the workspace listeners are gone.
  const dragAccepted = await page.evaluate(() => !document.dispatchEvent(new DragEvent('dragover', { cancelable: true })));
  expect(dragAccepted).toBe(false);
  expect(pageErrors).toEqual([]);
});
