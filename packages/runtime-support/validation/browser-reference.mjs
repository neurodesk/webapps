// Records the browser outputs that the Node drivers must reproduce.
//
// Serves the pinned @brainchop/mindgrab and @niivue/niimath builds from a
// cross-origin isolated loopback page and runs every case in Chromium: MindGrab
// through the published wrapper's own CPU backend (segment / segmentTissues in
// its module worker), niimath through callMain on the browser's WebAssembly.
//
//   node validation/browser-reference.mjs            rewrite reference.json
//   node validation/browser-reference.mjs --check    fail unless the browser still matches it
//   ... --only mindgrab-mask,smooth                   restrict the cases

import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINDGRAB_CASES, MINDGRAB_INPUT, NIIMATH_CASES, REFERENCE_URL, niimathInputs, pinnedFile, sha256 } from './cases.mjs';

const check = process.argv.includes('--check');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(',')) : null;
const selected = cases => cases.filter(item => !only || only.has(item.id));

const require = createRequire(import.meta.url);
const mindgrabPackage = require.resolve('@brainchop/mindgrab/package.json');
// @niivue/niimath exports niimath.js but not its package.json.
const niimathDist = dirname(require.resolve('@niivue/niimath/niimath.js'));
const niimathVersion = JSON.parse(await readFile(join(niimathDist, '..', 'package.json'), 'utf8')).version;
const roots = {
  '/mindgrab/': join(mindgrabPackage, '..', 'dist'),
  '/niimath/': niimathDist,
};
const files = new Map(Object.entries(niimathInputs()).map(([name, bytes]) => [`/input/${name}`, bytes]));
files.set(`/input/${MINDGRAB_INPUT.name}`, await pinnedFile(MINDGRAB_INPUT));
const results = new Map();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'POST' && path.startsWith('/result/')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    results.set(path.slice('/result/'.length), new Uint8Array(Buffer.concat(chunks)));
    response.end();
    return;
  }
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Node driver reference</title>');
    return;
  }
  let body = files.get(path);
  const root = Object.keys(roots).find(prefix => path.startsWith(prefix));
  if (!body && root) {
    const file = normalize(join(roots[root], path.slice(root.length)));
    if (file.startsWith(roots[root])) body = await readFile(file).catch(() => undefined);
  }
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const reference = {
  browser: `chromium ${browser.version()}`,
  mindgrab: { package: '@brainchop/mindgrab', version: require('@brainchop/mindgrab/package.json').version, input: MINDGRAB_INPUT, cases: {} },
  niimath: { package: '@niivue/niimath', version: niimathVersion, cases: {} },
};
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('The reference page is not cross-origin isolated.');

  for (const item of selected(NIIMATH_CASES)) {
    const code = await page.evaluate(async ({ id, args }) => {
      const { default: createModule } = await import('/niimath/niimath.js');
      const module = await createModule({ noInitialRun: true, thisProgram: 'niimath', print() {}, printErr() {} });
      for (const name of ['in.nii', 'mask.nii']) {
        module.FS_createDataFile('/', name, new Uint8Array(await (await fetch(`/input/${name}`)).arrayBuffer()), true, true);
      }
      let status;
      try {
        status = module.callMain(args);
      } catch (error) {
        status = error.status;
      }
      if (status === 0) await fetch(`/result/${id}`, { method: 'POST', body: module.FS_readFile('out.nii.gz') });
      return status;
    }, item);
    if (code !== 0) throw new Error(`niimath ${item.id} exited with ${code} in the browser.`);
    reference.niimath.cases[item.id] = { args: item.args, outputs: { 'out.nii.gz': sha256(results.get(item.id)) } };
    console.log(`niimath ${item.id}: ${reference.niimath.cases[item.id].outputs['out.nii.gz']}`);
  }

  for (const item of selected(MINDGRAB_CASES)) {
    const started = Date.now();
    const outputs = await page.evaluate(async ({ id, call, options, input }) => {
      const mindgrab = await import('/mindgrab/index.js');
      const bytes = await (await fetch(`/input/${input}`)).arrayBuffer();
      const result = await mindgrab[call](bytes, { ...options, backend: 'cpu', worker: true, gzipOutput: false });
      const named = { ...(result.image ? { image: result.image } : {}), ...(result.mask ? { mask: result.mask } : {}), ...(result.tissues ?? {}) };
      for (const [name, data] of Object.entries(named)) {
        await fetch(`/result/${id}/${name}`, { method: 'POST', body: data });
      }
      return Object.keys(named);
    }, { ...item, input: MINDGRAB_INPUT.name });
    const digests = Object.fromEntries(outputs.map(name => [name, sha256(results.get(`${item.id}/${name}`))]));
    const seconds = (Date.now() - started) / 1000;
    reference.mindgrab.cases[item.id] = { call: item.call, options: item.options, seconds, outputs: digests };
    console.log(`mindgrab ${item.id} (${seconds} s): ${JSON.stringify(digests)}`);
  }
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

if (check) {
  const pinned = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));
  const failures = [];
  for (const tool of ['niimath', 'mindgrab']) {
    if (reference[tool].version !== pinned[tool].version) failures.push(`${tool} ${reference[tool].version} is installed but ${pinned[tool].version} is pinned`);
    for (const [id, entry] of Object.entries(reference[tool].cases)) {
      for (const [name, digest] of Object.entries(entry.outputs)) {
        const expected = pinned[tool].cases[id]?.outputs[name];
        console.log(`${digest === expected ? 'PASS' : 'FAIL'} browser ${tool} ${id} ${name}`);
        if (digest !== expected) failures.push(`${tool} ${id} ${name}: browser ${digest}, pinned ${expected}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
} else {
  const previous = JSON.parse(await readFile(REFERENCE_URL, 'utf8').catch(() => '{}'));
  for (const tool of ['niimath', 'mindgrab']) {
    reference[tool].cases = { ...(previous[tool]?.version === reference[tool].version ? previous[tool].cases : {}), ...reference[tool].cases };
  }
  await writeFile(REFERENCE_URL, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`Wrote ${fileURLToPath(REFERENCE_URL)}`);
}
