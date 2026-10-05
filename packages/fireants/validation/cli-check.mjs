#!/usr/bin/env node
// Registers the web app's pinned example with a FireANTs command line and compares it with
// t1-mni-reference.json: the web app's engine call, made in-process by --write-reference.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { register } from '@fireants/fireants';
import enginePackage from '@fireants/fireants/package.json' with { type: 'json' };
import { finalNcc } from '../src/node.js';
import { registeredFileName } from '../src/outputs.js';

const REFERENCE = new URL('./t1-mni-reference.json', import.meta.url);
const [example] = JSON.parse(await readFile(new URL('../../../apps/fireants/examples.json', import.meta.url), 'utf8'));
// examples.json pins the dataset revision but not file checksums (its browser tests serve a
// fixture in their place), so the gate pins the bytes it validates on.
const EXAMPLE_SHA256 = {
  't1_brain.nii.gz': '553e242f330381aa7a5bdac5db27e971d9ee8001e63375d3b01fb00ec0e31bff',
  'MNI152_T1_1mm_brain.nii.gz': '32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212',
};
// The reference and every check use this many threads. The threaded engine splits its sums by
// thread, so another count changes the float rounding and moves the optimizer slightly.
const THREADS = 4;
// Measured on Linux x64: 8 threads instead of 4 changed voxels but not the reported NCC (-0.8586,
// printed to 4 decimals), and moved the fixed-brain correlation by 2e-6. The limits leave room
// for other CPUs and operating systems without admitting a different registration.
const THRESHOLDS = {
  // Final Greedy NCC the engine reports, CLI minus reference.
  engineNcc: 0.001,
  // Pearson correlation of the registered and fixed images over the fixed brain, CLI minus reference.
  fixedCorrelation: 0.0005,
};
// Registration of the 1 mm example takes minutes; the engine's own default limit is 15.
const TIMEOUT_MS = 6 * 60 * 60 * 1000;

const { values } = parseArgs({ options: { executable: { type: 'string' }, 'write-reference': { type: 'boolean' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/fireants.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-fireants-validation', revision, file.name);
  const expected = EXAMPLE_SHA256[file.name];
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

const READERS = {
  2: [1, (bytes, offset) => bytes.readUInt8(offset)],
  4: [2, (bytes, offset) => bytes.readInt16LE(offset)],
  16: [4, (bytes, offset) => bytes.readFloatLE(offset)],
};

function readVolume(compressed) {
  const bytes = gunzipSync(compressed);
  if (bytes.readInt32LE(0) !== 348) throw new Error('expected a little-endian NIfTI-1 image');
  const dims = [42, 44, 46].map((offset) => bytes.readInt16LE(offset));
  const datatype = bytes.readInt16LE(70);
  if (!READERS[datatype]) throw new Error(`unsupported NIfTI datatype ${datatype}`);
  const [size, read] = READERS[datatype];
  const offset = Math.trunc(bytes.readFloatLE(108));
  const slope = bytes.readFloatLE(112) || 1;
  const intercept = bytes.readFloatLE(116);
  const count = dims[0] * dims[1] * dims[2];
  const data = new Float64Array(count);
  for (let i = 0; i < count; i += 1) data[i] = read(bytes, offset + i * size) * slope + intercept;
  return { dims, data, voxelSha256: sha256(bytes.subarray(offset, offset + count * size)) };
}

function correlation(a, b, mask) {
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!mask[i]) continue;
    count += 1;
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / count;
  const meanB = sumB / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!mask[i]) continue;
    covariance += (a[i] - meanA) * (b[i] - meanB);
    varianceA += (a[i] - meanA) ** 2;
    varianceB += (b[i] - meanB) ** 2;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

function summarize(compressed, fixedVolume) {
  const volume = readVolume(compressed);
  const brain = fixedVolume.data.map((value) => (value > 0 ? 1 : 0));
  return {
    dims: volume.dims,
    voxelSha256: volume.voxelSha256,
    fixedCorrelation: Number(correlation(volume.data, fixedVolume.data, brain).toFixed(6)),
  };
}

const [movingFile, fixedFile] = example.files;
const moving = await pinned(movingFile);
const fixed = await pinned(fixedFile);
const fixedVolume = readVolume(await readFile(fixed));

if (values['write-reference']) {
  const started = performance.now();
  const result = await register(await readFile(fixed), await readFile(moving), {
    backend: 'cpu',
    transform: 'greedy',
    threads: THREADS,
    worker: false,
    gzip: true,
    verbose: 1,
    timeoutMs: TIMEOUT_MS,
  });
  const reference = {
    example: example.id,
    inputs: EXAMPLE_SHA256,
    engine: `${enginePackage.name} ${enginePackage.version}`,
    path: 'register() in-process, as apps/fireants/src/main.js calls it, with worker: false',
    transform: 'greedy',
    threads: THREADS,
    variant: result.variant,
    seconds: Math.round((performance.now() - started) / 1000),
    stages: result.log.split('\n').filter((line) => /\(NCC /.test(line)).map((line) => line.trim()),
    finalNcc: finalNcc(result.log),
    ...summarize(Buffer.from(result.image), fixedVolume),
  };
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(JSON.stringify(reference, null, 2));
} else {
  const reference = JSON.parse(await readFile(REFERENCE, 'utf8'));
  check(reference.engine === `${enginePackage.name} ${enginePackage.version}`, `reference engine ${reference.engine} is the installed one`);
  const work = await mkdtemp(join(tmpdir(), 'fireants-cli-check-'));
  try {
    const output = join(work, 'registered');
    const started = performance.now();
    const run = spawnSync(command[0], [...command.slice(1), moving, fixed, output, '--threads', String(THREADS)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
    const seconds = (performance.now() - started) / 1000;
    const name = registeredFileName(movingFile.name);
    const files = await readdir(output);
    check(files.length === 1 && files[0] === name, `${example.id} writes only ${name} (${seconds.toFixed(0)} s on ${THREADS} threads)`);
    const ncc = finalNcc(run.stderr);
    check(
      Number.isFinite(ncc) && Math.abs(ncc - reference.finalNcc) <= THRESHOLDS.engineNcc,
      `${example.id} final greedy NCC ${ncc} vs in-process reference ${reference.finalNcc}, |diff| <= ${THRESHOLDS.engineNcc}`,
    );
    const actual = summarize(await readFile(join(output, name)), fixedVolume);
    check(actual.dims.join() === fixedVolume.dims.join(), `${name} is on the fixed grid ${actual.dims.join('x')}`);
    check(
      Math.abs(actual.fixedCorrelation - reference.fixedCorrelation) <= THRESHOLDS.fixedCorrelation,
      `${name} correlation with the fixed brain ${actual.fixedCorrelation} vs reference ${reference.fixedCorrelation}, |diff| <= ${THRESHOLDS.fixedCorrelation}`,
    );
    console.log(`INFO voxels ${actual.voxelSha256 === reference.voxelSha256 ? 'identical to' : 'differ from'} the reference (${actual.voxelSha256.slice(0, 12)})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(failures.length ? `FAIL ${failures.length} FireANTs command-line checks` : 'PASS FireANTs command line matches the in-process web engine reference on the pinned example');
  process.exitCode = failures.length ? 1 : 0;
}
