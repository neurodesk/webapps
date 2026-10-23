// Records what the mri2vid web app writes in Chromium for every validation case
// (browser-reference.json and videos pinned on Hugging Face), which the command line's release check
// (cli-check.mjs) compares against.
//
// Serves the app's production build (`pnpm --filter mri2vid build`) on loopback, then runs
// each case through the app's `encode-volume` automation operation with WebCodecs.
//
//   node validation/browser-reference.mjs           rewrite the reference
//   node validation/browser-reference.mjs --check   fail unless the browser still writes it
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeVideo, inspectVideo } from '../src/inspect.js';
import { parseOptions } from '../src/node.js';
import { readNifti } from '../src/readers/nifti.js';
import { labelBox, labelPixels, psnr, renderedLuma } from './frame-comparison.mjs';
import { CASES, exampleFile, referenceVideo, sha256 } from './cases.mjs';
import { decodeH264 } from './decode-h264.mjs';

const { values } = parseArgs({ options: { check: { type: 'boolean' }, output: { type: 'string' } } });
const check = values.check;
// Two encodes of the same frames differ by less than the command line and the browser do
// (35.9 dB at worst); the wrong slice, window or orientation scores 27 dB or less
// (validation/cli-check.mjs).
const MATCH_PSNR_DB = 35;

const dist = fileURLToPath(new URL('../../../apps/mri2vid/dist/', import.meta.url));
const referenceDir = resolve(values.output ?? join(tmpdir(), 'neurodesk-mri2vid-reference-output'));
const referenceJson = new URL('./browser-reference.json', import.meta.url);
const appVersion = JSON.parse(await readFile(new URL('../../../apps/mri2vid/package.json', import.meta.url), 'utf8')).version;
await readFile(join(dist, 'index.html')).catch(() => {
  throw new Error('Build the app first: pnpm --filter mri2vid build');
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = normalize(join(dist, path.endsWith('/') ? `${path}index.html` : path));
  const body = file.startsWith(dist) ? await readFile(file).catch(() => undefined) : undefined;
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const work = await mkdtemp(join(tmpdir(), 'mri2vid-browser-reference-'));
const recorded = {};
try {
  const page = await browser.newPage();
  const dispatch = (command, request = {}) => page.evaluate(
    ({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request),
    { command, request },
  );
  await page.goto(origin);
  await page.locator('#neurodesk-input-transfer').waitFor({ state: 'attached' });
  for (const item of CASES) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(await exampleFile(item.example));
    await dispatch('adopt', { role: 'image' });
    await dispatch('start', { operation: 'encode-volume', parameters: item.parameters });
    let snapshot;
    for (let waited = 0; ; waited += 250) {
      snapshot = await dispatch('snapshot');
      if (snapshot.state !== 'running') break;
      if (waited > 120000) throw new Error(`${item.id}: still running after two minutes`);
      await page.waitForTimeout(250);
    }
    if (snapshot.state !== 'succeeded') throw new Error(`${item.id}: ${JSON.stringify(snapshot.error)}`);
    const download = page.waitForEvent('download');
    await dispatch('download', { artifactId: 'video' });
    const path = join(work, `${item.id}.${item.parameters.format}`);
    await (await download).saveAs(path);
    const bytes = await readFile(path);
    const { summary } = snapshot.report;
    recorded[item.id] = {
      parameters: item.parameters,
      codec: summary.codec,
      container: summary.container,
      sha256: sha256(bytes),
      bytes: bytes.length,
      video: await inspectVideo(bytes),
    };
    recorded[item.id].file = `${item.id}.${item.parameters.format}`;
    console.log(`${item.id}: ${summary.codec} ${summary.container} ${summary.frames} frames ${summary.width}x${summary.height}, ${bytes.length} bytes`);
  }
  const reference = {
    note: 'Written by validation/browser-reference.mjs from the production app in Playwright Chromium. Do not edit.',
    app: appVersion,
    chromium: browser.version(),
    cases: recorded,
  };
  if (check) {
    // Container timestamps can change without changing encoded frames. Compare every
    // decoded video, including H.264 MP4; annotations use platform fonts, so compare
    // image pixels outside their box and require visible label ink independently.
    const committed = JSON.parse(await readFile(referenceJson, 'utf8'));
    const drift = [];
    for (const { id, parameters } of CASES) {
      const failuresBefore = drift.length;
      const facts = JSON.stringify(committed.cases[id]?.video) === JSON.stringify(recorded[id].video);
      let frames = 'identical bytes';
      if (facts && committed.cases[id].sha256 !== recorded[id].sha256) {
        const decode = bytes => recorded[id].video.codec === 'h264'
          ? decodeH264(page, bytes)
          : decodeVideo(bytes);
        const now = await decode(await readFile(join(work, `${id}.${parameters.format}`)));
        const then = await decode(await referenceVideo(committed.cases[id]));
        if (now.length !== recorded[id].video.frames || then.length !== committed.cases[id].video.frames) {
          throw new Error(`${id}: decoded frame counts do not match the recorded container facts`);
        }
        let source;
        if (parameters.annotate) {
          const input = await readFile(await exampleFile(CASES.find(item => item.id === id).example));
          const volume = await readNifti(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength), 'example');
          source = renderedLuma(volume, parseOptions(parameters));
          for (const [k, frame] of now.entries()) {
            const box = labelBox(source[k].fH, source[k].width);
            if (labelPixels(frame.y, source[k].y, box) < 20) drift.push(`${id} (missing slice label)`);
          }
        }
        const worst = Math.min(...now.map((frame, k) => {
          const box = source ? labelBox(source[k].fH, source[k].width) : null;
          return psnr(frame.y, then[k].y, box ? i => !box(i) : undefined);
        }));
        frames = `${worst.toFixed(1)} dB from the recorded frames`;
        if (worst < MATCH_PSNR_DB) drift.push(`${id} (${frames})`);
      }
      if (!facts) drift.push(`${id} (container facts)`);
      console.log(`${drift.length === failuresBefore ? 'PASS' : 'FAIL'} ${id}: ${frames}`);
    }
    if (drift.length) throw new Error(`The web app no longer writes the recorded videos for ${drift.join(', ')}`);
    console.log('PASS the web app still writes every recorded reference video');
  } else {
    await mkdir(referenceDir, { recursive: true });
    for (const [id, entry] of Object.entries(recorded)) {
      await writeFile(join(referenceDir, entry.file), await readFile(join(work, entry.file)));
    }
    await writeFile(referenceJson, `${JSON.stringify(reference, null, 2)}\n`);
    console.log(`Wrote ${fileURLToPath(referenceJson)}`);
  }
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
