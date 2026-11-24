// Records what the web app's pipeline writes in Chromium (browser-reference.json and external masks),
// which the command line's release check (cli-check.mjs) must reproduce.
//
// Builds harness/ with Vite, the way the app is built, serves it cross-origin isolated on loopback
// beside MindGrab's dist files, and runs every case through the app's pipeline and browser
// runtimes with MindGrab on its CPU backend.
//
//   node validation/browser-reference.mjs --output DIR  rewrite JSON and save packed masks outside Git
//   node validation/browser-reference.mjs --check    fail unless the browser still matches them
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { mindgrabFromAssetPath } from '../../../scripts/lib/mindgrab-asset-path-plugin.mjs';
import { downloadModels, MODEL_ASSETS } from '../src/node.js';
import { TEMPLATE_NAMES } from '../src/pipeline.js';
import { CASES, REFERENCE_URL, exampleInput, measureOutputs, packMask, readNifti, referenceMask, sha256, unpackMask } from './cases.mjs';

const { values } = parseArgs({ options: { check: { type: 'boolean' }, output: { type: 'string' } } });
const check = values.check;
const outputDir = resolve(values.output ?? join(tmpdir(), 'neurodesk-deface-reference-output'));
const outputRelative = relative(fileURLToPath(new URL('../../../', import.meta.url)), outputDir);
if (!(outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative))) {
  throw new Error('The mask output directory must be outside the source repository.');
}
const pinned = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));

// MindGrab and niimath as the app resolves them: through @neurodesk/runtime-support.
const runtime = createRequire(createRequire(import.meta.url).resolve('@neurodesk/runtime-support/mindgrab'));
const mindgrabPackage = runtime.resolve('@brainchop/core/package.json');
const mindgrabVersion = JSON.parse(await readFile(mindgrabPackage, 'utf8')).version;
const mindgrabDist = join(mindgrabPackage, '..', 'dist');
const niimathWasm = sha256(await readFile(fileURLToPath(new URL('../../runtime-support/src/niimath/niimath.wasm', import.meta.url))));

const work = await mkdtemp(join(tmpdir(), 'deface-browser-reference-'));
const site = join(work, 'site');
await build({
  root: fileURLToPath(new URL('./harness/', import.meta.url)),
  logLevel: 'warn',
  build: { outDir: site, emptyOutDir: true, target: 'esnext', assetsInlineLimit: 0 },
  worker: { format: 'es', plugins: () => [mindgrabFromAssetPath()] },
});

const example = await exampleInput();
const { directory } = await downloadModels({ cacheDir: join(tmpdir(), 'neurodesk-deface-validation', 'templates') });
const asset = async (name) => readFile(join(directory, MODEL_ASSETS.find(({ filename }) => filename === name).filename));
const inputs = new Map([
  ['example', example.bytes],
  ['template', await asset(TEMPLATE_NAMES.template)],
  ['mask', await asset(TEMPLATE_NAMES.mask)],
]);
const results = new Map();
const roots = { '/mindgrab/': mindgrabDist, '/': site };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (request.method === 'POST' && path.startsWith('/result/')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    results.set(path.slice('/result/'.length), new Uint8Array(Buffer.concat(chunks)));
    response.end();
    return;
  }
  let body = path.startsWith('/input/') ? inputs.get(path.slice('/input/'.length)) : undefined;
  const root = Object.keys(roots).find((prefix) => path.startsWith(prefix));
  if (!body && root) {
    const file = normalize(join(roots[root], path === '/' ? 'index.html' : path.slice(root.length)));
    if (file.startsWith(roots[root])) body = await readFile(file).catch(() => undefined);
  }
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extname(path)] ?? (path === '/' ? 'text/html' : 'application/octet-stream'));
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const reference = {
  browser: `chromium ${browser.version()}`,
  mindgrab: mindgrabVersion,
  niimathWasmSha256: niimathWasm,
  backend: 'cpu',
  example: { name: example.name, sha256: sha256(example.bytes) },
  cases: {},
};
const masks = new Map();
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => typeof globalThis.runCase === 'function');
  if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('The reference page is not cross-origin isolated.');
  for (const item of CASES) {
    const started = Date.now();
    const report = await page.evaluate((request) => globalThis.runCase(request), item);
    const seconds = (Date.now() - started) / 1000;
    if (report.provenance.mindgrab && report.provenance.mindgrab.backend !== 'cpu') throw new Error(`${item.id} ran on ${report.provenance.mindgrab.backend}, not the CPU backend.`);
    const files = new Map(report.files.map((name) => [name, results.get(`${item.id}/${name}`)]));
    reference.cases[item.id] = { method: item.method, seconds, ...measureOutputs(files) };
    if (files.has('brain-mask.nii')) masks.set(item.id, readNifti(files.get('brain-mask.nii')).values);
    console.log(`${item.id} (${seconds} s): ${JSON.stringify(reference.cases[item.id].sha256)}`);
  }
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}

if (check) {
  const failures = [];
  for (const key of ['mindgrab', 'niimathWasmSha256', 'example']) {
    if (JSON.stringify(reference[key]) !== JSON.stringify(pinned[key])) failures.push(`${key} ${JSON.stringify(reference[key])} is installed but ${JSON.stringify(pinned[key])} is pinned`);
  }
  for (const [id, measured] of Object.entries(reference.cases)) {
    const { seconds: _seconds, ...now } = measured;
    const { seconds: _pinnedSeconds, maskReference: _maskReference, ...then } = pinned.cases[id] ?? {};
    const same = JSON.stringify(now) === JSON.stringify(then);
    console.log(`${same ? 'PASS' : 'FAIL'} browser ${id}: outputs identical to browser-reference.json`);
    if (!same) failures.push(`${id}: ${JSON.stringify(now.sha256)} differs from ${JSON.stringify(then.sha256)}`);
    if (masks.has(id)) {
      const values = masks.get(id);
      const recorded = unpackMask(await referenceMask(pinned.cases[id].maskReference), values.length);
      const identical = values.every((value, i) => (value !== 0) === (recorded[i] === 1));
      console.log(`${identical ? 'PASS' : 'FAIL'} browser ${id}: mask identical to the pinned dataset reference`);
      if (!identical) failures.push(`${id}: mask differs from the pinned dataset reference`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
} else {
  await mkdir(outputDir, { recursive: true });
  for (const [id, values] of masks) {
    const bytes = packMask(values);
    const pin = { file: `${id}.mask.gz`, bytes: bytes.length, sha256: sha256(bytes) };
    const previous = pinned.cases[id]?.maskReference;
    if (previous?.sha256 === pin.sha256 && previous.bytes === pin.bytes) pin.url = previous.url;
    reference.cases[id].maskReference = pin;
    await writeFile(join(outputDir, pin.file), bytes);
  }
  await writeFile(REFERENCE_URL, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`Wrote ${fileURLToPath(REFERENCE_URL)} and packed masks in ${outputDir}. Upload changed masks and pin their dataset URLs before validating.`);
}
