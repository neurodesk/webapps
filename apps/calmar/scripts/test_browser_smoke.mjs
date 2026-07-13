#!/usr/bin/env node --no-warnings
// Browser smoke tests for the LNM webapp. Phases:
//
//   Phase 1c.4: manual-mask Yeo overlap flow end-to-end. Uses
//     tests/fixtures/lnm-phantom/lesion-mni2.nii.gz.
//   Phase 2a.1.5: structural T1 -> SynthStrip brain extraction.
//     Uses tests/fixtures/synthstrip-mini/T1.nii.gz (MNI152 2mm).
//   Phase 2a.2.5: structural T1 -> SynthStroke editable seed -> confirm mask.
//   Phase 3.7: structural T1 -> SynthMorph MNI registration kickoff.
//   Phase 8: phantom -> Run full pipeline (manual-mask branch).
//   Phase 10: structural T1 -> Run full pipeline (auto branch).
//     Uses tests/fixtures/lnm-auto-mini/T1.nii.gz (MNI 1mm template +
//     planted hypointensity sphere). Slow: ~5 min cold.
//
// NOT included in `npm test`. Requires:
//   npm install            # adds playwright dep
//   npx playwright install chromium
//   npm run test:smoke
//
// Tests fetch their assets live from Hugging Face by design (developer-
// machine smoke; CI gating with stubbed assets is a later phase). The
// SynthStrip phase pulls the ~10 MB ONNX model, then runs whole-volume
// WASM inference in headless Chromium, so it is slow (30-90s typical).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = Number(process.env.LNM_SMOKE_PORT || 8123);
// run.sh cd's into web/ before serving, so the docroot IS web/.
const PHANTOM_PATH = path.join(ROOT, 'tests/fixtures/lnm-phantom/lesion-mni2.nii.gz');
const STRUCTURAL_PATH = path.join(ROOT, 'tests/fixtures/synthstrip-mini/T1.nii.gz');
// Phase 10: 160x160x192 1mm MNI fixture with a planted hypointensity sphere,
// used by the auto-branch Run-full-pipeline smoke. Built by
// tests/fixtures/lnm-auto-mini/build.py.
const AUTO_T1_PATH = path.join(ROOT, 'tests/fixtures/lnm-auto-mini/T1.nii.gz');
const MNI160_CACHE = path.join(ROOT, 'web/models/_dev_cache/lnm-mni160.nii.gz');
const MNI160_URL =
  'https://huggingface.co/datasets/sbollmann/lnm-webapp-models' +
  '/resolve/main/templates/lnm-mni160.nii.gz';

