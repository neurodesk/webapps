import { Buffer } from 'node:buffer';
import { isUrlWithinServiceWorkerScope } from '../scripts/lib/runtime-support.mjs';

const MODEL_SHA256 = '6380bd2487eeb47bdc59d63eef69fb0241bd11976712677ccee329f83552a1e6';
const INPUT_DIMS = [32, 32, 1];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function createSyntheticMuscleMapNifti() {
  const [nx, ny, nz] = INPUT_DIMS;
  const headerSize = 352;
  const buffer = Buffer.alloc(headerSize + nx * ny * nz * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((value, index) => {
    view.setInt16(40 + index * 2, value, true);
  });
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  [1, 1, 1, 1, 1, 1, 1, 1].forEach((value, index) => {
    view.setFloat32(76 + index * 4, value, true);
  });
  view.setFloat32(108, headerSize, true);
  view.setFloat32(112, 1, true);
  view.setUint8(123, 10);
  view.setInt16(254, 1, true);
  view.setFloat32(280, 1, true);
  view.setFloat32(300, 1, true);
  view.setFloat32(320, 1, true);
  buffer.write('n+1\0', 344, 'binary');

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const value = 50 + 900 * Math.exp(-(dx * dx + dy * dy) / 120) + x * 2 + y;
      view.setFloat32(headerSize + (x + y * nx) * 4, value, true);
    }
  }

  return buffer;
}

