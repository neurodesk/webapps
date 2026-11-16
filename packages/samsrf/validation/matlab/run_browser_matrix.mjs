#!/usr/bin/env node
// Runs cli_plan.py's matrix in Chromium through the web app's own engine module
// (apps/samsrf/src/engine.js: createJob, runShard, mergeShards), from the bundle's file
// bytes as the app reads dropped files. Writes run_web_matrix.mjs's layout, so
// compare_web_cli.py reads either: per run <id>.web.json, the downloaded GIfTIs and
// maps.f64, the double map rows of the app's own createJob spec run in the page.
//
// Usage: node run_browser_matrix.mjs PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT
//
// The app has no subject-HRF file route, so runs whose model names an hrf_*.mat are
// written as `unsupported` with the engine's message. They are not agreement.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { webRun } from './run_web_matrix.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json' };

const PAGE = `<!doctype html><meta charset="utf-8"><title>SamSrf matrix</title>
<script type="importmap">{"imports":{
"@neurodesk/samsrf":"/repo/packages/samsrf/src/index.js",
"@neurodesk/samsrf/inputs":"/repo/packages/samsrf/src/inputs.js"}}</script>
<script type="module">
import * as engine from '/repo/apps/samsrf/src/engine.js';
import { createJob, init } from '@neurodesk/samsrf';
const bytes = async (path) => new Uint8Array(await (await fetch(path)).arrayBuffer());
const named = async (file) => file && { name: file.name, bytes: await bytes(file.url) };
window.runCase = async (request) => {
  const surfaces = {};
  for (const [role, file] of Object.entries(request.surfaces)) surfaces[role] = await named(file);
  const inputs = {
    analysis: request.analysis, model: request.model,
    runs: await Promise.all(request.runs.map(named)),
    apertures: await named(request.apertures), roi: await named(request.roi),
    template: await named(request.template), seed: await named(request.seed),
    surfaces, normalise: true, average: request.average,
  };
  const job = await engine.createJob(inputs);
  const shard = await engine.runShard(job, 0, job.units, () => {});
  const result = await engine.mergeShards(job, [shard]);
  // The double map rows of the same spec, as the app's worker holds them before export.
  await init();
  const handle = createJob(job.spec);
  let maps;
  try { maps = handle.merge([handle.run(0, handle.vertexCount)]).maps; } finally { handle.free(); }
  const hex = (array) => Array.from(array, (value) => value.toString(16).padStart(2, '0')).join('');
  return {
    outName: result.outName, summary: job.summary,
    files: result.files.map(({ name, bytes }) => ({ name, hex: hex(bytes) })),
    values: maps.values, vertices: maps.vertices,
    data: hex(new Uint8Array(Float64Array.from(maps.data).buffer)),
  };
};
window.ready = true;
</script>`;

function serve(bundle) {
  const server = createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
      return;
    }
    const [root, prefix] = url.startsWith('/repo/') ? [repo, '/repo/'] : url.startsWith('/bundle/') ? [bundle, '/bundle/'] : [null, null];
    const path = root && normalize(join(root, url.slice(prefix.length)));
    if (!path || relative(root, path).startsWith('..') || !existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    response.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(run, bundle) {
  const { algorithm, options, model } = webRun(run, bundle);
  const file = (path) => path && { name: path.split(sep).pop(), url: `/bundle/${relative(bundle, path).split(sep).join('/')}` };
  const hemisphere = options.hemisphere;
  return {
    analysis: algorithm,
    model,
    runs: options.runs.map(file),
    apertures: file(options.apertures),
    roi: file(options.roi),
    template: file(options.template),
    seed: file(options.seed),
    surfaces: algorithm === 'cf' ? { area: { ...file(options.area), name: `${hemisphere}.area` }, white: { ...file(options.white), name: `${hemisphere}.white` } } : {},
    average: options.combine === 'average',
  };
}

async function main([planPath, bundle, manifestPath, output, ...rest]) {
  if (!output || rest.length) throw new Error('Usage: node run_browser_matrix.mjs PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT');
  if (existsSync(output)) throw new Error(`${output} must not exist`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [path, hash] of Object.entries(manifest)) {
    if (sha256(readFileSync(join(bundle, path))) !== hash) throw new Error(`The bundle differs from its recorded SHA-256 hashes: ${path}`);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  mkdirSync(output);
  const server = await serve(bundle);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true);
    const environment = {
      engine: 'web app engine module (apps/samsrf/src/engine.js) in Chromium',
      browser: `chromium ${browser.version()}`,
      userAgent: await page.evaluate(() => navigator.userAgent),
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      packageVersion: JSON.parse(readFileSync(join(repo, 'packages/samsrf/package.json'), 'utf8')).version,
      wasmSha256: sha256(readFileSync(join(repo, 'packages/samsrf/wasm/samsrf_wasm_bg.wasm'))),
      engineSha256: sha256(readFileSync(join(repo, 'apps/samsrf/src/engine.js'))),
      threads: 1,
      planSha256: sha256(readFileSync(planPath)),
      bundleSha256: sha256(readFileSync(manifestPath)),
    };
    writeFileSync(join(output, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
    const runs = [];
    for (const run of plan.runs) {
      const started = performance.now();
      const record = { id: run.id, precision: run.precision, algorithm: run.algorithm };
      try {
        const result = await page.evaluate((item) => window.runCase(item), request(run, bundle));
        const directory = join(output, run.id);
        mkdirSync(directory);
        for (const { name, hex } of result.files) writeFileSync(join(directory, name), Buffer.from(hex, 'hex'));
        const data = Buffer.from(result.data, 'hex');
        writeFileSync(join(directory, 'maps.f64'), data);
        Object.assign(record, { status: 'succeeded', prefix: result.outName, values: result.values, vertices: result.vertices, summary: result.summary, mapsSha256: sha256(data) });
      } catch (error) {
        const message = error.message.replace(/^page\.evaluate: (Error: )?/, '').split('\n')[0];
        record.status = /is not supported by this port/.test(message) ? 'refused'
          : typeof run.model.Hrf === 'string' && run.model.Hrf.startsWith('hrf_') ? 'unsupported' : 'failed';
        record.message = message;
      }
      record.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
      runs.push(record);
      writeFileSync(join(output, `${run.id}.web.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${record.status.padEnd(11)} ${run.id} ${record.seconds} s${record.message ? `: ${record.message}` : ''}`);
    }
    if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
    writeFileSync(join(output, 'runs.json'), `${JSON.stringify(runs.map(({ id, status, message, seconds, mapsSha256 }) => ({ id, status, message, seconds, mapsSha256 })), null, 2)}\n`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main(process.argv.slice(2));
