#!/usr/bin/env node
// Records the web app's reports for the example in Chromium, through the app's own automation
// (apps/dicompare/src/automation.ts), into browser-reference.json. cli-check.mjs holds every
// command-line report to these bytes. Build the app first: pnpm --filter dicompare build.
//
//   node packages/dicompare/validation/browser-reference.mjs
//
// The deployed app installs Pyodide from jsDelivr and dicompare from PyPI; the recorder lists the
// wheels the browser fetched so the reference names the Python packages it was made with.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { CASES, EXAMPLE, LIBRARY_SCHEMA } from './cases.mjs';
import { exampleDirectory } from './example.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const site = join(repository, 'apps/dicompare/dist');
const bin = fileURLToPath(new URL('../bin/dicompare.js', import.meta.url));
const output = fileURLToPath(new URL('./browser-reference.json', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function siteFile(path) {
  if (!path.startsWith('/dicompare/')) throw new Error('Outside site');
  const file = resolve(site, `.${path.slice('/dicompare'.length).replace(/\/$/, '/index.html')}`);
  const child = relative(site, file);
  if (child === '..' || child.startsWith(`..${sep}`)) throw new Error('Outside site');
  return file;
}

async function serve() {
  const server = createServer(async (request, response) => {
    try {
      const file = siteFile(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      const info = await stat(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return server;
}

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

async function runInBrowser(context, url, { dicom, schema, operation, artifact }) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    await page.locator('#neurodesk-input-transfer').setInputFiles(dicom);
    await dispatch(page, 'adopt', { role: 'dicom' });
    if (schema) {
      await page.locator('#neurodesk-input-transfer').setInputFiles(schema);
      await dispatch(page, 'adopt', { role: 'schema' });
    }
    await dispatch(page, 'start', { operation, parameters: schema ? { schemaIndex: 0 } : {} });
    let snapshot;
    const deadline = performance.now() + 600_000;
    do {
      await new Promise((accept) => setTimeout(accept, 500));
      snapshot = await dispatch(page, 'snapshot');
      if (performance.now() >= deadline) throw new Error(`${operation} exceeded 10 minutes`);
    } while (!/succeeded|failed/.test(snapshot.state));
    assert.equal(snapshot.state, 'succeeded', JSON.stringify({ snapshot, errors }));
    const downloading = page.waitForEvent('download');
    await dispatch(page, 'download', { artifactId: artifact });
    const download = await downloading;
    assert.equal(download.suggestedFilename(), `${artifact}.json`);
    const bytes = await readFile(await download.path());
    assert.equal(sha256(bytes), snapshot.report.artifacts[artifact].sha256);
    assert.equal(errors.length, 0, errors.join('\n'));
    return bytes;
  } finally {
    await page.close();
  }
}

function buildSchemaWithCommandLine(directory, work) {
  const path = join(work, 'schema.json');
  const run = spawnSync(process.execPath, [bin, 'build-schema', directory, '--output', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status !== 0) throw new Error(`build-schema failed:\n${run.stderr}`);
  return path;
}

const { directory, names } = await exampleDirectory(EXAMPLE);
const dicom = names.map((name) => join(directory, name));
const work = await mkdtemp(join(tmpdir(), 'dicompare-browser-reference-'));
const server = await serve();
const browserHome = await mkdtemp(join(tmpdir(), 'dicompare-browser-home-'));
let browser;
try {
  const env = { ...process.env };
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = browserHome;
  browser = await chromium.launch({ headless: true, env });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route(/cloudflareinsights\.com|googletagmanager\.com|google-analytics\.com/, (route) => route.fulfill({ body: '' }));
  const fetched = new Set();
  context.on('request', (request) => {
    const url = request.url();
    if (/\.(whl|zip|wasm)$|pyodide-lock\.json$|pyodide\.asm\.js$/.test(url)) fetched.add(url);
  });
  const url = `http://127.0.0.1:${server.address().port}/dicompare/`;
  const builtSchema = buildSchemaWithCommandLine(directory, work);
  const schemas = {
    library: join(repository, 'apps/dicompare/public/schemas', `${LIBRARY_SCHEMA}.json`),
    'build-schema': builtSchema,
  };
  const reports = {};
  for (const { id, browser: operation } of CASES) {
    let bytes;
    let source;
    if (operation) {
      const schema = operation.schema && schemas[operation.schema];
      bytes = await runInBrowser(context, url, { dicom, schema, operation: operation.operation, artifact: operation.artifact });
      source = `browser automation ${operation.operation}`;
    } else {
      bytes = await readFile(builtSchema);
      source = 'in-repository command line (the app has no schema automation)';
    }
    reports[id] = { source, sha256: sha256(bytes), report: JSON.parse(bytes.toString('utf8')) };
    console.log(`${id}: ${reports[id].sha256} from ${source}`);
  }
  const app = JSON.parse(await readFile(join(repository, 'apps/dicompare/package.json'), 'utf8'));
  const reference = {
    example: EXAMPLE,
    app: app.version,
    chromium: browser.version(),
    pythonAssets: [...fetched].filter((asset) => !asset.startsWith('http://127.0.0.1')).sort(),
    reports,
  };
  await writeFile(output, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await new Promise((accept) => server.close(accept));
  await rm(work, { recursive: true, force: true });
  await rm(browserHome, { recursive: true, force: true });
}
