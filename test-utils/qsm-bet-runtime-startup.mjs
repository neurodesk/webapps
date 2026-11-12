import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressIfNeeded } from './nifti-fixture.mjs';
import { serveSite } from './serve-site.mjs';

// This is the existing scientific regression pin, also used by both app and package BET tests.
const maskSha256 = '20112e75bdaab6c8f3d9d47469b6814554f167996f4cff61e004f00207b233ad';

export async function verifyQsmBetRuntime({ browser, repoRoot }) {
  const site = await serveSite(join(repoRoot, 'dist'), { isolationHeaders: false });
  try {
    const bytes = decompressIfNeeded(await readFile(join(repoRoot, 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz')));
    const assets = join(repoRoot, 'dist/brain-extraction/assets');
    const workers = [];
    for (const name of await readdir(assets)) {
      if (!name.endsWith('.js')) continue;
      if ((await readFile(join(assets, name), 'utf8')).includes('bet/bet.wasm')) workers.push(name);
    }
    assert.equal(workers.length, 1, 'one production brain-extraction worker must load compact BET');
    for (const app of ['qsmbly', 'brain-extraction']) {
      const context = await browser.newContext();
      try {
        const requests = [];
        context.on('response', response => requests.push({ url: response.url(), status: response.status() }));
        const page = await context.newPage();
        const appUrl = `${site.origin}/${app}/`;
        const response = await context.request.get(appUrl);
        assert.equal(response.headers()['cross-origin-embedder-policy'], undefined);
        assert.equal(response.headers()['cross-origin-opener-policy'], undefined);
        await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
        const workerUrl = app === 'qsmbly'
          ? `${appUrl}js/qsm-worker-pure.js`
          : `${appUrl}assets/${workers[0]}`;
        const result = await page.evaluate(async ({ app, appUrl, workerUrl, nifti }) => {
          const input = Uint8Array.from(atob(nifti), value => value.charCodeAt(0));
          const worker = new Worker(workerUrl, { type: 'module' });
          const logs = [];
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`${app} production BET worker timed out`)), 60000);
              const fail = error => { clearTimeout(timer); reject(error); };
              worker.onerror = event => fail(new Error(event.message));
              worker.onmessage = async ({ data }) => {
                try {
                  if (data.type === 'log') logs.push(data.message);
                  if (data.type === 'error' || data.type === 'betError') return fail(new Error(data.message));
                  if (data.type === 'initialized') {
                    worker.postMessage({ type: 'runBET', data: { magnitudeBuffer: input.buffer, fractionalIntensity: 0.5 } }, [input.buffer]);
                  }
                  if (data.type !== 'betComplete' && data.type !== 'result') return;
                  let mask;
                  if (app === 'qsmbly') mask = Uint8Array.from(data.maskData);
                  else {
                    const { readNifti } = await import(new URL('../_runtime/webapp-components/0.1.2/src/file-io/NiftiUtils.js', appUrl).href);
                    mask = (await readNifti(data.mask, Uint8Array)).data;
                  }
                  const digest = await crypto.subtle.digest('SHA-256', mask);
                  clearTimeout(timer);
                  resolve({
                    sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
                    voxels: mask.reduce((sum, value) => sum + value, 0),
                    logs,
                  });
                } catch (error) { fail(error); }
              };
              if (app === 'qsmbly') worker.postMessage({ type: 'init' });
              else worker.postMessage({ method: 'bet', assetBase: appUrl, fractionalIntensity: 0.5, file: new File([input], 'T1.nii') });
            });
          } finally { worker.terminate(); }
        }, { app, appUrl, workerUrl, nifti: bytes.toString('base64') });
        assert.equal(result.sha256, maskSha256, `${app}: unchanged BET regression mask`);
        assert.equal(result.voxels, 240631, app);
        if (app === 'qsmbly') {
          assert.ok(result.logs.some(line => /Threadpool ready: \d+ threads \[base\]/.test(line)), 'QSM worker must initialize its actual Rayon pool');
          assert.ok(requests.some(({ url, status }) => url.includes('/qsmbly/wasm/snippets/rayon-base/') && status === 200), 'QSM Rayon helper must remain in app scope');
        } else {
          assert.ok(requests.some(({ url, status }) => url.endsWith('/brain-extraction/bet/bet.wasm') && status === 200), 'production worker must fetch compact BET');
          assert.ok(!requests.some(({ url }) => url.includes('qsm_wasm')), 'BET must not load the full QSM runtime');
        }
        console.log(`PASS ${app}: actual production worker, header-free service-worker isolation, unchanged BET mask`);
      } finally { await context.close(); }
    }
  } finally { await site.close(); }
}
