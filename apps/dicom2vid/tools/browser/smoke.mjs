// Headless browser smoke test. Serves the repo, then in a real Chromium checks:
//  1. the reader + pipeline reproduce a golden frame stack in-browser (max|diff|=0),
//  2. the encoder produces a non-empty video (WebM always, MP4 if supported),
//  3. the full UI flow works: pick phantom DICOMs, generate, get a downloadable blob.
//
// Run: node tools/browser/smoke.mjs   (after gen_phantom.py + gen_reference.py)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.dcm': 'application/octet-stream', '.nii': 'application/octet-stream',
  '.gz': 'application/octet-stream', '.mgz': 'application/octet-stream',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('ok  -', msg); }

async function main() {
  const dicomDir = path.join(ROOT, 'tools', 'phantom_out', 'dicom_single');
  if (!fs.existsSync(dicomDir)) { fail('run tools/gen_phantom.py + tools/gen_reference.py first'); return; }

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Keep the test hermetic: never hit Google Analytics; return an empty script.
  await page.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/,
    (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });

  try {
    await page.goto(`${base}/web/index.html`, { waitUntil: 'load' });

    // Analytics snippet is wired without any external call (GA hosts are stubbed).
    const gaWired = await page.evaluate(() => Array.isArray(window.dataLayer) && window.dataLayer.length >= 2);
    if (gaWired) ok('analytics wired (dataLayer populated); no external call in test');
    else fail('analytics snippet not wired (window.dataLayer missing)');

    // 1. In-browser parity against the golden.
    const parity = await page.evaluate(async () => {
      const { readDicomSeries } = await import('/web/js/readers/dicom.js');
      const { buildFrames } = await import('/web/js/pipeline.js');
      const manifest = await (await fetch('/tools/golden/manifest.json')).json();
      const cfg = manifest.configs.find((c) => c.name === 'single_sagittal');
      const names = ['img_000.dcm', 'img_001.dcm', 'img_002.dcm', 'img_003.dcm', 'img_004.dcm'];
      const files = [];
      for (const n of names) {
        const ab = await (await fetch(`/tools/phantom_out/dicom_single/${n}`)).arrayBuffer();
        files.push({ name: n, buffer: ab });
      }
      const vol = readDicomSeries(files);
      const out = buildFrames(vol, { orientation: cfg.orientation, start: cfg.start, end: cfg.end, step: cfg.step });
      const golden = new Uint8Array(await (await fetch('/tools/golden/single_sagittal.bin')).arrayBuffer());
      let maxDiff = 0;
      for (let i = 0; i < golden.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.frames[i] - golden[i]));
      return { len: out.frames.length, glen: golden.length, maxDiff };
    });
    if (parity.len === parity.glen && parity.maxDiff === 0) ok(`in-browser parity max|diff|=0 (${parity.len} bytes)`);
    else fail(`in-browser parity: len ${parity.len} vs ${parity.glen}, maxDiff ${parity.maxDiff}`);

    // 2. Encoder unit test.
    const enc = await page.evaluate(async () => {
      const { encodeVideo, probeEncoders } = await import('/web/js/encode.js');
      const probe = await probeEncoders(64, 64, 20);
      const fW = 64, fH = 64, n = 10;
      const provider = (i) => {
        const f = new Uint8ClampedArray(fW * fH);
        for (let p = 0; p < f.length; p++) f[p] = (p + i * 7) % 256;
        return { frame: f, fW, fH, channels: 1, sliceIndex: i };
      };
      const webm = await encodeVideo({ nFrames: n, fps: 10, container: 'webm', frameProvider: provider, annotate: true, total: n });
      let mp4 = null;
      try { const r = await encodeVideo({ nFrames: n, fps: 10, container: 'mp4', frameProvider: provider, total: n }); mp4 = { size: r.blob.size, codec: r.codecName, type: r.blob.type }; }
      catch (e) { mp4 = { error: e.message }; }
      return { probe, webmSize: webm.blob.size, webmCodec: webm.codecName, webmType: webm.blob.type, mp4 };
    });
    if (enc.webmSize > 0) ok(`webm encode ${enc.webmSize} bytes via ${enc.webmCodec} (${enc.webmType})`);
    else fail('webm encode produced 0 bytes');
    console.log('     probe:', JSON.stringify(enc.probe));
    console.log('     mp4:', JSON.stringify(enc.mp4));

    // 2b. NIfTI and color-DICOM paths through to encode.
    const formats = await page.evaluate(async () => {
      const { readNifti } = await import('/web/js/readers/nifti.js');
      const { readDicomSeries } = await import('/web/js/readers/dicom.js');
      const { buildFrames } = await import('/web/js/pipeline.js');
      const { volumeToNifti } = await import('/web/js/nifti_write.js');
      const { encodeVideo } = await import('/web/js/encode.js');
      const providerFrom = (out, channels) => {
        const sz = out.fH * out.fW * channels;
        return (i) => ({ frame: out.frames.subarray(i * sz, (i + 1) * sz), fW: out.fW, fH: out.fH, channels, sliceIndex: out.sliceIndices[i] });
      };
      // NIfTI grayscale.
      const nvol = await readNifti(await (await fetch('/tools/phantom_out/nifti_gray.nii')).arrayBuffer(), 'nifti_gray.nii');
      volumeToNifti(nvol);
      const nout = buildFrames(nvol, { orientation: 'axial' });
      const nres = await encodeVideo({ nFrames: nout.nFrames, fps: 10, container: 'webm', frameProvider: providerFrom(nout, 1), total: nout.total });
      // Color DICOM (RGB).
      const names = ['rgb_000.dcm', 'rgb_001.dcm', 'rgb_002.dcm', 'rgb_003.dcm', 'rgb_004.dcm'];
      const files = [];
      for (const n of names) files.push({ name: n, buffer: await (await fetch(`/tools/phantom_out/dicom_rgb/${n}`)).arrayBuffer() });
      const rvol = readDicomSeries(files);
      const rout = buildFrames(rvol, { orientation: 'sagittal' });
      const rres = await encodeVideo({ nFrames: rout.nFrames, fps: 10, container: 'webm', frameProvider: providerFrom(rout, 3), total: rout.total });
      return { niftiSize: nres.blob.size, colorChannels: rvol.channels, colorSize: rres.blob.size };
    });
    if (formats.niftiSize > 0) ok(`NIfTI -> video ${formats.niftiSize} bytes`);
    else fail('NIfTI encode produced 0 bytes');
    if (formats.colorChannels === 3 && formats.colorSize > 0) ok(`color DICOM (RGB) -> video ${formats.colorSize} bytes`);
    else fail(`color path: channels ${formats.colorChannels}, size ${formats.colorSize}`);

    // 3. Full UI flow.
    // The tour opens from the Tutorial button, not automatically.
    if (!(await page.locator('#tour').isVisible())) ok('tour does not auto-open');
    else fail('tour auto-opened but should not');
    await page.click('#tutorialBtn');
    await page.waitForSelector('#tour:not(.hidden)', { timeout: 3000 });
    ok('tutorial opens from the Tutorial button');
    await page.click('#tourSkip');

    const files = fs.readdirSync(dicomDir).filter((n) => n.endsWith('.dcm')).map((n) => path.join(dicomDir, n));
    await page.setInputFiles('#pickFiles', files);
    await page.waitForSelector('#optionsPanel:not(.hidden)', { timeout: 10000 });

    // Preview modal, reconstruction buttons, and rotation.
    await page.click('#previewBtn');
    await page.waitForSelector('#previewModal:not(.hidden)', { timeout: 5000 });
    await page.click('.btn.ori[data-ori=coronal]');
    const oriAfter = await page.inputValue('#orientation');
    if (oriAfter === 'coronal') ok('preview reconstruction buttons set orientation');
    else fail(`recon button did not set orientation (got ${oriAfter})`);
    await page.click('#rotateBtn');
    const rotText = await page.textContent('#rotateBtn');
    if (/90/.test(rotText)) ok('rotate button cycles rotation');
    else fail(`rotate button text unexpected: ${rotText}`);

    // Stretch tool resizes the frames.
    const wBefore = await page.evaluate(() => document.getElementById('scrubCanvas').width);
    await page.evaluate(() => { const s = document.getElementById('scaleX'); s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    const wAfter = await page.evaluate(() => document.getElementById('scrubCanvas').width);
    if (wAfter > wBefore) ok(`stretch X resizes frames (${wBefore} -> ${wAfter})`);
    else fail(`stretch X did not resize (${wBefore} -> ${wAfter})`);
    await page.click('#resetScale');
    await page.click('#previewClose');

    await page.selectOption('#orientation', 'sagittal');
    await page.selectOption('#format', 'webm');
    const scrubLabel = await page.textContent('#scrubLabel');
    await page.click('#generate');
    await page.waitForSelector('#resultPanel:not(.hidden)', { timeout: 20000 });
    const href = await page.getAttribute('#downloadLink', 'href');
    const info = await page.textContent('#resultInfo');
    if (href && href.startsWith('blob:')) ok(`UI flow produced downloadable video: ${info} (preview: ${scrubLabel})`);
    else fail(`UI flow: bad download href ${href}`);

  } catch (e) {
    fail(`exception: ${e.message}\n${e.stack}`);
  } finally {
    if (pageErrors.length) { console.error('Page errors:'); pageErrors.forEach((e) => console.error('  ', e)); process.exitCode = 1; }
    await browser.close();
    server.close();
  }
}

main();
