#!/usr/bin/env node
// Holds an elastix-register command line to the web app. It registers the web
// app's pinned example with every preset and compares the downloads with the
// web app's own, recorded in t1-mni-reference.json by
// apps/elastix/e2e/reference.spec.js. It then registers a known rigid
// displacement and recovers it by composing the TransformParameters files, as
// apps/elastix/e2e/automation.spec.js does, and registers a shifted 2D pair
// read from OME-Zarr and a pyramidal OME-TIFF.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume, transformErrorMm } from '../../../test-utils/registration-similarity.mjs';
import { pyramidalTiff, SHIFT_PX, SPACING, syntheticPair, totalTranslation } from '../../../apps/elastix/e2e/fixtures.mjs';
import { PRESETS, compare, elastixWasmSha256, expectedNames, pinnedExample, readReference, summarize } from './reference.mjs';
import { fixedToMovingRas } from './parameter-matrix.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/elastix-register.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

// Runs the command line and returns the files it wrote, by name.
function register(args) {
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} ${args.join(' ')} exited with ${run.status}:\n${run.stderr.slice(-4000)}`);
  return { stdout: run.stdout, seconds: (performance.now() - started) / 1000 };
}

async function outputs(directory) {
  const files = {};
  for (const name of await readdir(directory)) files[name] = await readFile(join(directory, name));
  return files;
}

const work = await mkdtemp(join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'elastix-cli-check-'));
try {
  const reference = await readReference();
  const wasm = await elastixWasmSha256();
  check(reference.elastixWasmSha256 === wasm, `reference was recorded with the installed elastix pipeline ${wasm.slice(0, 12)}`);
  const example = await pinnedExample();
  check(
    reference.inputs[example.moving.name] === example.moving.sha256 && reference.inputs[example.fixed.name] === example.fixed.sha256,
    'reference was recorded from the pinned example inputs',
  );
  const fixedBytes = await readFile(example.fixed.path);
  for (const method of PRESETS) {
    const expected = reference.browser?.presets?.[method];
    if (!expected) {
      check(false, `reference holds the web app's ${method} downloads`);
      continue;
    }
    const output = join(work, method);
    const { stdout, seconds } = register([example.moving.path, example.fixed.path, output, '--method', method]);
    const names = expectedNames(example.moving.name, method);
    check(
      stdout.trim().split(/\r?\n/).map((line) => line.slice(output.length + 1)).sort().join() === [...names].sort().join(),
      `${method}: standard output lists the written files and nothing else (${seconds.toFixed(0)} s)`,
    );
    const actual = await summarize(await outputs(output), fixedBytes, example.moving.name, method);
    for (const [passed, line] of compare(`${method}:`, actual, expected.artifacts, 'browser')) check(passed, line);
    await rm(output, { recursive: true, force: true });
  }

  // A known displacement: the example template, 3 mm, turned 8 degrees and shifted.
  const [appExample] = JSON.parse(await readFile(new URL('../../../apps/elastix/examples.json', import.meta.url), 'utf8'));
  const { fixed } = await downsampledExamplePair(appExample, 3);
  const { moving, fixedToMoving } = displaceVolume(fixed, { translationVoxels: [3, -2, 2], rotationDegreesZ: 8 });
  const displaced = join(work, 'displaced');
  await writeFile(join(work, 'moving.nii.gz'), gzipSync(encodeNifti(moving)));
  await writeFile(join(work, 'fixed.nii.gz'), gzipSync(encodeNifti(fixed)));
  register([join(work, 'moving.nii.gz'), join(work, 'fixed.nii.gz'), displaced, '--method', 'rigid']);
  const files = await outputs(displaced);
  const texts = ['moving_TransformParameters.0.toml', 'moving_TransformParameters.1.toml'].map((name) => files[name].toString('utf8'));
  const errorMm = transformErrorMm(fixedToMovingRas(texts), fixedToMoving, fixed);
  check(errorMm < 1, `known rigid displacement recovered by composing the TransformParameters files within ${errorMm.toFixed(2)} mm (< 1 mm)`);
  const warped = await readVolume(files['moving_registered.nii.gz']);
  const [before, after] = [ncc(moving.data, fixed.data), ncc(warped.data, fixed.data)];
  check(before < 0.9 && after > 0.98, `known displacement: NCC with the fixed image ${before.toFixed(3)} before, ${after.toFixed(3)} after (> 0.98)`);

  // OME-Zarr and TIFF inputs: blobs shifted by a known number of pixels.
  const pair = await syntheticPair();
  await writeFile(join(work, 'moving.ome.zarr.ozx'), pair.moving.ozx);
  await writeFile(join(work, 'fixed.ome.tif'), await pyramidalTiff());
  const shifted = join(work, 'shifted');
  register([join(work, 'moving.ome.zarr.ozx'), join(work, 'fixed.ome.tif'), shifted, '--method', 'rigid']);
  const shiftFiles = await outputs(shifted);
  const [tx, ty] = totalTranslation(['moving_TransformParameters.0.toml', 'moving_TransformParameters.1.toml'].map((name) => shiftFiles[name].toString('utf8')));
  const [ex, ey] = SHIFT_PX.map((pixels) => pixels * SPACING);
  check(Math.hypot(tx - ex, ty - ey) < 0.1, `OME-Zarr moving and OME-TIFF fixed: translation (${tx.toFixed(3)}, ${ty.toFixed(3)}) within 0.1 µm of the known (${ex}, ${ey})`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} elastix command-line checks` : 'PASS elastix command line reproduces the web app\'s registrations of the pinned example');
process.exitCode = failures.length ? 1 : 0;
