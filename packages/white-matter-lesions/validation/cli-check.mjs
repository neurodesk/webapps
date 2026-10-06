#!/usr/bin/env node
// Runs a flames command line on the app's pinned example, with one fold and with the five-fold
// ensemble. Each run is held to the web app's results recorded in a browser
// (apps/white-matter-lesions/validation/browser-reference.json). The one-fold run is also compared
// voxel by voxel with the web app's worker path (web-reference.mjs: the same pipeline on ONNX
// Runtime Web's WebAssembly backend), which checks the native runtime against the browser's.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readVolume } from '@neurodesk/synthsr';
import { compareWithBrowser, measure } from '../../../apps/white-matter-lesions/validation/browser-reference.mjs';
import { FLAMES_FOLDS } from '../src/assets.js';
import { labelLesions, lesionTable } from '../src/pipeline.js';
import { outputNames } from '../src/results.js';
import { webReference } from './web-reference.mjs';

// apps/white-matter-lesions/validation/README.md, "Port checks": the port on ONNX Runtime Web
// agreed with reference.py on ONNX Runtime at Dice 0.998, a difference from float rounding
// between runtimes. The command line and the web app differ in exactly that way.
const MINIMUM_DICE = 0.998;
// The native and WebAssembly probability maps differed by at most 0.0362 on linux-x64,
// windows-x64 and macos-arm64 alike (PR #158). The bound allows under three times that.
const MAXIMUM_PROBABILITY_DIFFERENCE = 0.1;

const examples = JSON.parse(await readFile(new URL('../../../apps/white-matter-lesions/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/flames.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const volume = (bytes) => readVolume(arrayBuffer(bytes));
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinnedExample() {
  const [file] = examples[0].files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-flames-validation', pin.sha256, file.name);
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

async function files(directory) {
  const map = new Map();
  for (const name of (await readdir(directory)).sort()) map.set(name, await readFile(join(directory, name)));
  return map;
}

// Runs the command line, then checks its files against the browser's recorded results.
async function segment(input, output, names, folds) {
  const run = spawnSync(command[0], [...command.slice(1), input, output, '--folds', String(folds)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  console.log(`INFO --folds ${folds}`);
  check(report.provenance.executionProvider === 'cpu', `executionProvider ${report.provenance.executionProvider}, ${report.provenance.threads} threads, ONNX Runtime ${report.provenance.onnxruntime}, ${report.provenance.seconds} s`);
  const models = report.provenance.models.map(({ sha256: digest }) => digest);
  const expected = FLAMES_FOLDS.slice(0, folds).map(({ sha256: digest }) => digest);
  check(JSON.stringify(models) === JSON.stringify(expected), `models ${report.provenance.models.map(({ file }) => file).join(', ')}`);
  const cli = await files(output);
  check(JSON.stringify([...cli.keys()]) === JSON.stringify(Object.values(names).sort()), `outputs ${[...cli.keys()].join(', ')}`);
  const measured = measure({
    mask: volume(cli.get(names.mask)),
    probability: volume(cli.get(names.probability)),
    lesions: report.count,
    totalMl: report.totalMl,
  });
  for (const [passed, line] of compareWithBrowser(measured, folds)) check(passed, line);
  return cli;
}

function compareWithWorker(names, cli, web) {
  const cliMask = volume(cli.get(names.mask));
  const webMask = volume(web.get(names.mask));
  for (const name of [names.mask, names.probability]) {
    check(cli.get(name).subarray(0, 352).equals(web.get(name).subarray(0, 352)), `${name} NIfTI header identical to the web app's`);
  }
  let cliVoxels = 0;
  let webVoxels = 0;
  let both = 0;
  for (let i = 0; i < cliMask.data.length; i++) {
    const inCli = cliMask.data[i] !== 0;
    const inWeb = webMask.data[i] !== 0;
    cliVoxels += inCli;
    webVoxels += inWeb;
    both += inCli && inWeb;
  }
  const dice = (2 * both) / (cliVoxels + webVoxels);
  const differing = cliVoxels + webVoxels - 2 * both;
  check(dice >= MINIMUM_DICE, `${names.mask} Dice ${dice.toFixed(5)} >= ${MINIMUM_DICE} (${differing} of ${cliVoxels} voxels differ; web ${webVoxels})`);
  const cliProbability = volume(cli.get(names.probability)).data;
  const webProbability = volume(web.get(names.probability)).data;
  let largest = 0;
  for (let i = 0; i < cliProbability.length; i++) largest = Math.max(largest, Math.abs(cliProbability[i] - webProbability[i]));
  check(largest <= MAXIMUM_PROBABILITY_DIFFERENCE, `${names.probability} max |CLI - web| ${largest.toPrecision(3)} <= ${MAXIMUM_PROBABILITY_DIFFERENCE}`);
  const table = lesionTable(labelLesions(cliMask.data, cliMask.dims).lesions, cliMask.affine);
  check(cli.get(names.table).toString('utf8') === table.tsv, `${names.table} is the web app's table of the CLI mask`);
  for (const name of Object.values(names)) {
    console.log(`INFO ${name} byte-identical to the web app's: ${cli.get(name).equals(web.get(name))}`);
  }
}

const work = await mkdtemp(join(tmpdir(), 'flames-cli-check-'));
try {
  const input = await pinnedExample();
  const names = outputNames('MSLesSeg_P57_T1_FLAIR.nii.gz');
  const cli = await segment(input, join(work, 'cli'), names, 1);
  const reference = join(work, 'web');
  await webReference({ input, output: reference });
  compareWithWorker(names, cli, await files(reference));
  await segment(input, join(work, 'cli-ensemble'), names, 5);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} FLAMeS command-line checks` : 'PASS FLAMeS command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