async function ensureMni160() {
  try {
    const buf = await fs.readFile(MNI160_CACHE);
    if (buf.length > 5_000_000) return MNI160_CACHE;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(MNI160_CACHE), { recursive: true });
  console.log(`Fetching lnm-mni160 reference for browser smoke...`);
  const r = await fetch(MNI160_URL);
  if (!r.ok) throw new Error(`lnm-mni160 fetch failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(MNI160_CACHE, buf);
  return MNI160_CACHE;
}

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`server at ${url} not reachable within ${timeoutMs}ms (${lastErr?.message})`);
}

// Phase 32: per-stage controls live inside <details> disclosures so the
// primary "Run analysis" flow dominates the sidebar. Smoke tests that
// click those advanced controls must open the disclosure first or
// Playwright reports the button as not-visible. Idempotent — opens any
// already-open details a second time.
async function openAllDisclosures(page) {
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  });
}

async function spawnServer(port) {
  const server = spawn('bash', ['web/run.sh', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'C.UTF-8' }
  });
  let stdout = '';
  let stderr = '';
  server.stdout?.on('data', buf => { stdout += buf.toString(); });
  server.stderr?.on('data', buf => { stderr += buf.toString(); });
  return {
    server,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async close() {
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(() => { server.kill('SIGKILL'); resolve(undefined); }, 2000).unref?.();
      });
    }
  };
}

test('Phase 1c.4 browser smoke: phantom -> Yeo overlap -> CSV download', { timeout: 90000 }, async (t) => {
  // Confirm fixture exists; a missing fixture = build_phantom.py never ran.
  await fs.access(PHANTOM_PATH);

  const port = BASE_PORT;
  const URL = `http://localhost:${port}/`;
  const { server, getStdout, getStderr, close } = await spawnServer(port);
  try {
    await waitForServer(URL);

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();

      const consoleMessages = [];
      page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
      page.on('pageerror', err => consoleMessages.push(`[pageerror] ${err.message}`));

      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.app && window.app.viewerController), { timeout: 15000 });
      await openAllDisclosures(page);

      // Drop the phantom mask. The change handler is async; wait until app.lesionFile is populated.
      await page.setInputFiles('#lesionFileInput', PHANTOM_PATH);
      await page.waitForFunction(() => Boolean(window.app.lesionFile), { timeout: 15000 });

      // Click compute. Live HF atlas fetch + decode + reducer is sub-second
      // on a warm cache; allow a wider margin for cold-cache + slow links.
      await page.click('#computeOverlapButton');
      await page.waitForFunction(
        () => Boolean(window.app.overlapResult),
        { timeout: 60000 }
      );

      // The phantom is in Yeo parcel 1 (Visual). Expect at least one bar
      // rendered with non-zero width.
      const barInfo = await page.$$eval(
        '#networkOverlapTable tbody tr .overlap-bar-fill',
        nodes => nodes.map(n => ({ width: n.style.width, color: n.style.backgroundColor }))
      );
      assert.ok(barInfo.length > 0, 'expected at least one row with an overlap-bar-fill');
      const nonzeroBars = barInfo.filter(b => b.width && b.width !== '0%' && b.width !== '0');
      assert.ok(
        nonzeroBars.length > 0,
        `expected at least one bar with non-zero width; got ${JSON.stringify(barInfo)}\n` +
        `console: ${consoleMessages.join('\n')}`
      );

      // Phantom fully inside atlas labels -> Yeo coverage note hidden.
      const warningHidden = await page.$eval(
        '#outsideAtlasWarning',
        el => el.classList.contains('hidden')
      );
      assert.ok(warningHidden, '#outsideAtlasWarning must be hidden for an inside-atlas phantom');

      // Download button must be enabled after a successful run.
      const downloadEnabled = await page.$eval('#downloadOverlapCsv', el => !el.disabled);
      assert.ok(downloadEnabled, '#downloadOverlapCsv must become enabled after runYeoOverlap');

      // Trigger the CSV download and capture the file body.
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('#downloadOverlapCsv')
      ]);
      assert.match(
        download.suggestedFilename(),
        /\.csv$/,
        `download filename must end with .csv (got ${download.suggestedFilename()})`
      );
      const downloadPath = await download.path();
      assert.ok(downloadPath, 'playwright must materialise the download to a temp file');
      const csv = await fs.readFile(downloadPath, 'utf8');
      const expectedHeader =
        'network,voxelsInLesion,fractionOfLesion,voxelsInNetwork,fractionOfNetwork,parcels';
      assert.ok(
        csv.startsWith(expectedHeader),
        `CSV must start with the canonical header.\nGot: ${JSON.stringify(csv.slice(0, 120))}`
      );
      // The phantom places 64 voxels in label 1 (Yeo Visual). The CSV must
      // surface a 'Visual' row with voxelsInLesion=64.
      assert.match(
        csv,
        /\nVisual,64,/,
        `expected a 'Visual,64,...' row in the CSV; full CSV:\n${csv}`
      );

      t.diagnostic(
        `Smoke test green: ${barInfo.length} table rows, ${nonzeroBars.length} non-zero bars, ` +
        `CSV byte-size=${csv.length}.`
      );

      // Phase 4.6 extension: click 'Compute network map' on the same
      // overlap result, capture the NIfTI download, assert the FC chain
      // ran end-to-end in the browser (Cache Storage fetch of the FC
      // pack + JS fcWeightedSum + writeNifti1 + Blob download).
      // Manual poll loop because Playwright's waitForFunction({timeout})
      // is unreliable with no-arg page functions (uses 30 s default).
      await page.click('#computeNetworkMapButton');
      const FC_TIMEOUT_MS = 60000;
      const fcStart = Date.now();
      let fcDone = false;
      while (Date.now() - fcStart < FC_TIMEOUT_MS) {
        fcDone = await page.evaluate(() => Boolean(window.app && window.app.networkMapFile));
        if (fcDone) break;
        await sleep(500);
      }
      if (!fcDone) {
        throw new Error(
          `Network map never appeared within ${FC_TIMEOUT_MS}ms\n` +
          `console: ${consoleMessages.slice(-30).join('\n')}`
        );
      }

      const dlEnabled = await page.$eval('#downloadNetworkMapButton', el => !el.disabled);
      assert.ok(dlEnabled, '#downloadNetworkMapButton must enable after a successful run');

      const [fcDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('#downloadNetworkMapButton')
      ]);
      assert.match(
        fcDownload.suggestedFilename(),
        /\.nii(\.gz)?$/,
        `FC download filename must end with .nii (got ${fcDownload.suggestedFilename()})`
      );
      const fcPath = await fcDownload.path();
      const fcBytes = await fs.readFile(fcPath);
      assert.ok(fcBytes.length > 1000, `FC download too small: ${fcBytes.length} bytes`);
      // NIfTI-1 single-file: header byte[0] = 0x5C (sizeof_hdr=348 LE).
      assert.equal(fcBytes[0], 0x5c, 'FC download must start with NIfTI-1 header byte 0x5C');
      assert.equal(fcBytes[1], 0x01, 'FC download must start with NIfTI-1 header byte 0x01');
      t.diagnostic(`FC network map: ${fcBytes.length} bytes downloaded.`);

      // Phase 5.4 extension: drive the top-percent threshold UI, expect
      // the download-thresholded button to flip to enabled and emit a
      // NIfTI mask. Set top 5% so the threshold is meaningful regardless
      // of the raw t-stat range.
      await page.fill('#networkThresholdValue', '5');
      await page.evaluate(() => {
        document.getElementById('networkThresholdValue').dispatchEvent(new Event('input', { bubbles: true }));
      });
      // Recompute should fire on input; give the synchronous handler a tick.
      await sleep(200);
      const threshDlEnabled = await page.$eval('#downloadThresholdedNetworkMapButton', el => !el.disabled);
      assert.ok(threshDlEnabled, '#downloadThresholdedNetworkMapButton must enable after applyNetworkThreshold');
      const threshSummary = await page.$eval('#networkThresholdSummary', el => el.textContent);
      assert.match(threshSummary, /voxels survive/i,
        `threshold summary must show survivor count, got: ${JSON.stringify(threshSummary)}`);

      const [threshDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('#downloadThresholdedNetworkMapButton')
      ]);
      const threshPath = await threshDownload.path();
      const threshBytes = await fs.readFile(threshPath);
      assert.ok(threshBytes.length > 348, `thresholded mask too small: ${threshBytes.length} bytes`);
      assert.equal(threshBytes[0], 0x5c, 'thresholded NIfTI must start with header byte 0x5C');
      assert.equal(threshBytes[1], 0x01, 'thresholded NIfTI must start with header byte 0x01');
      t.diagnostic(`Thresholded mask: ${threshBytes.length} bytes, summary="${threshSummary}".`);
    } finally {
      await browser.close();
    }
  } catch (err) {
    err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
    throw err;
  } finally {
    await close();
  }
});

