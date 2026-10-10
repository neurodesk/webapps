import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MODEL_ASSETS, downloadModels } from '../src/node.js';
import { pinnedExample } from './example.mjs';

export const CASES = Object.freeze([
  {
    id: 'manual',
    parameters: { model: 'manual', downsample: 1, biasCorrection: false, denoise: 'none' },
  },
  {
    id: 'synthstrip-fast',
    parameters: {
      model: 'manual',
      downsample: 2,
      biasCorrection: false,
      denoise: 'none',
      brainExtraction: 'synthstrip-fast',
    },
  },
  {
    id: 'preprocessing',
    parameters: {
      model: 'manual',
      downsample: 2,
      biasCorrection: true,
      denoise: 'bilateral',
      brainExtraction: 'bet',
    },
  },
]);
export async function browserReference({
  output,
  cacheDir,
  dist = resolve('apps/vesselboost/dist'),
  appPath = '/',
}) {
  assert.ok(cacheDir, 'Provide a verified model cache');
  await downloadModels({ cacheDir, offline: true });
  const example = await pinnedExample();
  const files = new Map(
    MODEL_ASSETS.map((asset) => [`/__models/${asset.filename}`, join(cacheDir, asset.filename)])
  );
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('..')) {
        response.writeHead(400).end();
        return;
      }
      let path = files.get(pathname) || join(dist, pathname);
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      const size = (await stat(path)).size;
      const types = {
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.html': 'text/html',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.css': 'text/css',
      };
      response.writeHead(200, {
        'content-type': types[extname(path)] || 'application/octet-stream',
        'content-length': size,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
        'access-control-allow-origin': '*',
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browserHome = await mkdtemp(join(tmpdir(), 'vesselboost-browser-home-'));
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.PW_EXECUTABLE_PATH && { executablePath: process.env.PW_EXECUTABLE_PATH }),
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
      env: {
        ...process.env,
        HOME: browserHome,
        USERPROFILE: browserHome,
        APPDATA: browserHome,
        LOCALAPPDATA: browserHome,
        XDG_CONFIG_HOME: browserHome,
        XDG_CACHE_HOME: browserHome,
        XDG_DATA_HOME: browserHome,
      },
    });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => console.log(message.text()));
    // Cap only inference concurrency, preserving the production runtime and workload.
    await page.route('**/js/inference-worker.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `Object.defineProperty(navigator, 'hardwareConcurrency', { value: 4 });\n${await response.text()}`,
      });
    });
    for (const asset of MODEL_ASSETS)
      await page.route(asset.url, (route) =>
        route.fulfill({
          status: 302,
          headers: {
            location: `${origin}/__models/${asset.filename}`,
            'access-control-allow-origin': '*',
          },
        })
      );
    await page.goto(origin + appPath, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    await mkdir(output, { recursive: true });
    const receipts = [];
    for (const scenario of CASES) {
      await page
        .locator('#neurodesk-input-transfer')
        .setInputFiles({
          name: 'lausanne-tof-crop-192x192x64.nii',
          mimeType: 'application/x-nifti',
          buffer: example.bytes,
        });
      await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
      await page.evaluate(
        (parameters) => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }),
        scenario.parameters
      );
      const deadline = Date.now() + 600000;
      let snapshot;
      do {
        await page.waitForTimeout(500);
        snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
      } while (!['succeeded', 'failed'].includes(snapshot.state) && Date.now() < deadline);
      assert.equal(snapshot.state, 'succeeded', JSON.stringify(snapshot));
      assert.equal(snapshot.report.provenance.executionProvider, 'wasm');
      const directory = join(output, scenario.id);
      await mkdir(directory);
      for (const [id, artifact] of Object.entries(snapshot.report.artifacts)) {
        const download = page.waitForEvent('download');
        await page.evaluate(
          (artifactId) => neurodeskAutomation.dispatch('download', { artifactId }),
          id
        );
        const result = await download;
        const bytes = await readFile(await result.path());
        assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
        await writeFile(join(directory, result.suggestedFilename()), bytes);
      }
      await page.screenshot({ path: join(output, `${scenario.id}-desktop.png`) });
      receipts.push({
        scenario: scenario.id,
        parameters: scenario.parameters,
        report: snapshot.report,
      });
    }
    assert.deepEqual(errors, []);
    const receipt = {
      browser: browser.version(),
      runtime: 'ONNX Runtime Web 1.21.0',
      backend: 'wasm',
      threads: 4,
      productionDist: dist,
      appPath,
      errors,
      runs: receipts,
    };
    await writeFile(
      join(output, 'browser-reference.json'),
      JSON.stringify(receipt, null, 2) + '\n'
    );
    return receipt;
  } finally {
    await browser?.close();
    await rm(browserHome, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const output = process.argv[2] || join(tmpdir(), 'vesselboost-browser-reference');
  await browserReference({ output, cacheDir: process.env.NEURODESK_VESSELBOOST_MODEL_DIR });
}
