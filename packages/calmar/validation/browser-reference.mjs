import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAsset } from '../src/node.js';
import offlineAssets from '../../../registry/offline-assets.lock.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { serveSite } from '../../../test-utils/serve-site.mjs';
import assets from '../assets.lock.json' with { type: 'json' };

const output = process.argv[2];
if (!output) throw new Error('Usage: browser-reference.mjs OUTPUT_DIRECTORY');
const cacheDir = process.env.NEURODESK_CALMAR_MODEL_DIR;
if (!cacheDir) throw new Error('Set NEURODESK_CALMAR_MODEL_DIR to verified local assets.');
const examples = JSON.parse(
  await readFile(new URL('../../../apps/calmar/examples.json', import.meta.url))
);
const file = examples[0].files[0];
const input = process.env.CALMAR_REFERENCE_INPUT;
if (!input) throw new Error('Set CALMAR_REFERENCE_INPUT to the pinned structural example.');
const inputBytes = await readFile(input);
const digest = createHash('sha256').update(inputBytes).digest('hex');
if (digest !== '725a37bf9556c6776a7be552597999df67d175a44eafc03252db058e8f5c5cad')
  throw new Error('Reference input differs from the pinned example.');
const viewerUrl = 'https://unpkg.com/@niivue/niivue@0.68.2/dist/niivue.umd.js';
const viewer = await loadAsset({ ...offlineAssets.assets[viewerUrl], url: viewerUrl, filename: 'niivue-0.68.2.js' }, { cacheDir: join(tmpdir(), 'calmar-browser-runtime'), offline: false });
const site = await serveSite(resolve('apps/calmar/dist'));
const browser = await chromium.launch({
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.on('pageerror', error => console.log(error.message));
  await page.route(viewerUrl, route => route.fulfill({ body: viewer, contentType: 'application/javascript' }));
  page.on('console', (message) => console.log(message.text()));
  for (const asset of assets) {
    await page.route(asset.url, async (route) =>
      route.fulfill({
        body: await readFile(join(cacheDir, asset.filename)),
        headers: {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        },
      })
    );
  }
  await page.goto(site.origin + '/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page
    .locator('#neurodesk-input-transfer')
    .setInputFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: inputBytes });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'structural' }));
  await page.evaluate(() =>
    neurodeskAutomation.dispatch('start', { operation: 'prepare-lesion', parameters: {} })
  );
  let snapshot;
  const deadline = Date.now() + 900000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  } while (!['succeeded', 'failed'].includes(snapshot.state) && Date.now() < deadline);
  if (snapshot.state !== 'succeeded' || !snapshot.report.summary.requiresReview)
    throw new Error(JSON.stringify(snapshot));
  const [artifactId] = Object.entries(snapshot.report.artifacts).find(
    ([, artifact]) => artifact.role === 'candidate'
  );
  const waiting = page.waitForEvent('download');
  await page.evaluate(
    (artifactId) => neurodeskAutomation.dispatch('download', { artifactId }),
    artifactId
  );
  const bytes = await readFile(await (await waiting).path());
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'candidate-lesion.nii'), bytes);
  if (process.env.CALMAR_REVIEWED_INPUT) {
    const reviewed = await readFile(process.env.CALMAR_REVIEWED_INPUT);
    await page.route('**/__reviewed-mask.nii', (route) => route.fulfill({ body: reviewed }));
    await page.evaluate(async () => {
      const reviewed = new File(
        [await (await fetch('/__reviewed-mask.nii')).arrayBuffer()],
        'reviewed-native.nii'
      );
      await app.startUploadedLesionMaskReview(reviewed);
      await app.confirmLesionDrawing();
      app.handleAtlasSelectionChange('yeo7');
      await app.runRegistration();
      await app.applyRegistrationToLesion();
      await app.runAtlasOverlap();
      await app.runFcNetworkMap();
      app.applyNetworkThreshold();
    });
    for (const [property, filename] of [
      ['lesionFile', 'reviewed-lesion-atlas.nii'],
      ['networkMapFile', 'lnm-network-map.nii'],
      ['thresholdedMaskFile', 'lnm-network-map-thresh.nii'],
    ]) {
      const downloaded = page.waitForEvent('download');
      await page.evaluate((property) => {
        const file = app[property];
        if (!file) throw new Error(`Browser output missing ${property}`);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        link.click();
      }, property);
      await writeFile(join(output, filename), await readFile(await (await downloaded).path()));
    }
  }
  await writeFile(
    join(output, 'browser-reference.json'),
    JSON.stringify(
      {
        inputSha256: digest,
        artifactSha256: createHash('sha256').update(bytes).digest('hex'),
        browser: await browser.version(),
        report: snapshot.report,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await browser.close();
  await site.close();
}