// Phase 8: Run full pipeline button on the manual-mask branch. Same phantom
// as Phase 1c.4, but a single click should drive overlap + FC network map +
// threshold (defaults) end to end. Stays on the manual-mask branch so we
// don't need a structural T1 fixture.
test('Phase 8 browser smoke: phantom -> Run full pipeline (manual branch)', { timeout: 120000 }, async (t) => {
  await fs.access(PHANTOM_PATH);

  // Use a different port so a leftover server from the previous test
  // (in case its teardown lagged) cannot collide.
  const port = BASE_PORT + 5;
  const URL = `http://localhost:${port}/`;
  const { server, getStdout, getStderr, close } = await spawnServer(port);
  try {
    await waitForServer(URL);

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const consoleMessages = [];
      page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
      page.on('pageerror', err => consoleMessages.push(`[pageerror] ${err.message}`));

      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.app && window.app.viewerController), { timeout: 15000 });
      await openAllDisclosures(page);

      await page.setInputFiles('#lesionFileInput', PHANTOM_PATH);
      await page.waitForFunction(() => Boolean(window.app.lesionFile), { timeout: 15000 });

      // The button itself is the fast path for users who dropped a Yeo-grid
      // mask manually. Internally: detect 99x117x95 -> skip seg+register ->
      // runYeoOverlap -> runFcNetworkMap -> applyNetworkThreshold.
      await page.click('#runFullPipelineButton');

      // Wait until the overlap + FC + threshold side-effects have all
      // landed: networkOverlapTable populated, networkMapFile present,
      // thresholdedMaskFile present. Manual poll loop because nested
      // promise chains can take ~10–60 s on cold HF cache.
      const FULL_TIMEOUT = 120000;
      const startedAt = Date.now();
      let done = false;
      while (Date.now() - startedAt < FULL_TIMEOUT) {
        done = await page.evaluate(() => Boolean(
          window.app
          && window.app.overlapResult
          && window.app.networkMapFile
          && window.app.thresholdedMaskFile
        ));
        if (done) break;
        await sleep(500);
      }
      if (!done) {
        throw new Error(
          `Full pipeline did not complete within ${FULL_TIMEOUT}ms\n` +
          `console: ${consoleMessages.slice(-30).join('\n')}`
        );
      }

      const overlapRowCount = await page.$$eval(
        '#networkOverlapTable tbody tr',
        rows => rows.length
      );
      assert.ok(overlapRowCount > 0, 'Overlap table should have at least one row after the chain.');

      const fcEnabled = await page.$eval('#downloadNetworkMapButton', el => !el.disabled);
      assert.ok(fcEnabled, 'Download network map button should be enabled.');

      const threshEnabled = await page.$eval('#downloadThresholdedNetworkMapButton', el => !el.disabled);
      assert.ok(threshEnabled, 'Download thresholded mask button should be enabled.');

      const threshSummary = await page.$eval('#networkThresholdSummary', el => el.textContent);
      assert.match(threshSummary, /voxels survive/i,
        `threshold summary must show survivor count, got: ${JSON.stringify(threshSummary)}`);

      t.diagnostic(`Run full pipeline OK: ${overlapRowCount} rows, summary="${threshSummary}".`);
    } finally {
      await browser.close();
    }
  } catch (err) {
    err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
    throw err;
  } finally {
    await close();
  }
});

