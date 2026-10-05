#!/usr/bin/env node
// Runs an easy-mp2rage command line on the Python golden phantom and on the web app's pinned
// 7 T example. The phantom outputs must match tools/golden within web/test/e2e_node.mjs's
// tolerance; the example outputs must equal the web worker's WASM calls voxel for voxel.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readNifti, writeNiftiF32 } from '../src/nifti.js';

const app = new URL('../../../apps/easy-mp2rage/', import.meta.url);
const phantom = fileURLToPath(new URL('tools/phantom/', app));
const golden = fileURLToPath(new URL('tools/golden/', app));
const [example] = JSON.parse(await readFile(new URL('examples.json', app), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/easy-mp2rage.js', import.meta.url))];

// web/test/e2e_node.mjs accepts the app's T1 within 0.1 ms of the Python golden.
const T1_TOLERANCE_MS = 0.1;
// The golden robust combination rounds to integer UNI levels; float32 inputs reproduce every one.
const DENOISE_TOLERANCE = 0;
const MP2RAGE = '4.3,0.840,2.370,5,6,64,128,0.007,0.96';
const SA2RAGE = '2.4,0.150,1.500,6,6,24,24,0.005,1.5';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

function readNpy(bytes) {
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.toString('latin1', 10, 10 + headerLength);
  if (!header.includes("'descr': '<f8'") || !header.includes("'fortran_order': False")) throw new Error('expected a C-order float64 npy');
  const shape = header.match(/'shape':\s*\(([^)]*)\)/)[1].split(',').map((size) => size.trim()).filter(Boolean).map(Number);
  const [nx, ny, nz] = shape;
  const data = new Float64Array(nx * ny * nz);
  const offset = 10 + headerLength;
  // C order is k fastest; NIfTI order is i fastest.
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) data[i + nx * (j + ny * k)] = bytes.readDoubleLE(offset + 8 * ((i * ny + j) * nz + k));
    }
  }
  return { data, dims: shape };
}

const goldenArray = async (name) => readNpy(await readFile(join(golden, `${name}.npy`)));
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const volume = async (path) => readNifti(arrayBuffer(await readFile(path)));

function worstDifference(actual, expected) {
  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  return worst;
}

