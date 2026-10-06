// Real inference is opt-in. See packages/desktop/SCIENTIFIC-VALIDATION.md.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { summarizeLabels } from '../../../packages/components/src/automation/label-measurements.js';
import { planGpuGraph } from '../../../packages/runtime-support/src/gpu-unet/session.js';
import { hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';

const freesurferLut = JSON.parse(readFileSync(new URL('../../../packages/components/src/automation/freesurfer-lut.json', import.meta.url), 'utf8'));
const graph = JSON.parse(readFileSync(new URL('../../../packages/synthseg/src/gpu-model.json', import.meta.url), 'utf8'));

const fixtures = '../../exes/synthseg/test/fixtures';
const references = process.env.SYNTHSEG_REFERENCE_DIR;
const probeOnly = Boolean(process.env.SYNTHSEG_PROBE_ONLY);
const reportPath = resolve(process.env.SYNTHSEG_VALIDATION_REPORT || 'validation/report.json');
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  scope: probeOnly ? 'adapter and planned buffer limits only; no inference' : references ? 'small fixtures and full-volume WebGPU parity' : 'small fixtures only',
  requireHardware: hardwareGpu,
  results: [],
};
const save = () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
};

test.skip(!process.env.SYNTHSEG_E2E_FIXTURE && !probeOnly, 'set SYNTHSEG_E2E_FIXTURE=1 to run the real model in the browser');

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    evidence.failure = { test: info.title, message: info.error?.message || info.status };
  }
  save();
});

async function adapterEvidence(page) {
  const adapter = await page.evaluate(async () => {
    const device = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!device) throw new Error('WebGPU adapter unavailable');
    return {
      userAgent: navigator.userAgent,
      info: {
        vendor: device.info?.vendor,
        architecture: device.info?.architecture,
        device: device.info?.device,
        description: device.info?.description,
      },
      isFallbackAdapter: device.isFallbackAdapter ?? device.info?.isFallbackAdapter ?? null,
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      features: [...device.features].sort(),
    };
  });
  evidence.adapter = adapter;
  evidence.bufferProbe = [[192, 224, 160], [192, 256, 256]].map(dimensions => {
    const plan = planGpuGraph(dimensions, graph, { outputChannels: 33, label: 'SynthSeg' });
    const largestBufferBytes = Math.max(...plan.slots.map(slot => slot.bytes));
    return {
      dimensions,
      largestBufferBytes,
      validatedLimitBytes: 2 ** 31 - 1,
      adapterLimitBytes: Math.min(adapter.maxBufferSize, adapter.maxStorageBufferBindingSize),
      fitsValidatedLimit: largestBufferBytes <= 2 ** 31 - 1,
      fitsAdapterLimit: largestBufferBytes <= Math.min(adapter.maxBufferSize, adapter.maxStorageBufferBindingSize),
      allocated: false,
    };
  });
  save();
  if (hardwareGpu) {
    expect(adapter.isFallbackAdapter, 'Hardware validation cannot use a fallback adapter').not.toBe(true);
    expect(JSON.stringify(adapter.info)).not.toMatch(/swiftshader|llvmpipe|lavapipe/i);
  }
}

async function checkCase(page, { input, reference, mode, limit }) {
  const result = { device: 'webgpu', input, mode, pass: false, limit };
  evidence.results.push(result);
  save();
  await page.goto('./');
  await adapterEvidence(page);
  await page.locator('#imageInput').setInputFiles(input);
  await expect(page.locator('#processButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#mode').selectOption(mode);
  await page.locator('#processButton').click();
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', /succeeded|failed/, { timeout: 1700000 });
  // The state flips when the run succeeds; the text follows once the viewer has the labels.
  await expect(page.locator('#statusText')).toContainText('Labels ready', { timeout: 120000 });
  const download = await Promise.all([page.waitForEvent('download'), page.locator('#saveBtn').click()]).then(([value]) => value);
  const reportDownload = await Promise.all([page.waitForEvent('download'), page.locator('#reportBtn').click()]).then(([value]) => value);
  const producedBytes = readFileSync(await download.path());
  const goldenBytes = readFileSync(reference);
  const produced = await readNifti(producedBytes, Float64Array);
  const golden = await readNifti(goldenBytes, Float64Array);
  const report = JSON.parse(readFileSync(await reportDownload.path(), 'utf8'));
  const inputDescriptor = Array.isArray(report.inputs.image) ? report.inputs.image[0] : report.inputs.image;
  const outputDescriptor = report.artifacts.labels || Object.values(report.artifacts).find(value => value.role === 'labels');
  expect(report.status).toBe('succeeded');
  expect(inputDescriptor.sha256).toBe(checksum(readFileSync(input)));
  expect(outputDescriptor.sha256).toBe(checksum(producedBytes));
  expect(report.provenance.gpuImplementation).toBe('synthseg-blocked-fp32-v1');
  expect(report.measurements).toEqual(summarizeLabels(produced, freesurferLut));
  expect(produced.dims).toEqual(golden.dims);
  expect(produced.header.xyztUnits).toBe(golden.header.xyztUnits);
  const affineError = Math.max(...produced.header.affine.flatMap((row, i) => Array.from(row, (value, j) => Math.abs(value - golden.header.affine[i][j]))));
  expect(affineError).toBeLessThanOrEqual(1e-4);
  let mismatches = 0;
  for (let i = 0; i < golden.data.length; i++) if (produced.data[i] !== golden.data[i]) mismatches++;
  Object.assign(result, {
    mismatched_voxels: mismatches,
    compared_voxels: produced.data.length,
    mismatch_fraction: mismatches / produced.data.length,
    max_affine_error_mm: affineError,
    inputSha256: inputDescriptor.sha256,
    goldenSha256: checksum(goldenBytes),
    outputSha256: outputDescriptor.sha256,
    provenance: report.provenance,
    hippocampi: report.measurements.labels.filter(label => [17, 53].includes(label.id)),
  });
  save();
  expect(result.mismatch_fraction).toBeLessThanOrEqual(limit);
  result.pass = true;
  save();
  console.log(`${input} ${mode}: ${mismatches}/${produced.data.length} mismatched, ${report.provenance.seconds.toFixed(1)} s`);
}

test('records the WebGPU adapter and planned buffer limits', async ({ page }) => {
  await page.goto('./');
  await adapterEvidence(page);
  expect(evidence.bufferProbe[1].fitsValidatedLimit).toBe(false);
});

for (const mode of ['fast', 'default']) {
  test(`segments the small fixture in ${mode} mode against the FreeSurfer golden`, async ({ page }) => {
    test.skip(probeOnly, 'adapter probe does not run inference');
    test.setTimeout(1800000);
    await checkCase(page, {
      input: `${fixtures}/small.nii.gz`,
      reference: `${fixtures}/small_${mode}.nii.gz`,
      mode,
      limit: 5e-6,
    });
  });
}

test('segments the benchmark volumes within the native parity gate', async ({ page }) => {
  test.skip(probeOnly, 'adapter probe does not run inference');
  test.skip(!references, 'set SYNTHSEG_REFERENCE_DIR to run the full volumes');
  test.setTimeout(7200000);
  for (const stem of ['T1_head', 'T1_head_2mm']) {
    for (const mode of ['fast', 'default']) {
      await checkCase(page, {
        input: `${references}/${stem}.nii.gz`,
        reference: `${references}/${stem}_${mode}.nii.gz`,
        mode,
        limit: 2e-6,
      });
    }
  }
});