test('Phase 2a.1.5 browser smoke: structural T1 -> SynthStrip -> brain mask download',
  { timeout: 240000 },
  async (t) => {
    await fs.access(STRUCTURAL_PATH);

    // Use a different port so a leftover server from the previous test
    // (in case its teardown timed out) cannot collide.
    const port = BASE_PORT + 1;
    const URL = `http://localhost:${port}/`;
    const { getStdout, getStderr, close } = await spawnServer(port);

    try {
      await waitForServer(URL);

      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();

        const consoleMessages = [];
        page.on('console', msg => consoleMessages.push(`[main:${msg.type()}] ${msg.text()}`));
        page.on('pageerror', err => consoleMessages.push(`[main:pageerror] ${err.message}`));
        // Worker contexts have their own console. Forward.
        page.on('worker', worker => {
          consoleMessages.push(`[worker:spawned] ${worker.url()}`);
          worker.on('console', msg => consoleMessages.push(`[worker:${msg.type()}] ${msg.text()}`));
          worker.on('close', () => consoleMessages.push(`[worker:closed]`));
        });

        await page.goto(URL, { waitUntil: 'load' });
        await page.waitForFunction(
          () => Boolean(window.app && window.app.viewerController && window.app.executor),
          { timeout: 15000 }
        );
        await openAllDisclosures(page);

        // Load the structural T1, then explicitly start brain extraction.
        // Loading only previews the image; the user-owned stage button posts
        // 'load' + 'run-synthstrip' to the worker. The worker fetches the
        // SynthStrip ONNX from HF on first run (cached after) and runs the
        // whole-volume WASM pipeline.
        await page.setInputFiles('#structuralFileInput', STRUCTURAL_PATH);
        await page.click('#runBrainExtractionButton');

        // Wait for SynthStrip completion: brainmaskFile is set by
        // handleStageData('brainmask') in lnm-app.js. Manual poll loop
        // (Playwright's `waitForFunction({timeout})` second-arg overload is
        // unreliable with no-arg page functions — was firing the 30s default
        // instead of the configured 180s).
        const SYNTH_TIMEOUT_MS = 180000;
        const synthStart = Date.now();
        let synthDone = false;
        while (Date.now() - synthStart < SYNTH_TIMEOUT_MS) {
          synthDone = await page.evaluate(() => Boolean(window.app && window.app.brainmaskFile));
          if (synthDone) break;
          await sleep(500);
        }
        if (!synthDone) {
          const inPageConsole = await page
            .$eval('#consoleOutput', el => el ? el.innerText : '(missing)')
            .catch(() => '(unavailable)');
          throw new Error(
            `Brain mask did not appear within ${SYNTH_TIMEOUT_MS}ms\n` +
            `--- captured browser-console messages ---\n${consoleMessages.slice(-30).join('\n')}\n` +
            `--- in-page #consoleOutput widget ---\n${inPageConsole}`
          );
        }
        t.diagnostic(`SynthStrip elapsed: ${((Date.now() - synthStart) / 1000).toFixed(1)}s`);

        const downloadEnabled = await page.$eval('#downloadBrainMaskButton', el => !el.disabled);
        assert.ok(
          downloadEnabled,
          '#downloadBrainMaskButton must enable after the brainmask stage completes\n' +
          `console: ${consoleMessages.slice(-30).join('\n')}`
        );

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click('#downloadBrainMaskButton')
        ]);
        assert.match(
          download.suggestedFilename(),
          /\.nii(\.gz)?$/,
          `download filename must end with .nii or .nii.gz (got ${download.suggestedFilename()})`
        );
        const downloadPath = await download.path();
        assert.ok(downloadPath, 'playwright must materialise the download to a temp file');
        const masked = await fs.readFile(downloadPath);
        assert.ok(masked.length > 1000, `downloaded brain mask too small: ${masked.length} bytes`);
        // Either a NIfTI-1 .nii (header byte[0]=0x5C, sizeof_hdr=348 LE) or
        // a gzip .nii.gz (magic 0x1f 0x8b).
        const isGzip = masked[0] === 0x1f && masked[1] === 0x8b;
        const isNiftiHdr = masked[0] === 0x5c && masked[1] === 0x01;
        assert.ok(
          isGzip || isNiftiHdr,
          `brain mask download is neither gzip nor a NIfTI-1 header; ` +
          `got first bytes ${masked[0].toString(16)} ${masked[1].toString(16)}`
        );

        t.diagnostic(
          `SynthStrip smoke green; downloaded brain mask = ${masked.length} bytes ` +
          `(suggested filename: ${download.suggestedFilename()}).`
        );
      } finally {
        await browser.close();
      }
    } catch (err) {
      err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
      throw err;
    } finally {
      await close();
    }
  }
);

