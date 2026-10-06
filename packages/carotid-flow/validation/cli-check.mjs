#!/usr/bin/env node
// Runs a Carotid Flow command line on the app's pinned PCMCalculator example. The vessels and
// flows must match the pins in pcmcalculator.json, which the app's open-example test also reads,
// and every file must be byte-identical to the same detection run through this repository's code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readNiftiFrames } from '@neurodesk/webapp-components/file-io';
import { detect } from '../src/node.js';

const pins = JSON.parse(await readFile(new URL('./pcmcalculator.json', import.meta.url), 'utf8'));
const examples = JSON.parse(await readFile(new URL('../../../apps/carotid-flow/examples.json', import.meta.url), 'utf8'));
const example = examples.find(({ id }) => id === pins.example);
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/carotid-flow.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned({ name, url, sha256: expected }) {
  const path = join(tmpdir(), 'neurodesk-carotid-flow-validation', expected, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

function column(csv, name) {
  const [header, ...rows] = csv.trim().split('\n').map((line) => line.split(','));
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`curves CSV has no ${name} column`);
  return rows.map((row) => Number(row[index]));
}

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

function correlation(a, b) {
  const [ma, mb] = [mean(a), mean(b)];
  let ab = 0;
  let aa = 0;
  let bb = 0;
  a.forEach((value, t) => {
    ab += (value - ma) * (b[t] - mb);
    aa += (value - ma) ** 2;
    bb += (b[t] - mb) ** 2;
  });
  return ab / Math.sqrt(aa * bb);
}

const work = await mkdtemp(join(tmpdir(), 'carotid-flow-cli-check-'));
try {
  const amplitude = await pinned(example.files.find(({ role }) => role === 'image'));
  const phase = await pinned(example.files.find(({ role }) => role === 'phase'));
  const output = join(work, 'results');
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), amplitude, phase, output], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  console.log(`INFO ${run.stderr.trim().split('\n').at(-1)} (${((performance.now() - started) / 1000).toFixed(1)} s)`);

  const reference = join(work, 'reference');
  const expected = await detect({ inputs: [amplitude, phase], output: reference });
  const names = (await readdir(output)).sort();
  check(JSON.stringify(names) === JSON.stringify([...expected.files].sort()), `outputs ${names.join(', ')}`);
  for (const name of expected.files) {
    const actual = await readFile(join(output, name)).catch(() => Buffer.alloc(0));
    check(sha256(actual) === sha256(await readFile(join(reference, name))), `${name} identical to the in-repository detection the web app runs (${sha256(actual).slice(0, 12)})`);
  }

  const csv = await readFile(join(output, 'carotid_pc_mod_carotid_curves.csv'), 'utf8');
  const right = column(csv, 'right_flow_ml_min');
  const left = column(csv, 'left_flow_ml_min');
  const pcm = mean(pins.referenceRightFlowMlMin);
  const ratio = mean(right) / pcm - 1;
  check(Math.round(mean(right)) === pins.expected.rightMeanMlMin, `right carotid ${mean(right).toFixed(1)} ml/min rounds to ${pins.expected.rightMeanMlMin}`);
  check(Math.round(mean(left)) === pins.expected.leftMeanMlMin, `left carotid ${mean(left).toFixed(1)} ml/min rounds to ${pins.expected.leftMeanMlMin}`);
  check(Math.abs(ratio) < pins.rightMeanTolerance, `right carotid ${(ratio * 100).toFixed(1)} % from PCMCalculator's ${pcm.toFixed(1)} ml/min, within ${pins.rightMeanTolerance * 100} %`);
  const r = correlation(right, pins.referenceRightFlowMlMin);
  check(r > pins.minimumCorrelation, `right waveform correlation ${r.toFixed(4)} > ${pins.minimumCorrelation}`);
  check(right.indexOf(Math.max(...right)) === pins.expected.rightPeakFrame, `right systolic peak at frame ${right.indexOf(Math.max(...right)) + 1}`);

  const labels = readNiftiFrames(await readFile(join(output, 'carotid_pc_mod_carotid_labels.nii')), Uint8Array).data;
  const count = (value) => labels.reduce((total, label) => total + (label === value ? 1 : 0), 0);
  check(count(1) === pins.expected.leftPixels, `left carotid label ${count(1)} pixels`);
  check(count(2) === pins.expected.rightPixels, `right carotid label ${count(2)} pixels`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} Carotid Flow command-line checks` : 'PASS Carotid Flow command line matches the web app and PCMCalculator');
process.exitCode = failures.length ? 1 : 0;
