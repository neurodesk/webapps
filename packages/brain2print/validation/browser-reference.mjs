// Records what the web app's pipeline writes in Chromium (browser-reference.json), which the
// command line's release check (cli-check.mjs) must reproduce.
//
// Builds harness/ with Vite, the way the app is built, and serves it cross-origin isolated on
// loopback beside MindGrab's dist files, then runs every case through the app's pipeline and
// browser runtimes with MindGrab on its CPU backend.
//
//   node validation/browser-reference.mjs            rewrite browser-reference.json
//   node validation/browser-reference.mjs --check    fail unless the browser still matches it
//   ... --only small-pve-smooth5                     restrict the cases
import { chromium } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { CASES, REFERENCE_URL, caseInput } from './cases.mjs';
import { compareOutputs, measureOutputs } from './measure.mjs';

const check = process.argv.includes('--check');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(',')) : null;
const selected = CASES.filter(({ id }) => !only || only.has(id));

const require = createRequire(import.meta.url);
const mindgrabVersion = require('@brainchop/mindgrab/package.json').version;
const niimathVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies['@niivue/niimath'];
const mindgrabDist = join(require.resolve('@brainchop/mindgrab/package.json'), '..', 'dist');

const work = await mkdtemp(join(tmpdir(), 'brain2print-browser-reference-'));
const site = join(work, 'site');
await build({
  root: fileURLToPath(new URL('./harness/', import.meta.url)),
  logLevel: 'warn',
  build: { outDir: site, emptyOutDir: true, target: 'esnext', assetsInlineLimit: 0 },
  // As in the app: MindGrab loads its modules from assetPath, not from a bundled copy.
  worker: { format: 'es', rollupOptions: { external: [/^\.\/brainchop-[\w-]+\.js$/] } },
  optimizeDeps: { exclude: ['@niivue/niimath'] },
});

const inputs = new Map();
for (const item of selected) {
  const { name, bytes } = await caseInput(item.input);
  inputs.set(name, bytes);
  item.inputName = name;
}
const results = new Map();
const roots = { '/brainchop/': mindgrabDist, '/': site };
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
  niimath: niimathVersion,
  backend: 'cpu',
  cases: {},
};
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => typeof globalThis.runCase === 'function');
  if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('The reference page is not cross-origin isolated.');
  for (const item of selected) {
    const started = Date.now();
    const report = await page.evaluate((request) => globalThis.runCase(request), { id: item.id, input: item.inputName, settings: item.settings });
    const seconds = (Date.now() - started) / 1000;
    if (report.provenance.segmentation.backend !== 'cpu') throw new Error(`${item.id} ran on ${report.provenance.segmentation.backend}, not the CPU backend.`);
    const files = new Map(report.files.map((name) => [name, results.get(`${item.id}/${name}`)]));
    reference.cases[item.id] = {
      input: item.input,
      inputName: item.inputName,
      settings: item.settings,
      seconds,
      report: { measurements: report.measurements, meshing: report.provenance.meshing },
      ...measureOutputs(files),
    };
    console.log(`${item.id} (${seconds} s): ${report.measurements.triangles} triangles, ${JSON.stringify(reference.cases[item.id].sha256)}`);
  }
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}

if (check) {
  const pinned = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));
  const failures = [];
  for (const tool of ['mindgrab', 'niimath']) {
    if (reference[tool] !== pinned[tool]) failures.push(`${tool} ${reference[tool]} is installed but ${pinned[tool]} is pinned`);
  }
  for (const [id, measured] of Object.entries(reference.cases)) {
    for (const [passed, line] of compareOutputs(measured, pinned.cases[id])) {
      console.log(`${passed ? 'PASS' : 'FAIL'} browser ${id}: ${line}`);
      if (!passed) failures.push(`${id}: ${line}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
} else {
  const previous = JSON.parse(await readFile(REFERENCE_URL, 'utf8').catch(() => '{}'));
  const kept = previous.mindgrab === reference.mindgrab && previous.niimath === reference.niimath ? previous.cases : {};
  reference.cases = Object.fromEntries(CASES.map(({ id }) => [id, reference.cases[id] ?? kept[id]]).filter(([, value]) => value));
  await writeFile(REFERENCE_URL, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`Wrote ${fileURLToPath(REFERENCE_URL)}`);
}