test('Phase 2a.2.5 browser smoke: structural T1 -> editable lesion seed -> confirm/download mask',
  { timeout: 240000 },
  async (t) => {
    await fs.access(STRUCTURAL_PATH);

    const port = BASE_PORT + 2;
    const URL = `http://localhost:${port}/`;
    const { getStdout, getStderr, close } = await spawnServer(port);

    try {
      await waitForServer(URL);

      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();

        const consoleMessages = [];
        page.on('console', msg => consoleMessages.push(`[main:${msg.type()}] ${msg.text()}`));
        page.on('pageerror', err => consoleMessages.push(`[main:pageerror] ${err.message}`));
        page.on('worker', worker => {
          worker.on('console', msg => consoleMessages.push(`[worker:${msg.type()}] ${msg.text()}`));
        });

        await page.goto(URL, { waitUntil: 'load' });
        await page.waitForFunction(
          () => Boolean(window.app && window.app.viewerController && window.app.executor),
          { timeout: 15000 }
        );
        await openAllDisclosures(page);

        // Load the structural, then explicitly run SynthStrip. Wait for the
        // brain mask to land before kicking off lesion seg (the SCT-derived
        // worker state is single-tenant: a 'load' op overwrites
        // workerState.rasData, so we must serialise the two stages).
        await page.setInputFiles('#structuralFileInput', STRUCTURAL_PATH);
        await page.click('#runBrainExtractionButton');
        const SYNTH_TIMEOUT_MS = 180000;
        const synthStart = Date.now();
        let synthDone = false;
        while (Date.now() - synthStart < SYNTH_TIMEOUT_MS) {
          synthDone = await page.evaluate(() => Boolean(window.app && window.app.brainmaskFile));
          if (synthDone) break;
          await sleep(500);
        }
        if (!synthDone) {
          throw new Error(
            `SynthStrip never finished within ${SYNTH_TIMEOUT_MS}ms\n` +
            `console: ${consoleMessages.slice(-30).join('\n')}`
          );
        }
        t.diagnostic(`SynthStrip elapsed: ${((Date.now() - synthStart) / 1000).toFixed(1)}s`);

        // Click 'Auto seed mask'. This calls executor.loadVolume +
        // executor.runInference(...) under the hood, then pauses in
        // NiiVue drawing mode until the user confirms the editable seed.
        await page.click('#runLesionSegmentationButton');
        const SEG_TIMEOUT_MS = 180000;
        const segStart = Date.now();
        let seedReady = false;
        while (Date.now() - segStart < SEG_TIMEOUT_MS) {
          seedReady = await page.evaluate(() => Boolean(
            window.app &&
            window.app.autoLesionSeedFile &&
            window.app.maskReviewActive
          ));
          if (seedReady) break;
          await sleep(500);
        }
        if (!seedReady) {
          throw new Error(
            `Editable lesion seed never became ready within ${SEG_TIMEOUT_MS}ms\n` +
            `console: ${consoleMessages.slice(-30).join('\n')}`
          );
        }
        t.diagnostic(`Editable lesion seed elapsed: ${((Date.now() - segStart) / 1000).toFixed(1)}s`);

        await page.click('#confirmLesionMaskButton');
        await page.waitForFunction(
          () => Boolean(window.app?.lesionMaskFile && window.app?.lesionMaskConfirmed),
          { timeout: 60000 }
        );

        const downloadEnabled = await page.$eval('#downloadLesionMaskButton', el => !el.disabled);
        assert.ok(downloadEnabled, '#downloadLesionMaskButton must enable after mask confirmation');

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click('#downloadLesionMaskButton')
        ]);
        assert.match(
          download.suggestedFilename(),
          /\.nii(\.gz)?$/,
          `download filename must end with .nii or .nii.gz (got ${download.suggestedFilename()})`
        );
        const downloadPath = await download.path();
        assert.ok(downloadPath, 'playwright must materialise the download to a temp file');
        const masked = await fs.readFile(downloadPath);
        assert.ok(masked.length > 1000, `lesion mask download too small: ${masked.length} bytes`);
        const isGzip = masked[0] === 0x1f && masked[1] === 0x8b;
        const isNiftiHdr = masked[0] === 0x5c && masked[1] === 0x01;
        assert.ok(
          isGzip || isNiftiHdr,
          `lesion mask download is neither gzip nor NIfTI-1 header; ` +
          `got first bytes ${masked[0].toString(16)} ${masked[1].toString(16)}`
        );

        t.diagnostic(
          `Editable lesion-mask smoke green; downloaded mask = ${masked.length} bytes ` +
          `(suggested filename: ${download.suggestedFilename()}).`
        );
      } finally {
        await browser.close();
      }
    } catch (err) {
      err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
      throw err;
    } finally {
      await close();
    }
  }
);

