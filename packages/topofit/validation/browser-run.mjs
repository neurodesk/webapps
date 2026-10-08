import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const [url, input, outputDirectory, ...options] = process.argv.slice(2);
if (!outputDirectory) {
  throw new Error('Usage: browser-run.mjs URL input.nii.gz output-directory [--no-conform] [--sequential]');
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
// A fresh browser has an empty model cache, so this counts cold downloads per model.
const modelRequests = {};
page.on('request', (request) => {
  const name = request.url().split('?')[0].split('/').pop();
  if (name.endsWith('.onnx')) modelRequests[name] = (modelRequests[name] || 0) + 1;
});
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes('inference-worker')) {
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'result') window.topofitValidationResult = data;
          if (data.type === 'error') window.topofitValidationError = data.message;
        });
      }
    }
  };
});

try {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.locator('#imageInput').setInputFiles(input);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#advancedSettings > summary').click();
  if (options.includes('--no-conform')) await page.locator('#conform').uncheck();
  if (options.includes('--sequential')) await page.locator('#parallelHemispheres').uncheck();
  await page.locator('#thickness').selectOption('0');
  await page.screenshot({ path: `${outputDirectory}/desktop-input.png`, fullPage: true });

  const started = Date.now();
  await page.locator('#runButton').click();
  let previousStatus = '';
  for (;;) {
    const currentStatus = await page.locator('#statusText').textContent();
    if (currentStatus !== previousStatus) {
      console.log(currentStatus);
      previousStatus = currentStatus;
    }
    const result = await page.evaluate(() => ({ ready: Boolean(window.topofitValidationResult), error: window.topofitValidationError }));
    if (result.error) throw new Error(result.error);
    if (result.ready && currentStatus?.includes('Surfaces ready')) break;
    if (await page.locator('#cancelButton').isHidden()) {
      throw new Error(`Processing stopped: ${currentStatus}`);
    }
    if (Date.now() - started > 30 * 60 * 1000) {
      throw new Error('Full TopoFit reconstruction exceeded 30 minutes.');
    }
    await page.waitForTimeout(1000);
  }

  await expect(page.locator('#outputSection')).toHaveAttribute('open', '');
  await expect(page.locator('#viewerError')).toBeHidden();
  await page.screenshot({ path: `${outputDirectory}/desktop-result.png`, fullPage: true });
  const names = await page.evaluate(() => window.topofitValidationResult.files.map(file => file.name));
  for (const name of names) {
    const encoded = await page.evaluate(name => {
      const file = window.topofitValidationResult.files.find(file => file.name === name);
      const bytes = new Uint8Array(file.bytes);
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return btoa(text);
    }, name);
    await writeFile(`${outputDirectory}/${name}`, Buffer.from(encoded, 'base64'));
  }
  await writeFile(
    `${outputDirectory}/browser-run.json`,
    `${JSON.stringify({
      seconds: (Date.now() - started) / 1000,
      browser: browser.version(),
      crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
      pageErrors,
      finalStatus: previousStatus,
      hemispheres: options.includes('--sequential') ? 'sequential' : 'parallel',
      modelRequests,
      timings: await page.evaluate(() => window.topofitValidationResult.timings),
    }, null, 2)}\n`,
  );
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log(`Browser result saved to ${outputDirectory}`);
} finally {
  await browser.close();
}
