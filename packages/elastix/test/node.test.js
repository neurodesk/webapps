import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import ZipFileStore from '@zarrita/storage/zip';
import * as zarr from 'zarrita';
import { defaultParameterMapNode, writeParameterFilesNode } from '@itk-wasm/elastix';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { ncc, readVolume } from '../../../test-utils/registration-similarity.mjs';
import { fixedToMovingRas } from '../validation/parameter-matrix.mjs';
import { hdf5Writable } from '../src/outputs.js';
import { writeOmeTiff } from '../src/ome-tiff.js';
import { readInput } from '../src/node.js';
import { readImageNode } from '@itk-wasm/image-io';
import { registrationError, registrationImage, transformParameterFiles } from '../src/pipeline.js';

const BIN = fileURLToPath(new URL('../bin/elastix-register.js', import.meta.url));
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

// A smooth blob in a 2 mm 20^3 int16 volume, `shift` voxels along x.
function blob(shift) {
  const size = 20;
  const img = new Int16Array(size ** 3);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) img[x + size * (y + size * z)] = Math.round(1000 * Math.exp(-((x - 9 - shift) ** 2 + (y - 10) ** 2 + 0.5 * (z - 10) ** 2) / 12));
    }
  }
  const affine = [[2, 0, 0, -20], [0, 2, 0, -20], [0, 0, 2, -20]];
  return Buffer.from(createNiftiFromVolume({ img, hdr: { dims: [3, size, size, size, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine } }));
}

async function workspace(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'elastix-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moving = join(directory, 'subject.nii.gz');
  const fixed = join(directory, 'template.nii');
  await writeFile(moving, gzipSync(blob(2)));
  await writeFile(fixed, blob(0));
  return { directory, moving, fixed };
}

const toml = (text, key) => JSON.parse(new RegExp(`^${key} = (.+)$`, 'm').exec(text)[1]);

test('registrationImage keeps the scalar image and gives elastix a float32 copy', () => {
  const image = {
    imageType: { dimension: 3, componentType: 'int16', pixelType: 'Scalar', components: 1 },
    origin: [0, 0, 0], spacing: [1, 1, 1], direction: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    size: [2, 2, 1], metadata: new Map(), data: new Int16Array([1, -2, 3, 32767]),
  };
  const { scalar, image: float } = registrationImage(image);
  assert.equal(scalar.imageType.dimension, 2);
  assert.equal(scalar.imageType.componentType, 'int16');
  assert.equal(float.imageType.componentType, 'float32');
  assert.deepEqual(Array.from(float.data), [1, -2, 3, 32767]);
  assert.equal(registrationImage(float).image, float);
});

test('transformParameterFiles chains the maps and refuses an empty file', async () => {
  const seen = [];
  const write = async (maps, names) => {
    seen.push({ maps, names });
    return { parameterFiles: names.map((name) => ({ path: name, data: `${name}\n` })) };
  };
  const files = await transformParameterFiles([{ Transform: ['TranslationTransform'] }, { Transform: ['EulerTransform'] }], 't1', write);
  assert.deepEqual(files.map((file) => file.name), ['t1_TransformParameters.0.toml', 't1_TransformParameters.1.toml']);
  assert.deepEqual(seen[0].maps.map((map) => map.InitialTransformParameterFileName[0]), ['NoInitialTransform', 't1_TransformParameters.0.toml']);
  await assert.rejects(transformParameterFiles([{}], 't1', async () => ({ parameterFiles: [{ data: '' }] })), /empty parameter file/);
  assert.match(registrationError(5_243_016).message, /internal error/);
});

test('hdf5Writable refuses a B-spline stage, which transform-io cannot write', () => {
  const of = (...types) => types.map((transformParameterization) => ({ transformType: { transformParameterization } }));
  assert.equal(hdf5Writable(of('Composite', 'Euler3D', 'Translation')), true);
  assert.equal(hdf5Writable(of('Composite', 'BSpline', 'Affine')), false);
});

