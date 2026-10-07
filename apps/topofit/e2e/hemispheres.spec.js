import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const PREFERENCE = 'topofit.parallelHemispheres';
const MARKER = 'topofit.parallelRuns';
const fixture = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
const scan = { name: 'brain.nii.gz', mimeType: 'application/gzip', buffer: fixture };

// Replaces the inference worker. Every posted job is recorded with the crash marker's
// value at that moment; the first job fails inside a hemisphere worker when asked to.
async function stubInference(page, { deviceMemory = 8, failFirst = false } = {}) {
  await page.addInitScript(({ deviceMemory, failFirst, MARKER }) => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => deviceMemory, configurable: true });
    window.topofitJobs = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        window.topofitJobs.push({ hemispheres: job.hemispheres, marker: localStorage.getItem(MARKER) });
        if (failFirst && window.topofitJobs.length === 1) {
          this.onmessage({ data: { type: 'error', message: 'Hemisphere lh worker failed: Out of memory', hemisphereFailure: true } });
          return;
        }
        this.onmessage({ data: { type: 'result', files: [], surfaces: null, provenance: { surfaceVertices: 4, surfaceAnalysis: null }, elapsedSeconds: 1 } });
      }
    };
  }, { deviceMemory, failFirst, MARKER });
}

async function reconstruct(page) {
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Surfaces ready');
}

const jobs = (page) => page.evaluate(() => window.topofitJobs);
const storedValue = (page, key) => page.evaluate((key) => localStorage.getItem(key), key);

test('the option defaults on with enough memory, is posted with the job and the choice survives reload', async ({ page }) => {
  await stubInference(page);
  await page.goto('/');
  const option = page.locator('#parallelHemispheres');
  await expect(option).toBeChecked();
  await expect(page.locator('label:has(#parallelHemispheres)')).toContainText('Reconstruct hemispheres in parallel');
  await page.locator('#imageInput').setInputFiles(scan);
  await expect(page.locator('#runButton')).toBeEnabled();
  await reconstruct(page);
  const [first] = await jobs(page);
  expect(first.hemispheres).toBe('parallel');
  expect(Object.keys(JSON.parse(first.marker))).toHaveLength(1);
  expect(await storedValue(page, MARKER)).toBeNull();

  await page.locator('#advancedSettings > summary').click();
  await option.uncheck();
  await reconstruct(page);
  expect((await jobs(page))[1]).toEqual({ hemispheres: 'sequential', marker: null });
  expect(await storedValue(page, PREFERENCE)).toBe('false');

  await page.reload();
  await expect(page.locator('#parallelHemispheres')).not.toBeChecked();
});

test('the option defaults off below 8 GB unless the user chose otherwise', async ({ page }) => {
  await stubInference(page, { deviceMemory: 4 });
  await page.goto('/');
  await expect(page.locator('#parallelHemispheres')).not.toBeChecked();
  await page.evaluate((key) => localStorage.setItem(key, 'true'), PREFERENCE);
  await page.reload();
  await expect(page.locator('#parallelHemispheres')).toBeChecked();
});

test('a hemisphere failure in a parallel run retries sequentially once without changing the preference', async ({ page }) => {
  await stubInference(page, { failFirst: true });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scan);
  await expect(page.locator('#runButton')).toBeEnabled();
  await reconstruct(page);
  expect((await jobs(page)).map((job) => job.hemispheres)).toEqual(['parallel', 'sequential']);
  const messages = page.locator('#technicalLog .nd-console-message');
  await expect(messages.filter({ hasText: 'Hemisphere lh worker failed: Out of memory' })).toHaveCount(1);
  await expect(messages.filter({ hasText: 'Parallel reconstruction failed; retrying one hemisphere at a time' })).toHaveCount(1);
  await expect(page.locator('#parallelHemispheres')).toBeChecked();
  expect(await storedValue(page, PREFERENCE)).toBeNull();
  expect(await storedValue(page, MARKER)).toBeNull();
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('a run marker left by a crashed tab switches to one hemisphere at a time and says so', async ({ page }) => {
  await stubInference(page);
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ crashed: 1759780000000 })), MARKER);
  await page.goto('/');
  await expect(page.locator('#parallelHemispheres')).not.toBeChecked();
  await expect(page.locator('#statusText')).toHaveText('The last parallel reconstruction did not finish; hemispheres now run one at a time (Advanced settings).');
  expect(await storedValue(page, MARKER)).toBeNull();
  expect(await storedValue(page, PREFERENCE)).toBe('false');
});

test('automation passes parallelHemispheres through to the job', async ({ page }) => {
  await stubInference(page);
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles(scan);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'reconstruct', parameters: { parallelHemispheres: false } }));
  // The stub returns no files, so the contract's artifact count check fails the run after
  // the worker has been driven; the job it posted is what this test is about.
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).not.toBe('running');
  expect((await jobs(page)).map((job) => job.hemispheres)).toEqual(['sequential']);
});

test('a parallel run still going in another tab is not mistaken for a crash', async ({ page, context }) => {
  await stubInference(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate((key) => {
    navigator.locks.request('topofit-parallel-run-elsewhere', () => new Promise(() => {}));
    localStorage.setItem(key, JSON.stringify({ elsewhere: Date.now() }));
  }, MARKER);
  await expect.poll(() => other.evaluate(async () => (await navigator.locks.query()).held.map((lock) => lock.name))).toContain('topofit-parallel-run-elsewhere');
  await page.goto('/');
  await expect(page.locator('#parallelHemispheres')).toBeChecked();
  await expect(page.locator('#statusText')).not.toContainText('did not finish');
  expect(JSON.parse(await storedValue(page, MARKER))).toHaveProperty('elsewhere');
  await other.close();
  await page.reload();
  await expect(page.locator('#parallelHemispheres')).not.toBeChecked();
  await expect(page.locator('#statusText')).toContainText('did not finish');
});
