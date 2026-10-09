import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

// The SCT course MS image (axial T2w). It has no licence file upstream, so it
// is fetched from its pinned tag and is not offered as an in-app example.
const inputUrl = 'https://raw.githubusercontent.com/spinalcordtoolbox/sct_tutorial_data/SCT-Course-20251208/single_subject/data/t2_ms/t2.nii.gz';
const inputSha256 = '5b25b71646e363cf0c24415db0eb0d836f0deb4ae0b024d1b939d505ab63783b';
const modelBytes = 409486303;
const localModel = join(import.meta.dirname, '../web/models/sct-lesion-ms.onnx');

// The run downloads a 409 MB model and takes about three minutes on an
// M-series Mac, so it runs on request rather than in the routine browser suite.
test.skip(!process.env.SCT_E2E_LESION_MS, 'set SCT_E2E_LESION_MS=1 to run the real lesion_ms browser workflow');

let modelServer = null;
test.afterEach(() => {
  modelServer?.close();
  modelServer = null;
});

test('lesion_ms segments MS lesions in the browser and reports lesion-only metrics', async ({ page }) => {
  test.setTimeout(2700000);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-sct-lesion-ms');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 't2_ms.nii.gz');
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== inputSha256) {
    const response = await fetch(inputUrl);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(inputSha256);
    await writeFile(path, bytes);
  }

  // A converted model in the ignored local cache (web/models/*.onnx) stands in
  // for the hosted file, so the workflow can be checked before or without a
  // 409 MB download. It is streamed from a loopback server because
  // route.fulfill cannot carry a body this large.
  const cached = await stat(localModel).catch(() => null);
  if (cached?.size === modelBytes) {
    const server = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': modelBytes,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin'
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(localModel).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    modelServer = server;
    await page.route('https://huggingface.co/**/web/models/sct-lesion-ms.onnx', route => route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${server.address().port}/sct-lesion-ms.onnx`,
        'access-control-allow-origin': '*'
      }
    }));
  }

  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters: { task: 'lesion_ms' } }));
  await expect.poll(
    () => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state),
    { timeout: 2600000, intervals: [5000] }
  ).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.provenance.task).toBe('lesion_ms');
  expect(snapshot.report.provenance.sourceVersion).toBe('r20250909');

  const { measurements, artifacts } = snapshot.report;
  expect(measurements.segmentation).toBeUndefined();
  const lesion = measurements.lesion.labels.find(label => label.id === 1);
  // SCT 7.3 `lesion_ms -single-fold` finds 190 lesion voxels (5 lesions, 674 mm3) here.
  expect(lesion.voxels).toBeGreaterThan(120);
  expect(lesion.voxels).toBeLessThan(260);
  expect(measurements.lesion_metrics.summary.lesion_count).toBeGreaterThanOrEqual(4);
  expect(measurements.lesion_metrics.summary.lesion_count).toBeLessThanOrEqual(6);
  expect(measurements.lesion_metrics.rows.every(row => row.max_axial_damage_ratio === null)).toBe(true);

  const [id, artifact] = Object.entries(artifacts).find(([, value]) => value.role === 'segmentation');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const output = await readFile(await (await waiting).path());
  expect(output.length).toBe(artifact.bytes);
  await writeFile(join(directory, 'browser_lesion_seg.nii.gz'), output);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));
});
