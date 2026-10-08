#!/usr/bin/env node
// Runs a synthseg command line on both benchmark volumes in both modes and holds each label map to the
// FreeSurfer 8.1.0 golden with the gates of exes/synthseg/tests/parity.rs (./gates.json). FreeSurfer's
// Keras/TensorFlow SynthSeg made the goldens, so the reference shares no code with the command line.
// With --native PATH, each fast-mode map is also compared with the native Rust synthseg on the same input.
// Only fast mode: the native CPU path holds ONNX Runtime's memory arena and peaks near 14 GB in the default
// mode (exes/synthseg/README.md), more than the release runners or a shared host can spare.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import manifest from '../model.manifest.json' with { type: 'json' };
import { outputNames } from '../src/results.js';
import { compareLabels, compareVolumes, gates } from './compare.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, native: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/synthseg.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

// The release check runs with an empty home that must stay empty, so the downloads go under the temp directory.
async function validationFile(name) {
  const expected = manifest.validation.sha256[name];
  const path = join(tmpdir(), 'neurodesk-synthseg-validation', manifest.revision, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return cached;
  const response = await fetch(`${manifest.validation.base_url}${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${name}: SHA-256 differs from model.manifest.json`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return bytes;
}

function run(executable, args) {
  const started = performance.now();
  const result = spawnSync(executable[0], [...executable.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable.join(' ')} exited with ${result.status}:\n${result.stderr}`);
  return { stdout: result.stdout, seconds: (performance.now() - started) / 1000 };
}

async function segment(work, { input, mode }) {
  const name = `${input} ${mode}`;
  const inputPath = join(tmpdir(), 'neurodesk-synthseg-validation', manifest.revision, `${input}.nii.gz`);
  const output = join(work, `${input}-${mode}`);
  const { stdout, seconds } = run(command, [inputPath, output, '--mode', mode]);
  const result = JSON.parse(stdout);
  const names = outputNames(`${input}.nii.gz`);
  const files = (await readdir(output)).sort();
  check(JSON.stringify(files) === JSON.stringify([names.labels, names.report].sort()), `${name} outputs ${files.join(', ')}`);
  const labels = await readFile(join(output, names.labels));
  const report = JSON.parse(await readFile(join(output, names.report), 'utf8'));
  const provenance = report.provenance;
  check(provenance.executionProvider === 'cpu' && provenance.modelSha256 === manifest.assets[0].sha256, `${name} ran ${provenance.app} on ONNX Runtime ${provenance.onnxRuntime} CPU, ${provenance.threads} threads, model ${provenance.modelSha256.slice(0, 12)}, ${seconds.toFixed(1)} s, peak memory ${(result.peakMemoryMb / 1024).toFixed(1)} GB`);
  check(report.parameters.mode === mode && provenance.fast === (mode === 'fast') && provenance.flip === (mode !== 'fast') && report.parameters.ct === false, `${name} report records mode ${report.parameters.mode}, ct ${report.parameters.ct}, flip ${provenance.flip}`);
  check(report.artifacts.labels.sha256 === sha256(labels) && result.files.includes(names.labels), `${name} report describes the label file it sits beside`);
  const golden = await validationFile(`${input}_${mode}.nii.gz`);
  const compared = compareLabels(name, labels, golden, gates.maxMismatchFraction.fullVolume);
  for (const [passed, line] of compared.checks) check(passed, line);
  for (const [passed, line] of compareVolumes(name, report, compared)) check(passed, line);
  if (values.native && mode === 'fast') {
    const nativeOutput = join(work, `${input}-${mode}-native.nii.gz`);
    const native = run([resolve(values.native)], ['--i', inputPath, '--o', nativeOutput, '--quiet', '--fast']);
    const versusNative = compareLabels(name, labels, await readFile(nativeOutput), gates.maxMismatchFraction.fullVolume, 'native Rust synthseg');
    for (const [passed, line] of versusNative.checks) check(passed, line);
    console.log(`INFO ${name} native Rust CPU ${native.seconds.toFixed(1)} s`);
  }
}

const work = await mkdtemp(join(tmpdir(), 'synthseg-cli-check-'));
try {
  for (const input of new Set(gates.fullVolumes.map((entry) => entry.input))) await validationFile(`${input}.nii.gz`);
  for (const entry of gates.fullVolumes) await segment(work, entry);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} SynthSeg command-line checks` : 'PASS SynthSeg command line matches FreeSurfer');
process.exitCode = failures.length ? 1 : 0;
