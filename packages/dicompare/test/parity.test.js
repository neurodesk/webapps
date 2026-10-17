import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pythonCalls } from '../scripts/sync-python-calls.mjs';
import { pythonManifest } from '../scripts/sync-python-manifest.mjs';
import { CASES } from '../validation/cases.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../python.manifest.json'));

test('src/python.js is the web worker\'s Python code', async () => {
  const committed = (await read('../src/python.js')).replace(/\r\n/g, '\n');
  assert.equal(committed, await pythonCalls(), 'run node packages/dicompare/scripts/sync-python-calls.mjs');
});

test('python.manifest.json is the offline inventory\'s dicompare Python set', async () => {
  assert.deepEqual(manifest, await pythonManifest(), 'run node packages/dicompare/scripts/sync-python-manifest.mjs');
  assert.equal(manifest.wheels.at(-1).name.split('-')[0], 'dicompare', 'dicompare installs last, after the wheels it requires');
});

test('the npm Pyodide build is the one the web app loads from the CDN', async () => {
  const directory = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));
  for (const file of manifest.core) {
    const bytes = await readFile(join(directory, file.name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.name);
  }
});

test('the wheel is the dicompare release the app pins', async () => {
  const wheel = /^dicompare-([^-]+)-/.exec(manifest.wheels.at(-1).name)[1];
  const version = await read('../../../apps/dicompare/src/version.ts');
  assert.equal(/DICOMPARE_VERSION = '([^']+)'/.exec(version)[1], wheel);
  const embed = await read('../../../apps/dicompare/public/embed/dicompare-worker.js');
  assert.equal(/'dicompare==([^']+)'/.exec(embed)[1], wheel);
});

test('the browser reference covers every validation case', async () => {
  const reference = JSON.parse(await read('../validation/browser-reference.json'));
  assert.deepEqual(Object.keys(reference.reports), CASES.map(({ id }) => id));
  for (const { id, browser } of CASES) {
    assert.equal(reference.reports[id].source.startsWith('browser automation'), Boolean(browser), id);
  }
  assert.ok(reference.pythonAssets.some((url) => url.endsWith(`/${manifest.wheels.at(-1).name}`)), 'the browser installed the pinned dicompare wheel');
});
