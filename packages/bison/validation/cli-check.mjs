#!/usr/bin/env node
// Runs the bison command line on both of the app's pinned examples and holds its files to the web
// app's, recorded in a browser (browser-reference.json, browser-reference.mjs). The labels and the
// mask must be byte for byte the same. The probability maps come from ONNX Runtime's native and
// WebAssembly builds, which add the forest's votes in a different order: on sub-HML0541 they
// differed by at most 4.2e-7 per voxel, so each map's mean must agree within 1e-6.
//
//   node validation/cli-check.mjs [--executable PATH] [--asset-dir DIR]
//
// The model files are held until the BISON authors allow publication, so give --asset-dir (or
// BISON_ASSET_DIR) until then.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { measureOutputs } from './browser-reference.mjs';

const MAXIMUM_MEAN_DIFFERENCE = 1e-6;

const examples = JSON.parse(await readFile(new URL('../../../apps/bison/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const reference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' }, 'asset-dir': { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/bison.js', import.meta.url))];
const assetDir = values['asset-dir'] ?? process.env.BISON_ASSET_DIR;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned(file) {
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-bison-validation', pin.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

const work = await mkdtemp(join(tmpdir(), 'bison-cli-check-'));
try {
  for (const example of examples) {
    const expected = reference[example.id];
    if (!expected) throw new Error(`browser-reference.json has no ${example.id} example.`);
    const args = [];
    for (const file of example.files) args.push(`--${file.role}`, await pinned(file));
    const output = join(work, example.id);
    args.push('--output', output);
    if (assetDir) args.push('--asset-dir', assetDir);
    const run = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
    const report = JSON.parse(run.stdout);
    console.log(`INFO ${example.id}: mode ${report.mode}`);
    check(report.mode === example.id, `${example.id}: mode ${report.mode}`);
    const measured = await measureOutputs(output);
    check(JSON.stringify(Object.keys(measured)) === JSON.stringify(Object.keys(expected)), `${example.id}: outputs ${Object.keys(measured).join(', ')}`);
    for (const [name, browser] of Object.entries(expected)) {
      const cli = measured[name];
      if (!cli) continue;
      if (browser.sum === undefined) {
        check(cli.sha256 === browser.sha256, `${name} byte-identical to the web app's`);
      } else {
        const difference = Math.abs(cli.sum - browser.sum) / browser.voxels;
        check(difference <= MAXIMUM_MEAN_DIFFERENCE, `${name} mean differs by ${difference.toPrecision(3)} <= ${MAXIMUM_MEAN_DIFFERENCE}`);
        console.log(`INFO ${name} byte-identical to the web app's: ${cli.sha256 === browser.sha256}`);
      }
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} BISON command-line checks` : 'PASS BISON command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
