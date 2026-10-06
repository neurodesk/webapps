#!/usr/bin/env node
// Runs an easy-mp2rage command line on the Python golden phantom and on the web app's pinned
// 7 T example.
//
// Phantom: every file of every case in apps/easy-mp2rage/tools/golden/cli/ (one case per
// command-line option, written by tools/gen_cli_golden.py from the Python pipeline) must match
// within the tolerances below, on the phantom's grid and affine. The goldens do not come from the
// WASM core, so they check the command line independently. Each option's golden must differ
// from the default run's, so a command line that ignores the option fails. The same runs must
// also equal the web worker's WASM calls voxel for voxel.
//
// Example: the default and non-default runs must equal the web worker's WASM calls voxel for
// voxel, on UNI's grid and affine.
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
const cliGolden = join(golden, 'cli');
const goldenManifest = JSON.parse(await readFile(join(cliGolden, 'manifest.json'), 'utf8'));
const [example] = JSON.parse(await readFile(new URL('examples.json', app), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/easy-mp2rage.js', import.meta.url))];

// tools/gen_golden.py writes the phantom UNI on this grid (MP_SHAPE, MP_AFF).
const PHANTOM_DIMS = [24, 20, 18];
const PHANTOM_AFFINE = [2, 0, 0, -24, 0, 2, 0, -20, 0, 0, 2, -16, 0, 0, 0, 1];
// Worst |CLI - Python| allowed per file. web/test/e2e_node.mjs accepts T1 within 0.1 ms; the
// measured worst differences are about 1e-3 of each bound.
const TOLERANCE = {
  'T1map.nii.gz': 0.1,
  'T1map_uncorrected.nii.gz': 0.1,
  'B1map.nii.gz': 1e-4,
  'B1map_from_SA2RAGE.nii.gz': 1e-4,
  'UNI_b1corrected.nii.gz': 1e-2,
};
// The golden robust combination rounds to integer UNI levels; float32 inputs reproduce every one.
const DENOISE_TOLERANCE = 0;
const MP2RAGE = mp2rageList(goldenManifest.mp2rage);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

function mp2rageList(mp) {
  return [mp.TR, ...mp.TIs, ...mp.FlipDegrees, ...mp.NZslices, mp.TRFLASH, mp.inv_eff].join(',');
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

const npy = async (path) => readNpy(await readFile(path));
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const volume = async (path) => readNifti(arrayBuffer(await readFile(path)));

function worstDifference(actual, expected) {
  if (actual.length !== expected.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  return worst;
}

function changedVoxels(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
}

// Shape, affine and voxel count of a written file against the grid it must be on.
function checkGeometry(label, written, dims, affine) {
  const shape = Array.from(written.dims).slice(0, 3);
  const voxels = dims.reduce((product, size) => product * size, 1);
  const affineError = worstDifference(Array.from(written.affine), Array.from(affine));
  check(
    shape.join() === dims.join() && (written.dims[3] ?? 1) === 1 && affineError <= 1e-6 && written.data.length === voxels,
    `${label} is ${shape.join('x')} (${written.data.length} voxels) with affine within ${affineError.toExponential(1)} of the input's`,
  );
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
async function webDataPath() {
  const wasm = await import('../wasm/mp2rage_wasm.js');
  wasm.initSync({ module: await readFile(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url)) });
  const outputs = await import('../src/outputs.js');
  return { wasm, outputs };
}

// The options a case passes, in the shape of the web app's worker message.
function webOptions(args) {
  const angle = args.indexOf('--reference-angle');
  const sa2rage = args.indexOf('--sa2rage-params');
  return {
    sa2rage: sa2rage === -1 ? undefined : args[sa2rage + 1].split(',').map(Number),
    referenceAngle: angle === -1 ? 80 : Number(args[angle + 1]),
    extendFov: args.includes('--extend-fov'),
    fallbackUncorrected: args.includes('--fallback-uncorrected'),
  };
}

function webCorrect({ wasm, outputs }, { uni, mask, b1, sa, b1Type, mp2rage, options }) {
  const dims = Uint32Array.from(uni.dims.slice(0, 3));
  const result = sa
    ? wasm.t1map_sa2rage(uni.data, mask, sa.data, dims, uni.affine, Uint32Array.from(sa.dims.slice(0, 3)), sa.affine, Float64Array.from(mp2rage), Float64Array.from(options.sa2rage), options.fallbackUncorrected)
    : wasm.t1map_b1(uni.data, mask, b1.data, dims, uni.affine, Uint32Array.from(b1.dims.slice(0, 3)), b1.affine, outputs.B1_MAP_KINDS[b1Type], options.referenceAngle, Float64Array.from(mp2rage), options.extendFov, options.fallbackUncorrected);
  return { t1: result.t1, b1: result.b1, t1u: result.t1_uncorr, unic: result.uni_corr };
}

function checkParameters(label, parameters, { mode, b1Type, options, maskSource }) {
  const expected = {
    mode,
    b1_map_type: mode === 'b1map' ? b1Type : undefined,
    b1_reference_angle_deg: mode === 'b1map' && b1Type === 'tfl' ? options.referenceAngle : undefined,
    extend_fov: mode === 'b1map' ? options.extendFov : undefined,
    fallback_uncorrected: options.fallbackUncorrected,
    mask_source: maskSource,
  };
  const wrong = Object.entries(expected).filter(([key, value]) => parameters[key] !== value).map(([key]) => key);
  check(wrong.length === 0, `${label} parameters.json records ${Object.entries(expected).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(', ')}${wrong.length ? ` (wrong: ${wrong.join(', ')})` : ''}`);
}

const work = await mkdtemp(join(tmpdir(), 'easy-mp2rage-cli-check-'));
try {
  const web = await webDataPath();
  const inputs = {
    uni: join(phantom, 'phantom_UNI.nii.gz'),
    inv2: join(phantom, 'phantom_INV2.nii.gz'),
    sa2rage: join(phantom, 'phantom_SA2RAGE.nii.gz'),
    b1: join(phantom, 'phantom_B1map_tfl.nii.gz'),
  };
  const phantomVolumes = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([role, path]) => [role, await volume(path)])));
  check(
    Array.from(phantomVolumes.uni.dims).slice(0, 3).join() === PHANTOM_DIMS.join() && worstDifference(Array.from(phantomVolumes.uni.affine), PHANTOM_AFFINE) === 0,
    `phantom UNI is on tools/gen_golden.py's ${PHANTOM_DIMS.join('x')} grid and affine`,
  );

  for (const [name, spec] of Object.entries(goldenManifest.cases)) {
    const output = join(work, `phantom-${name}`);
    const source = spec.b1_source === 'sa2rage' ? ['--sa2rage', inputs.sa2rage] : ['--b1', inputs.b1, '--b1-type', 'tfl'];
    const args = ['correct', '--uni', inputs.uni, '--inv2', inputs.inv2, ...source, '--mp2rage', MP2RAGE, ...spec.args, output];
    const seconds = run(args);
    const mode = spec.b1_source === 'sa2rage' ? 'sa2rage' : 'b1map';
    const options = webOptions(spec.args);
    const webVolumes = webCorrect(web, {
      uni: phantomVolumes.uni,
      mask: phantomVolumes.inv2.data,
      b1: phantomVolumes.b1,
      sa: mode === 'sa2rage' ? phantomVolumes.sa2rage : null,
      b1Type: 'tfl',
      mp2rage: MP2RAGE.split(',').map(Number),
      options,
    });
    const label = `phantom ${name} (${spec.args.join(' ') || 'defaults'})`;
    for (const [key, file] of web.outputs.outputFiles('t1', mode)) {
      const written = await volume(join(output, file));
      const expected = await volume(join(cliGolden, name, file));
      checkGeometry(`${label} ${file}`, written, PHANTOM_DIMS, PHANTOM_AFFINE);
      const difference = worstDifference(written.data, expected.data);
      check(difference <= TOLERANCE[file], `${label} ${file} vs Python golden: worst |diff| ${difference.toExponential(3)} <= ${TOLERANCE[file]} (${seconds.toFixed(1)} s)`);
      const webDifference = worstDifference(written.data, webVolumes[key]);
      check(webDifference === 0, `${label} ${file} equals the web app data path (worst |diff| ${webDifference})`);
      if (spec.baseline && file === 'T1map.nii.gz') {
        const changed = changedVoxels(expected.data, (await volume(join(cliGolden, spec.baseline, file))).data);
        check(changed > 0, `${label} changes ${changed} T1map voxels of the Python golden from ${spec.baseline}`);
      }
    }
    const parameters = JSON.parse(await readFile(join(output, 'parameters.json'), 'utf8'));
    checkParameters(label, parameters, { mode, b1Type: 'tfl', options, maskSource: 'INV2' });
    if (options.sa2rage) check(parameters.sa2rage.join() === options.sa2rage.join(), `${label} parameters.json records sa2rage=${parameters.sa2rage.join(',')}`);
  }

  const denoiseIn = join(work, 'denoise-inputs');
  await mkdir(denoiseIn);
  const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const denoiseInputs = {};
  for (const role of ['uni', 'inv1', 'inv2']) {
    const array = await npy(join(golden, `u_rc_${role}.npy`));
    denoiseInputs[role] = { data: Float32Array.from(array.data), dims: array.dims };
    await writeFile(join(denoiseIn, `${role}.nii`), Buffer.from(writeNiftiF32(denoiseInputs[role].data, array.dims, identity)));
  }
  const defaultDenoised = (await npy(join(golden, 'u_rc_out.npy'))).data;
  for (const [regularization, goldenFile] of [[6, 'u_rc_out.npy'], [2, join('cli', 'denoise-regularization-2.npy')]]) {
    const output = join(work, `denoise-${regularization}`);
    run(['denoise', '--uni', join(denoiseIn, 'uni.nii'), '--inv1', join(denoiseIn, 'inv1.nii'), '--inv2', join(denoiseIn, 'inv2.nii'), '--regularization', String(regularization), output]);
    const written = await volume(join(output, 'UNI_denoised.nii.gz'));
    const expected = (await npy(join(golden, goldenFile))).data;
    checkGeometry(`robust combination (regularization ${regularization}) UNI_denoised.nii.gz`, written, denoiseInputs.uni.dims, identity);
    const difference = worstDifference(written.data, expected);
    check(difference <= DENOISE_TOLERANCE, `robust combination (regularization ${regularization}) UNI_denoised.nii.gz vs Python golden: worst |diff| ${difference} <= ${DENOISE_TOLERANCE}`);
    const webDenoised = web.wasm.denoise_uni(denoiseInputs.uni.data, denoiseInputs.inv1.data, denoiseInputs.inv2.data, Uint32Array.from(denoiseInputs.uni.dims), regularization);
    check(worstDifference(written.data, webDenoised) === 0, `robust combination (regularization ${regularization}) UNI_denoised.nii.gz equals the web app data path`);
    if (regularization !== 6) check(changedVoxels(expected, defaultDenoised) > 0, `regularization ${regularization} changes ${changedVoxels(expected, defaultDenoised)} voxels of the Python golden from the default 6`);
    const parameters = JSON.parse(await readFile(join(output, 'parameters.json'), 'utf8'));
    check(parameters.regularization === regularization, `robust combination parameters.json records regularization=${parameters.regularization}`);
  }

  const files = Object.fromEntries(await Promise.all(example.files.map(async (file) => [file.role, await pinned(file)])));
  const mp = example.parameters.mp;
  const mp2rage = [mp.tr, mp.ti1, mp.ti2, mp.fa1, mp.fa2, mp.nz1, mp.nz2, mp.trflash, mp.inveff];
  const b1Type = example.parameters.b1.type;
  const uni = await volume(files.uni);
  const inv1 = await volume(files.inv1);
  const inv2 = await volume(files.inv2);
  const b1 = await volume(files.b1);
  const uniDims = Array.from(uni.dims).slice(0, 3);
  const runs = {
    defaults: [],
    'extend-fov fallback-uncorrected': ['--extend-fov', '--fallback-uncorrected'],
  };
  const exampleOutputs = {};
  for (const [name, extra] of Object.entries(runs)) {
    const output = join(work, `${example.id}-${name.replaceAll(' ', '-')}`);
    const seconds = run(['correct', '--uni', files.uni, '--inv2', files.inv2, '--b1', files.b1, '--b1-type', b1Type, '--reference-angle', String(example.parameters.b1.refangle), '--mp2rage', mp2rage.join(','), ...extra, output]);
    const options = { ...webOptions(extra), referenceAngle: example.parameters.b1.refangle };
    const webVolumes = webCorrect(web, { uni, mask: inv2.data, b1, b1Type, mp2rage, options });
    exampleOutputs[name] = {};
    for (const [key, file] of web.outputs.outputFiles('t1', 'b1map')) {
      const written = await volume(join(output, file));
      exampleOutputs[name][file] = written.data;
      checkGeometry(`${example.id} ${name} ${file}`, written, uniDims, uni.affine);
      const difference = worstDifference(written.data, webVolumes[key]);
      check(difference === 0, `${example.id} ${name} ${file} equals the web app data path (worst |diff| ${difference}, CLI ${seconds.toFixed(1)} s)`);
    }
    const parameters = JSON.parse(await readFile(join(output, 'parameters.json'), 'utf8'));
    checkParameters(`${example.id} ${name}`, parameters, { mode: 'b1map', b1Type, options, maskSource: 'INV2' });
    check(parameters.mp2rage.join() === mp2rage.join(), `${example.id} ${name} parameters.json records the MP2RAGE settings`);
  }
  const fallbackChanged = changedVoxels(exampleOutputs.defaults['T1map.nii.gz'], exampleOutputs['extend-fov fallback-uncorrected']['T1map.nii.gz']);
  check(fallbackChanged > 0, `${example.id} --extend-fov --fallback-uncorrected changes ${fallbackChanged} T1map voxels`);

  const denoiseExampleOut = join(work, `${example.id}-denoise`);
  const denoiseSeconds = run(['denoise', '--uni', files.uni, '--inv1', files.inv1, '--inv2', files.inv2, '--regularization', '3', denoiseExampleOut]);
  const denoised = await volume(join(denoiseExampleOut, 'UNI_denoised.nii.gz'));
  checkGeometry(`${example.id} UNI_denoised.nii.gz`, denoised, uniDims, uni.affine);
  const webDenoised = web.wasm.denoise_uni(uni.data, inv1.data, inv2.data, Uint32Array.from(uniDims), 3);
  const denoiseDifference = worstDifference(denoised.data, webDenoised);
  check(denoiseDifference === 0, `${example.id} UNI_denoised.nii.gz (regularization 3) equals the web app data path (worst |diff| ${denoiseDifference}, CLI ${denoiseSeconds.toFixed(1)} s)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} easy-mp2rage command-line checks` : 'PASS easy-mp2rage command line matches the Python golden and the web app data path');
process.exitCode = failures.length ? 1 : 0;
