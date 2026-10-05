#!/usr/bin/env node
// Runs a flames command line on the app's pinned example and compares its files with the web
// app's worker path (web-reference.mjs: the same pipeline on ONNX Runtime Web's WebAssembly backend).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readVolume } from '@neurodesk/synthsr';
import { FLAMES_FOLDS } from '../src/assets.js';
import { labelLesions, lesionTable } from '../src/pipeline.js';
import { outputNames } from '../src/results.js';
import { webReference } from './web-reference.mjs';

// apps/white-matter-lesions/validation/README.md, "Port checks": the port on ONNX Runtime Web
// agreed with reference.py on ONNX Runtime at Dice 0.998, a difference from float rounding
// between runtimes. The command line and the web app differ in exactly that way.
const MINIMUM_DICE = 0.998;

const examples = JSON.parse(await readFile(new URL('../../../apps/white-matter-lesions/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/flames.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

function compare(names, cli, web) {
  const cliMask = readVolume(arrayBuffer(cli.get(names.mask)));
  const webMask = readVolume(arrayBuffer(web.get(names.mask)));
  for (const name of [names.mask, names.probability]) {
    check(cli.get(name).subarray(0, 352).equals(web.get(name).subarray(0, 352)), `${name} NIfTI header identical to the web app's`);
  }
  let cliVoxels = 0;
  let webVoxels = 0;
  let both = 0;
  for (let i = 0; i < cliMask.data.length; i++) {
    cliVoxels += cliMask.data[i];
    webVoxels += webMask.data[i];
    both += cliMask.data[i] * webMask.data[i];
  }
  const dice = cliVoxels + webVoxels ? (2 * both) / (cliVoxels + webVoxels) : 1;
  const differing = cliVoxels + webVoxels - 2 * both;
  check(dice >= MINIMUM_DICE, `${names.mask} Dice ${dice.toFixed(5)} >= ${MINIMUM_DICE} (${differing} of ${cliVoxels} voxels differ; web ${webVoxels})`);
  const cliProbability = readVolume(arrayBuffer(cli.get(names.probability))).data;
  const webProbability = readVolume(arrayBuffer(web.get(names.probability))).data;
  let largest = 0;
  for (let i = 0; i < cliProbability.length; i++) largest = Math.max(largest, Math.abs(cliProbability[i] - webProbability[i]));
  console.log(`INFO ${names.probability} max |CLI - web| ${largest.toPrecision(3)}`);
  const table = lesionTable(labelLesions(cliMask.data, cliMask.dims).lesions, cliMask.affine);
  check(cli.get(names.table).toString('utf8') === table.tsv, `${names.table} is the web app's table of the CLI mask`);
  const webTable = web.get(names.table).toString('utf8');
  const rows = (tsv) => tsv.trimEnd().split('\n').length - 1;
  console.log(`INFO lesions CLI ${table.rows.length} (${table.totalMl.toFixed(2)} ml), web ${rows(webTable)}; table byte-identical: ${webTable === table.tsv}`);
  for (const name of Object.values(names)) {
    console.log(`INFO ${name} byte-identical to the web app's: ${cli.get(name).equals(web.get(name))}`);
  }
}

async function files(directory) {
  const map = new Map();
  for (const name of (await readdir(directory)).sort()) map.set(name, await readFile(join(directory, name)));
  return map;
}

const work = await mkdtemp(join(tmpdir(), 'flames-cli-check-'));
try {
  const input = await pinnedExample();
  const names = outputNames('MSLesSeg_P57_T1_FLAIR.nii.gz');
  const output = join(work, 'cli');
  const run = spawnSync(command[0], [...command.slice(1), input, output], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  check(report.provenance.executionProvider === 'cpu', `executionProvider ${report.provenance.executionProvider}, ${report.provenance.threads} threads, ONNX Runtime ${report.provenance.onnxruntime}, ${report.provenance.seconds} s`);
  check(report.provenance.models.length === 1 && report.provenance.models[0].sha256 === FLAMES_FOLDS[0].sha256, `default model ${report.provenance.models.map(({ file }) => file).join(', ')}`);
  const cli = await files(output);
  check(JSON.stringify([...cli.keys()]) === JSON.stringify(Object.values(names).sort()), `outputs ${[...cli.keys()].join(', ')}`);
  const reference = join(work, 'web');
  await webReference({ input, output: reference });
  compare(names, cli, await files(reference));
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} FLAMeS command-line checks` : 'PASS FLAMeS command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
