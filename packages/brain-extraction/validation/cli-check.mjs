#!/usr/bin/env node
// Runs a brain-extraction command line on the app's pinned T1 example with each shipped method
// and holds its files to the web app's results recorded in a browser
// (apps/brain-extraction/validation/browser-reference.json): NIfTI headers, mask voxels, Dice and
// brain intensities. The browser ran QSMbly's threaded BET bundle, ONNX Runtime Web and MindGrab's
// CPU modules on browser Workers, not the command line's bet.wasm, native ONNX Runtime and Node
// worker threads. A SynthStrip mask that is not the browser's bit for bit gets its Dice against
// web-reference.mjs, after that reference reproduces the browser's mask exactly.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readVolume } from '@neurodesk/synthsr';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';
import { browserReference, compareWithBrowser, dice, measure } from '../../../apps/brain-extraction/validation/browser-reference.mjs';
import { outputNames } from '../src/outputs.js';
import { webReference } from './web-reference.mjs';

const METHODS = ['bet', 'synthstrip', 'mindgrab'];
const examples = JSON.parse(await readFile(new URL('../../../apps/brain-extraction/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/brain-extraction.js', import.meta.url))];

// The release check runs with an empty home that must stay empty, so downloads go under the temporary directory.
const cache = join(tmpdir(), 'neurodesk-brain-extraction-validation');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const volume = (bytes) => readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinnedExample() {
  const example = examples.find(({ id }) => id === browserReference.example);
  const [file] = example.files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(cache, pin.sha256, file.name);
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

function extract(input, output, method) {
  const run = spawnSync(command[0], [...command.slice(1), input, output, '--method', method], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} --method ${method} exited with ${run.status}:\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

async function files(directory) {
  const map = new Map();
  for (const name of (await readdir(directory)).sort()) map.set(name, await readFile(join(directory, name)));
  return map;
}

// The brain image must be the input inside the mask, whatever the mask is.
function checkBrainIsInput(input, names, outputs, background) {
  const original = volume(input).data;
  const brain = volume(outputs.get(names.brain)).data;
  const mask = volume(outputs.get(names.mask)).data;
  let differing = 0;
  for (let i = 0; i < brain.length; i++) differing += brain[i] !== (mask[i] ? Math.fround(original[i]) : background);
  check(differing === 0, `${names.brain} is the input inside the mask and ${background} outside (${differing} voxels differ)`);
}

let reference;
async function browserMask(input, work, names) {
  reference ??= await webReference({ input, output: join(work, 'web'), cacheDir: join(cache, 'models') }).then(() => files(join(work, 'web')));
  const mask = reference.get(names.mask);
  const maskSha256 = measure({ brain: reference.get(names.brain), mask }).maskSha256;
  check(maskSha256 === browserReference.methods.synthstrip.maskSha256, `web-reference.mjs reproduces the browser's SynthStrip mask bit for bit (${maskSha256.slice(0, 16)})`);
  return volume(mask).data;
}

const work = await mkdtemp(join(tmpdir(), 'brain-extraction-cli-check-'));
try {
  const inputPath = await pinnedExample();
  const input = await readFile(inputPath);
  const inputName = examples.find(({ id }) => id === browserReference.example).files[0].name;
  for (const method of METHODS) {
    const expected = browserReference.methods[method];
    const names = outputNames(inputName, method);
    const output = join(work, method);
    const report = extract(inputPath, output, method);
    console.log(`INFO --method ${method}: ${report.provenance.seconds} s, ${JSON.stringify(report.provenance)}`);
    check(report.provenance.method === method, `provenance names method ${report.provenance.method}`);
    if (method === 'synthstrip') check(report.provenance.modelHash === SYNTHSTRIP_MODEL.sha256, `SynthStrip model ${report.provenance.modelHash}`);
    if (method === 'bet') check(report.provenance.fractionalIntensity === 0.5, `BET fractional intensity ${report.provenance.fractionalIntensity}, the web app's default`);
    if (method === 'mindgrab') check(report.provenance.version === expected.version && report.provenance.model === 'mindgrab' && report.provenance.backend === 'cpu', `MindGrab ${report.provenance.version} model ${report.provenance.model} on the ${report.provenance.backend} backend, browser ${expected.version} mindgrab on cpu`);
    const outputs = await files(output);
    check(JSON.stringify([...outputs.keys()]) === JSON.stringify([names.brain, names.mask].sort()), `outputs ${[...outputs.keys()].join(', ')}`);
    if (!outputs.has(names.brain) || !outputs.has(names.mask)) continue;
    const measured = measure({ brain: outputs.get(names.brain), mask: outputs.get(names.mask) });
    check(report.maskVoxels === measured.maskVoxels, `reported ${report.maskVoxels} mask voxels, written ${measured.maskVoxels}`);
    for (const [passed, line] of compareWithBrowser(measured, method)) check(passed, line);
    checkBrainIsInput(input, names, outputs, expected.background);
    const { minimumDice } = expected.tolerance;
    if (measured.maskSha256 === expected.maskSha256) {
      check(true, `${names.mask} Dice 1 with the browser's mask: identical (${measured.maskSha256.slice(0, 16)})`);
    } else if (minimumDice < 1) {
      const { dice: overlap, differing } = dice(volume(outputs.get(names.mask)).data, await browserMask(inputPath, work, names));
      check(overlap >= minimumDice, `${names.mask} Dice ${overlap.toFixed(6)} >= ${minimumDice} with the browser's mask (${differing} voxels differ)`);
    } else {
      check(false, `${names.mask} differs from the browser's mask (${measured.maskSha256.slice(0, 16)}, browser ${expected.maskSha256.slice(0, 16)})`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} brain-extraction command-line checks` : 'PASS brain-extraction command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