export async function verifyMuscleMapFullPipeline(page, appUrl, { timeout = 180_000 } = {}) {
  const normalizedAppUrl = new URL('./', appUrl).href;
  const serviceWorkerUrl = new URL('coi-serviceworker.js', normalizedAppUrl).href;
  const runtimeRequests = [];
  const failedRuntimeRequests = [];
  const isOrtRuntime = (url) => /\/wasm\/ort|\/_runtime\/ort-web\//.test(new URL(url).pathname);
  const onRequest = (request) => {
    if (isOrtRuntime(request.url())) runtimeRequests.push(request.url());
  };
  const onRequestFailed = (request) => {
    if (isOrtRuntime(request.url())) {
      failedRuntimeRequests.push(`${request.failure()?.errorText ?? 'request failed'} ${request.url()}`);
    }
  };
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);

  try {
    if (!page.url().startsWith(normalizedAppUrl)) {
      const response = await page.goto(normalizedAppUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      requireCondition(response?.ok(), `MuscleMap returned ${response?.status() ?? 'no response'}`);
    }
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.app), null, { timeout: 30_000 });

    if (await page.locator('#enterAppButton').isVisible()) {
      await page.locator('#enterAppButton').click();
    }
    const settings = page.locator('[data-disclosure]').filter({ has: page.locator('#modelSelect') });
    if (await settings.locator('[data-disclosure-toggle]').getAttribute('aria-expanded') === 'false') {
      await settings.locator('[data-disclosure-toggle]').click();
    }
    await page.locator('#modelSelect').selectOption('musclemap-wholebody-v1.4');
    await page.locator('#overlapSelect').selectOption('0');
    await page.locator('#chunkSizeSelect').selectOption('1');
    await page.locator('#sourceChunkSizeSelect').selectOption('5');
    await page.locator('#webgpuToggle').evaluate((toggle) => { toggle.checked = false; });
    await page.locator('#fileInput').setInputFiles({
      name: 'release-smoke-mri.nii',
      mimeType: 'application/octet-stream',
      buffer: createSyntheticMuscleMapNifti(),
    });
    await page.waitForFunction(() => !document.querySelector('#runSegmentation')?.disabled, null, { timeout: 30_000 });
    await page.locator('#runSegmentation').click();
    await page.waitForFunction(() => {
      const output = document.querySelector('#consoleOutput')?.innerText ?? '';
      return output.includes('Generated 1 segmentation.') || output.includes('Error:');
    }, null, { timeout });

    let output = await page.locator('#consoleOutput').innerText();
    requireCondition(output.includes('Generated 1 segmentation.'), `segmentation failed:\n${output}`);
    await page.waitForFunction(() => !document.querySelector('#calculateMetrics')?.disabled, null, { timeout: 30_000 });
    await page.locator('#calculateMetrics').click();
    try {
      await page.waitForFunction(() => {
        const text = document.querySelector('#consoleOutput')?.innerText ?? '';
        return text.includes('Metrics ready.') || text.includes('Error:');
      }, null, { timeout: 60_000 });
    } catch (error) {
      const consoleOutput = await page.locator('#consoleOutput').innerText();
      throw new Error(`metrics did not finish: ${error.message}\n${consoleOutput}`);
    }

    const state = await page.evaluate(async () => {
      const segmentation = window.app.segmentationResults[0];
      const bytes = segmentation ? await segmentation.file.arrayBuffer() : null;
      const view = bytes ? new DataView(bytes) : null;
      return {
        appVersion: document.querySelector('#appVersion')?.textContent,
        browserThreads: navigator.hardwareConcurrency,
        modelOption: document.querySelector('#modelSelect')?.selectedOptions[0]?.textContent,
        segmentationBytes: bytes?.byteLength ?? 0,
        segmentationDims: view ? [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)] : null,
        provenance: segmentation?.provenance ?? null,
        metrics: window.app._pendingMetrics ?? null,
        metricsVisible: !document.querySelector('#metricsSummary')?.classList.contains('hidden'),
        output: document.querySelector('#consoleOutput')?.innerText ?? '',
      };
    });
    output = state.output;
    const threadMatch = output.match(/(?:Using WASM backend \(.*?, |Forcing WASM backend with )(\d+) threads/);
    const requestedThreads = Number(threadMatch?.[1]);

    requireCondition(output.includes('Downloaded and verified: musclemap-wholebody.onnx'), 'model verification did not run');
    requireCondition(output.includes('Session created. Input: input, Output: output'), 'real model session was not created');
    requireCondition(output.includes('Inference complete: 1 working slices'), 'real model inference did not finish');
    requireCondition(output.includes('Keeping the largest 6-connected component'), 'connected-component cleanup did not run');
    requireCondition(output.includes('Metrics ready.'), `metrics failed:\n${output}`);
    requireCondition(requestedThreads >= 2, `release smoke used ${requestedThreads || 0} WASM threads`);
    requireCondition(requestedThreads === state.browserThreads, `ORT requested ${requestedThreads} of ${state.browserThreads} browser threads`);
    requireCondition(state.modelOption?.includes('113 structures, v1.4'), `wrong model selected: ${state.modelOption}`);
    requireCondition(state.segmentationBytes > 352, `segmentation contains ${state.segmentationBytes} bytes`);
    requireCondition(JSON.stringify(state.segmentationDims) === JSON.stringify(INPUT_DIMS), `segmentation dimensions are ${state.segmentationDims}`);
    requireCondition(state.provenance?.assetSha256 === MODEL_SHA256, 'segmentation provenance has the wrong model digest');
    requireCondition(state.provenance?.labelSpaceId === 'musclemap-wholebody-v1.4', 'segmentation provenance has the wrong label space');
    requireCondition(state.metrics?.totalVolumeMl > 0, `metrics total is ${state.metrics?.totalVolumeMl ?? 'missing'}`);
    requireCondition(state.metricsVisible, 'metrics summary is hidden');
    requireCondition(failedRuntimeRequests.length === 0, `ORT requests failed:\n${failedRuntimeRequests.join('\n')}`);
    requireCondition(runtimeRequests.some((url) => /ort-wasm-simd-threaded.*\.mjs/.test(url)), 'PThread worker entry was not requested');

    const escapedRuntimeRequests = runtimeRequests.filter(
      (url) => !isUrlWithinServiceWorkerScope(serviceWorkerUrl, url),
    );
    requireCondition(
      escapedRuntimeRequests.length === 0,
      `ORT escaped the MuscleMap service-worker scope:\n${escapedRuntimeRequests.join('\n')}`,
    );

    return {
      appVersion: state.appVersion,
      requestedThreads,
      segmentationBytes: state.segmentationBytes,
      totalVolumeMl: state.metrics.totalVolumeMl,
      runtimeRequests: [...new Set(runtimeRequests)],
    };
  } finally {
    page.off('request', onRequest);
    page.off('requestfailed', onRequestFailed);
  }
}