function run(args) {
  const started = performance.now();
  const result = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} ${args.join(' ')} exited with ${result.status}:\n${result.stderr}`);
  return (performance.now() - started) / 1000;
}

async function pinned(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-easy-mp2rage-validation', revision, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === file.sha256) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

// The web worker's calls, made in this process on the package build the app stages.
async function appDataPath() {
  const wasm = await import('../wasm/mp2rage_wasm.js');
  wasm.initSync({ module: await readFile(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url)) });
  const outputs = await import('../src/outputs.js');
  return { wasm, outputs };
}

const work = await mkdtemp(join(tmpdir(), 'easy-mp2rage-cli-check-'));
try {
  const sa2rageOut = join(work, 'phantom-sa2rage');
  const seconds = run(['correct', '--uni', join(phantom, 'phantom_UNI.nii.gz'), '--inv2', join(phantom, 'phantom_INV2.nii.gz'), '--sa2rage', join(phantom, 'phantom_SA2RAGE.nii.gz'), '--sa2rage-params', SA2RAGE, '--mp2rage', MP2RAGE, sa2rageOut]);
  const sa2rageT1 = worstDifference((await volume(join(sa2rageOut, 'T1map.nii.gz'))).data, (await goldenArray('v_corr_T1_ms')).data);
  check(sa2rageT1 < T1_TOLERANCE_MS, `phantom SA2RAGE T1map.nii.gz vs Python golden: worst |diff| ${sa2rageT1.toExponential(3)} ms < ${T1_TOLERANCE_MS} (${seconds.toFixed(1)} s)`);
  const sa2rageUni = worstDifference((await volume(join(sa2rageOut, 'UNI_b1corrected.nii.gz'))).data, (await goldenArray('v_corr_UNI')).data);
  check(sa2rageUni < 1e-3, `phantom SA2RAGE UNI_b1corrected.nii.gz vs Python golden: worst |diff| ${sa2rageUni.toExponential(3)}`);

  const b1Out = join(work, 'phantom-b1');
  run(['correct', '--uni', join(phantom, 'phantom_UNI.nii.gz'), '--inv2', join(phantom, 'phantom_INV2.nii.gz'), '--b1', join(phantom, 'phantom_B1map_tfl.nii.gz'), '--b1-type', 'tfl', '--reference-angle', '80', '--mp2rage', MP2RAGE, b1Out]);
  const b1T1 = worstDifference((await volume(join(b1Out, 'T1map.nii.gz'))).data, (await goldenArray('v_b1map_corr_T1_ms')).data);
  check(b1T1 < T1_TOLERANCE_MS, `phantom tfl B1 T1map.nii.gz vs Python golden: worst |diff| ${b1T1.toExponential(3)} ms < ${T1_TOLERANCE_MS}`);

  const denoiseIn = join(work, 'denoise-inputs');
  await mkdir(denoiseIn);
  const affine = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  for (const role of ['uni', 'inv1', 'inv2']) {
    const array = await goldenArray(`u_rc_${role}`);
    await writeFile(join(denoiseIn, `${role}.nii`), Buffer.from(writeNiftiF32(Float32Array.from(array.data), array.dims, affine)));
  }
  const denoiseOut = join(work, 'denoise');
  run(['denoise', '--uni', join(denoiseIn, 'uni.nii'), '--inv1', join(denoiseIn, 'inv1.nii'), '--inv2', join(denoiseIn, 'inv2.nii'), '--regularization', '6', denoiseOut]);
  const denoised = worstDifference((await volume(join(denoiseOut, 'UNI_denoised.nii.gz'))).data, (await goldenArray('u_rc_out')).data);
  check(denoised <= DENOISE_TOLERANCE, `robust combination UNI_denoised.nii.gz vs Python golden: worst |diff| ${denoised} <= ${DENOISE_TOLERANCE}`);

  const files = Object.fromEntries(await Promise.all(example.files.map(async (file) => [file.role, await pinned(file)])));
  const mp = example.parameters.mp;
  const mp2rage = [mp.tr, mp.ti1, mp.ti2, mp.fa1, mp.fa2, mp.nz1, mp.nz2, mp.trflash, mp.inveff];
  const { wasm, outputs } = await appDataPath();
  const uni = await volume(files.uni);
  const inv1 = await volume(files.inv1);
  const inv2 = await volume(files.inv2);
  const b1 = await volume(files.b1);
  const dims = Uint32Array.from(uni.dims.slice(0, 3));

  const correctOut = join(work, `${example.id}-correct`);
  const correctSeconds = run(['correct', '--uni', files.uni, '--inv2', files.inv2, '--b1', files.b1, '--b1-type', example.parameters.b1.type, '--reference-angle', String(example.parameters.b1.refangle), '--mp2rage', mp2rage.join(','), correctOut]);
  const web = wasm.t1map_b1(uni.data, inv2.data, b1.data, dims, uni.affine, Uint32Array.from(b1.dims.slice(0, 3)), b1.affine, outputs.B1_MAP_KINDS[example.parameters.b1.type], example.parameters.b1.refangle, Float64Array.from(mp2rage), false, false);
  const webVolumes = { t1: web.t1, b1: web.b1, t1u: web.t1_uncorr, unic: web.uni_corr };
  for (const [key, name] of outputs.outputFiles('t1', 'b1map')) {
    const difference = worstDifference((await volume(join(correctOut, name))).data, webVolumes[key]);
    check(difference === 0, `${example.id} ${name} equals the web app data path (worst |diff| ${difference}, CLI ${correctSeconds.toFixed(1)} s)`);
  }
  const parameters = JSON.parse(await readFile(join(correctOut, 'parameters.json'), 'utf8'));
  check(parameters.mode === 'b1map' && parameters.b1_map_type === example.parameters.b1.type && parameters.mp2rage.join() === mp2rage.join(), `${example.id} parameters.json records mode, B1 units and MP2RAGE settings`);

  const denoiseExampleOut = join(work, `${example.id}-denoise`);
  const denoiseSeconds = run(['denoise', '--uni', files.uni, '--inv1', files.inv1, '--inv2', files.inv2, denoiseExampleOut]);
  const webDenoised = wasm.denoise_uni(uni.data, inv1.data, inv2.data, dims, 6);
  const denoiseDifference = worstDifference((await volume(join(denoiseExampleOut, 'UNI_denoised.nii.gz'))).data, webDenoised);
  check(denoiseDifference === 0, `${example.id} UNI_denoised.nii.gz equals the web app data path (worst |diff| ${denoiseDifference}, CLI ${denoiseSeconds.toFixed(1)} s)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} easy-mp2rage command-line checks` : 'PASS easy-mp2rage command line matches the Python golden and the web app data path');
process.exitCode = failures.length ? 1 : 0;