test('the command line refuses bad arguments before reading any image', () => {
  assert.match(run(['--help']).stdout, /Usage: elastix-register MOVING FIXED OUTPUT_DIR/);
  for (const [args, message] of [
    [['a', 'b'], /Provide a moving image/],
    [['a', 'b', 'c', '--method', 'nonlinear'], /Unknown registration method/],
    [['a', 'b', 'c', '--resolutions', '7'], /Resolutions must be a whole number from 1 to 6/],
    [['a', 'b', 'c', '--grid-spacing', '5'], /--grid-spacing applies only to --method bspline/],
    [['a', 'b', 'c', '--parameter-file', 'p.txt', '--method', 'rigid'], /--parameter-file replaces the preset/],
    [['self-check', 'extra'], /does not accept arguments/],
    [['a', 'b', 'c', '--cache-dir', 'd'], /--cache-dir applies only to download-models/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
  assert.match(run(['download-models']).stdout, /nothing to download/);
});

test('a rigid registration writes the web app downloads, lists them on stdout and recovers the shift', async (t) => {
  const { directory, moving, fixed } = await workspace(t);
  const output = join(directory, 'results');
  const result = run([moving, fixed, output, '--method', 'rigid', '--resolutions', '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No subject_registered\.ome\.tif: OME-TIFF cannot preserve/);
  const names = ['subject_registered.nii.gz', 'subject_transform.h5', 'subject_transform.ome.zarr.ozx', 'subject_TransformParameters.0.toml', 'subject_TransformParameters.1.toml'];
  assert.deepEqual(result.stdout.trim().split('\n'), names.map((name) => join(output, name)));
  assert.match(result.stderr, /TranslationTransform -> EulerTransform \(rigid preset\)/);
  assert.deepEqual((await readdir(output)).sort(), [...names].sort());
  const [first, second] = await Promise.all([0, 1].map((index) => readFile(join(output, `subject_TransformParameters.${index}.toml`), 'utf8')));
  assert.equal(toml(second, 'InitialTransformParameterFileName'), 'subject_TransformParameters.0.toml');
  const shift = toml(first, 'TransformParameters')[0] + toml(second, 'TransformParameters')[3];
  // The moving blob sits 2 voxels (4 mm) towards +i; i runs along LPS x here.
  assert.ok(Math.abs(Math.abs(shift) - 4) < 0.2, `recovered ${shift} mm`);
  assert.equal((await readFile(join(output, 'subject_transform.h5'))).subarray(0, 8).toString('latin1'), '\x89HDF\r\n\x1a\n');
  const store = ZipFileStore.fromBlob(new Blob([await readFile(join(output, 'subject_transform.ome.zarr.ozx'))]));
  const [transformation] = JSON.parse(new TextDecoder().decode(await store.get('/zarr.json'))).attributes.ome.coordinateTransformations;
  assert.equal(transformation.name, 'fixed_to_moving');
  assert.ok(['translation', 'affine'].includes(transformation.type), transformation.type);
  const again = run([moving, fixed, output, '--method', 'rigid']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /is not empty/);
});

test('a B-spline registration writes a displacement field archive and no HDF5 transform', async (t) => {
  const { directory, moving, fixed } = await workspace(t);
  const output = join(directory, 'results');
  const result = run([moving, fixed, output, '--method', 'bspline', '--resolutions', '1', '--grid-spacing', '16']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No subject_transform\.h5/);
  assert.ok(!(await readdir(output)).includes('subject_transform.h5'));
  const store = ZipFileStore.fromBlob(new Blob([await readFile(join(output, 'subject_transform.ome.zarr.ozx'))]));
  const root = JSON.parse(new TextDecoder().decode(await store.get('/zarr.json')));
  assert.equal(root.attributes.ome.coordinateTransformations[0].type, 'displacements');
  const field = await zarr.get(await zarr.open(zarr.root(store).resolve('displacements/scale0'), { kind: 'array' }));
  assert.deepEqual(field.shape, [3, 20, 20, 20]);
  assert.ok(field.data.every(Number.isFinite));
});

for (const stages of [['rigid'], ['translation', 'rigid']]) {
  test(`custom TOML parameter files register the shifted image with ${stages.join(' and ')}`, async (t) => {
    const { directory, moving, fixed } = await workspace(t);
    const maps = [];
    for (const stage of stages) {
      const { parameterMap } = await defaultParameterMapNode(stage, { numberOfResolutions: 2 });
      maps.push({ ...parameterMap, DefaultPixelValue: ['-321'], AutomaticTransformInitialization: ['true'] });
    }
    const paths = stages.map((_, index) => join(directory, `parameters.${index ? 10 : 2}.toml`));
    await writeParameterFilesNode(maps, paths);
    const output = join(directory, 'custom');
    const result = run([moving, fixed, output, ...paths.toReversed().flatMap((path) => ['--parameter-file', path])]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\(parameter files\)/);
    const names = [
      'subject_registered.nii.gz', 'subject_transform.h5', 'subject_transform.ome.zarr.ozx',
      ...stages.map((_, index) => `subject_TransformParameters.${index}.toml`),
    ];
    assert.deepEqual(result.stdout.trim().split('\n'), names.map((name) => join(output, name)));
    assert.deepEqual((await readdir(output)).sort(), [...names].sort());
    const texts = await Promise.all(stages.map((_, index) => readFile(join(output, `subject_TransformParameters.${index}.toml`), 'utf8')));
    assert.deepEqual(texts.map((text) => toml(text, 'Transform')), stages.map((stage) => stage === 'rigid' ? 'EulerTransform' : 'TranslationTransform'));
    for (const [index, text] of texts.entries()) {
      assert.equal(toml(text, 'DefaultPixelValue'), -321);
      assert.equal(toml(text, 'InitialTransformParameterFileName'), index ? `subject_TransformParameters.${index - 1}.toml` : 'NoInitialTransform');
    }
    const matrix = fixedToMovingRas(texts);
    const expected = [[1, 0, 0, 4], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        assert.ok(Math.abs(matrix[row][column] - expected[row][column]) < 0.2, `composed transform [${row}, ${column}] = ${matrix[row][column]}`);
      }
    }
    const registered = await readVolume(await readFile(join(output, 'subject_registered.nii.gz')));
    const template = await readVolume(await readFile(fixed));
    assert.deepEqual(registered.dims, template.dims);
    const foreground = template.data.map((value) => value > 10 ? 1 : 0);
    const actual = Array.from(registered.data).filter((_, index) => foreground[index]);
    const target = Array.from(template.data).filter((_, index) => foreground[index]);
    assert.ok(ncc(actual, target) > 0.99, 'registered foreground matches the fixed image');
    assert.ok(registered.data.includes(-321), 'resampling uses the custom padding value');
    assert.equal((await readFile(join(output, 'subject_transform.h5'))).subarray(0, 8).toString('latin1'), '\x89HDF\r\n\x1a\n');
    const store = ZipFileStore.fromBlob(new Blob([await readFile(join(output, 'subject_transform.ome.zarr.ozx'))]));
    const [transformation] = JSON.parse(new TextDecoder().decode(await store.get('/zarr.json'))).attributes.ome.coordinateTransformations;
    assert.equal(transformation.name, 'fixed_to_moving');
    assert.ok(['translation', 'affine'].includes(transformation.type), transformation.type);
  });
}

test('a folder or a DICOM-like file is refused with a hint', async (t) => {
  const { directory, fixed } = await workspace(t);
  await mkdir(join(directory, 'image.zarr'));
  await writeFile(join(directory, 'IM0001'), 'not an image');
  assert.match(run([join(directory, 'image.zarr'), fixed, join(directory, 'a')]).stderr, /is a folder/);
  assert.match(run([join(directory, 'IM0001'), fixed, join(directory, 'b')]).stderr, /Convert DICOM with dcm2niix first/);
});

test('the command line exports eligible OME-TIFF with the same registered pixels and stationary calibration', async (t) => {
  const { directory } = await workspace(t);
  const moving = join(directory, 'moving.ome.tif');
  const fixed = join(directory, 'fixed.ome.tif');
  const make = (shift) => ({
    imageType: { dimension: 3, componentType: 'float32', pixelType: 'Scalar', components: 1 },
    name: 'blob', size: [20, 20, 20], origin: [0, 0, 0], spacing: [0.5, 0.5, 0.5],
    direction: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    data: Float32Array.from({ length: 8000 }, (_, index) => {
      const x = index % 20, y = Math.floor(index / 20) % 20, z = Math.floor(index / 400);
      return 1000 * Math.exp(-((x - 9 - shift) ** 2 + (y - 10) ** 2 + 0.5 * (z - 10) ** 2) / 12);
    }),
  });
  await writeFile(moving, await writeOmeTiff(make(2), { x: 'micrometer', y: 'micrometer', z: 'micrometer' }));
  await writeFile(fixed, await writeOmeTiff(make(0), { x: 'micrometer', y: 'micrometer', z: 'micrometer' }));
  const output = join(directory, 'tiff-results');
  const result = run([moving, fixed, output, '--method', 'rigid', '--resolutions', '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes(join(output, 'moving_registered.ome.tif')));
  const tiff = await readInput(join(output, 'moving_registered.ome.tif'), 'registered');
  const nifti = await readImageNode(join(output, 'moving_registered.nii.gz'));
  assert.deepEqual(tiff.spatialUnits, { z: 'micrometer', y: 'micrometer', x: 'micrometer' });
  assert.deepEqual(tiff.image.size, [20, 20, 20]);
  assert.deepEqual(tiff.image.spacing, [0.5, 0.5, 0.5]);
  assert.deepEqual(tiff.image.data, nifti.data);
});