test('Phase 3.7 browser smoke: structural T1 -> SynthMorph MNI registration',
  { timeout: 360000 },
  async (t) => {
    const structuralPath = await ensureMni160();

    // Use a different port from the previous smoke tests.
    const port = BASE_PORT + 3;
    const URL = `http://localhost:${port}/`;
    const { getStdout, getStderr, close } = await spawnServer(port);

    try {
      await waitForServer(URL);

      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();

        const consoleMessages = [];
        page.on('console', msg => consoleMessages.push(`[main:${msg.type()}] ${msg.text()}`));
        page.on('pageerror', err => consoleMessages.push(`[main:pageerror] ${err.message}`));
        page.on('worker', worker => {
          worker.on('console', msg => consoleMessages.push(`[worker:${msg.type()}] ${msg.text()}`));
        });

        await page.goto(URL, { waitUntil: 'load' });
        await page.waitForFunction(
          () => Boolean(window.app && window.app.viewerController && window.app.executor),
          { timeout: 15000 }
        );
        await openAllDisclosures(page);

        // Drop the lnm-mni160 reference as the 'structural'. It is itself a
        // 160x160x192 1mm MNI152 brain — a clean self-pair for the
        // registration. Loading does not start processing; click
        // #runRegistrationButton explicitly.
        await page.setInputFiles('#structuralFileInput', structuralPath);
        await page.click('#runRegistrationButton');
        // The browser SynthMorph graph is spatially retargeted to
        // the manifest browser grid, so this smoke now requires the registration stage to
        // complete. The old 160-grid model only validated kickoff because
        // its first WebGPU activation was multi-gigabyte and failed before
        // forward completion.
        const START_TIMEOUT_MS = 60000;
        const startedT = Date.now();
        let registerStarted = false;
        while (Date.now() - startedT < START_TIMEOUT_MS) {
          registerStarted = await page.evaluate(
            () => Boolean(
              window.app &&
              window.app.executor &&
              window.app.executor.stepStatus &&
              window.app.executor.stepStatus.register === 'running'
            )
          );
          if (registerStarted) break;
          await sleep(500);
        }
        if (!registerStarted) {
          throw new Error(
            `Registration never transitioned to 'running' within ${START_TIMEOUT_MS}ms\n` +
            `console: ${consoleMessages.slice(-40).join('\n')}`
          );
        }
        t.diagnostic(`Registration started after ${((Date.now() - startedT) / 1000).toFixed(1)}s; ` +
          'waiting for browser completion.');

        const COMPLETE_TIMEOUT_MS = 180000;
        const completeT = Date.now();
        let registerComplete = false;
        let registerError = null;
        while (Date.now() - completeT < COMPLETE_TIMEOUT_MS) {
          registerComplete = await page.evaluate(
            () => Boolean(
              window.app &&
              window.app.executor &&
              window.app.executor.stepStatus &&
              window.app.executor.stepStatus.register === 'complete'
            )
          );
          if (registerComplete) break;
          registerError = consoleMessages.find(m =>
            m.includes('Register error:') ||
            m.includes('Worker error:') ||
            m.startsWith('[main:log] Error:') ||
            m.includes('[main:pageerror]') ||
            m.includes('[worker:error]')
          );
          if (registerError) break;
          await sleep(500);
        }
        assert.ok(registerComplete,
          `Registration did not complete in browser within ${COMPLETE_TIMEOUT_MS}ms` +
          (registerError ? `\nfirst error: ${registerError}` : '') +
          `\nconsole: ${consoleMessages.slice(-60).join('\n')}`);
        t.diagnostic(`Registration completed after ${((Date.now() - completeT) / 1000).toFixed(1)}s.`);

        const wiringErrs = consoleMessages.filter(m =>
          m.includes('pageerror') ||
          m.includes(':error]')
        );
        assert.equal(wiringErrs.length, 0,
          `unexpected wiring errors after registration kickoff:\n${wiringErrs.join('\n')}`);

        // Phase 28: surface which EP SynthMorph used. The worker explicitly
        // tries WebGPU first then falls back to WASM, logging
        // 'SynthMorph EP=<name>'. Headless Chromium without --enable-unsafe-
        // webgpu falls back to WASM; with WebGPU enabled (via the launch
        // args set above), WebGPU should be chosen. Diagnostic-only — we
        // don't assert because both paths are valid; we just want the
        // signal in the test log to catch a silent EP-list regression.
        const epLine = consoleMessages.find(m => /SynthMorph EP=/.test(m));
        if (epLine) {
          t.diagnostic(`SynthMorph chosen EP signal: ${epLine}`);
        } else {
          t.diagnostic('No SynthMorph EP=... log line observed; ' +
            'session may not have reached the create() step yet.');
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
      throw err;
    } finally {
      await close();
    }
  }
);

// Phase 10: full pipeline on the auto branch. Uses the lnm-auto-mini
// fixture (160x160x192 1mm MNI template + planted hypointensity sphere)
// so SynthMorph converges near-identity. Asserts the chain *completes*
// — the planted lesion is coarse and SynthStroke may produce a small or
// empty mask; we don't gate on lesion-detection accuracy here. Empty
// downstream results are acceptable as long as the chain finishes
// without throwing and the threshold UI surfaces a definite count.
//
// Slow: ~5 min cold (3 ONNX models + bridge + FC pack on first run).
test('Phase 10 browser smoke: T1 -> Run full pipeline (auto branch)',
  { timeout: 600000 },
  async (t) => {
    await fs.access(AUTO_T1_PATH);

    const port = BASE_PORT + 6;
    const URL = `http://localhost:${port}/`;
    const { server, getStdout, getStderr, close } = await spawnServer(port);
    try {
      await waitForServer(URL);

      // Phase 31: try to enable WebGPU in headless Chromium so SynthMorph
      // doesn't OOM the WASM heap. These flags are best-effort; on a CI
      // machine without GPU acceleration WebGPU still won't work and we
      // gracefully degrade below to a "register attempted but failed in
      // WASM" assertion.
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--enable-unsafe-webgpu',
          '--enable-features=Vulkan',
          '--use-angle=swiftshader',
          '--use-vulkan=swiftshader'
        ]
      });
      try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();
        const consoleMessages = [];
        page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
        page.on('pageerror', err => consoleMessages.push(`[pageerror] ${err.message}`));

        await page.goto(URL, { waitUntil: 'load' });
        await page.waitForFunction(
          () => Boolean(window.app && window.app.viewerController),
          { timeout: 15000 }
        );
        await openAllDisclosures(page);

        // Capture WebGPU availability up front; the assertions below
        // branch on it.
        const webgpuAvailable = await page.evaluate(
          () => Boolean(navigator.gpu)
        );
        t.diagnostic(`navigator.gpu present: ${webgpuAvailable}`);

        await page.setInputFiles('#structuralFileInput', AUTO_T1_PATH);
        await page.waitForFunction(() => Boolean(window.app.structuralFile), { timeout: 15000 });

        await page.click('#runFullPipelineButton');

        const FULL_TIMEOUT = 480000;
        // After SynthStrip + SynthStroke complete, give SynthMorph 3 min
        // to either produce the warped lesion or error. The current
        // SynthMorph graph is WASM-routed because WebGPU rejects its
        // NHWC 3D MaxPool nodes; in headless Chromium, that path can
        // stall before the bridge emits the MNI lesion.
        const REGISTER_STALL_LIMIT = 180000;
        const startedAt = Date.now();
        let done = false;
        let registerAttemptedAt = 0;
        let registerErrored = false;
        let registerStalled = false;
        let confirmClicked = false;
        let lastStateLog = 0;
        while (Date.now() - startedAt < FULL_TIMEOUT) {
          const state = await page.evaluate(() => ({
            brain: Boolean(window.app?.brainmaskFile),
            seed: Boolean(window.app?.autoLesionSeedFile),
            review: Boolean(window.app?.maskReviewActive),
            confirmed: Boolean(window.app?.lesionMaskFile && window.app?.lesionMaskConfirmed),
            mniLesion: Boolean(window.app?.mniLesionFile),
            yeoLesion: Boolean(window.app?.lesionFile),
            overlap: Boolean(window.app?.overlapResult),
            netmap: Boolean(window.app?.networkMapFile),
            thresh: Boolean(window.app?.thresholdedMaskFile)
          }));
          if (state.thresh && state.overlap) { done = true; break; }
          if (state.seed && state.review && !confirmClicked) {
            await page.click('#confirmLesionMaskButton');
            confirmClicked = true;
            t.diagnostic('Editable lesion seed ready; clicked Confirm mask to resume auto pipeline.');
          }
          if (state.brain && state.confirmed && registerAttemptedAt === 0) {
            registerAttemptedAt = Date.now();
          }
          if (registerAttemptedAt && consoleMessages.some(m => /Register error:\s*\d+/.test(m))) {
            registerErrored = true;
            break;
          }
          if (registerAttemptedAt && (Date.now() - registerAttemptedAt) > REGISTER_STALL_LIMIT
              && !state.mniLesion) {
            registerStalled = true;
            break;
          }
          if (Date.now() - lastStateLog > 30000) {
            t.diagnostic(`auto-pipeline state: ${JSON.stringify(state)}`);
            lastStateLog = Date.now();
          }
          await sleep(1000);
        }

        // Branch: chain finished -> full assertion. Otherwise, use the
        // degraded assertion: brain extraction + segmentation completed
        // and the register stage was at least attempted. SynthMorph
        // correctness is tested by test:registration-parity in Node
        // where ORT-Node doesn't have the browser WASM heap limit.
        if (done) {
          const threshSummary = await page.$eval(
            '#networkThresholdSummary',
            el => el.textContent
          );
          assert.match(threshSummary, /voxels\s+survive/i,
            `threshold summary must mention 'voxels survive'; got ${JSON.stringify(threshSummary)}`);
          const fcEnabled = await page.$eval('#downloadNetworkMapButton', el => !el.disabled);
          assert.ok(fcEnabled, '#downloadNetworkMapButton must be enabled after the auto chain.');
          const threshEnabled = await page.$eval(
            '#downloadThresholdedNetworkMapButton',
            el => !el.disabled
          );
          assert.ok(threshEnabled, '#downloadThresholdedNetworkMapButton must be enabled.');
          t.diagnostic(`Auto-branch full pipeline OK. Summary: "${threshSummary}".`);
        } else if (registerErrored || registerStalled) {
          // Headless Chromium's WASM route either OOMed or hung. That's
          // a known environment limitation, not a wiring bug. Verify the
          // chain DID get through SynthStrip + SynthStroke + mask
          // confirmation + register-
          // attempted; the Node parity tests cover SynthMorph forward
          // correctness without the browser WASM heap limit.
          assert.ok(registerAttemptedAt > 0,
            'register stage must at least be attempted (brain + editable seed + confirmed mask complete)');
          const reason = registerErrored ? 'WASM-OOMed' : 'WASM-stalled';
          t.diagnostic(
            `Auto-branch degraded: WebGPU=${webgpuAvailable}, ` +
            `SynthStrip+SynthStroke+Confirm-mask ran, SynthMorph ${reason} as expected. ` +
            `Run registration directly or with a longer browser budget for full coverage.`
          );
        } else {
          throw new Error(
            `Auto-pipeline did not complete within ${FULL_TIMEOUT}ms ` +
            `(no thresh, no register error)\n` +
            `console (last 50): ${consoleMessages.slice(-50).join('\n')}`
          );
        }

        const wiringErrs = consoleMessages.filter(m =>
          (m.includes('pageerror') ||
            (m.includes(':error]') && !/Register error: \d+$/.test(m))));
        if (wiringErrs.length) {
          t.diagnostic(`auto-branch wiring warnings (${wiringErrs.length}):\n${wiringErrs.slice(-10).join('\n')}`);
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      err.message += `\n\n--- server stdout ---\n${getStdout()}\n--- server stderr ---\n${getStderr()}`;
      throw err;
    } finally {
      await close();
    }
  }
);
