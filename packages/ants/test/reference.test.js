import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { compare, readAffine, summarize } from '../validation/reference.mjs';

const SIZE = 8;
const VOXELS = SIZE ** 3;

// An 8^3 float32 NIfTI-1 on a 2 mm grid, with `components` values per voxel (3 for a warp,
// stored as ITK does: dims 5, intent vector) taken from `value(i)`.
function volume(value, { components = 1, edit = () => {} } = {}) {
  const bytes = Buffer.alloc(352 + VOXELS * components * 4);
  bytes.writeInt32LE(348, 0);
  const dims = components === 1 ? [3, SIZE, SIZE, SIZE, 1, 1] : [5, SIZE, SIZE, SIZE, 1, components];
  dims.forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  for (const [offset, number] of [[70, 16], [72, 32], [252, 1], [254, 1]]) bytes.writeInt16LE(number, offset);
  for (const [offset, number] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1], [280, 2], [292, -8], [300, 2], [308, -8], [320, 2], [324, -8]]) bytes.writeFloatLE(number, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < VOXELS * components; i += 1) bytes.writeFloatLE(value(i), 352 + 4 * i);
  edit(bytes);
  return gzipSync(bytes);
}

// A MATLAB level 4 matrix as ITK writes it: single precision, column vector.
function matrix(name, values) {
  const header = Buffer.alloc(20);
  [10, values.length, 1, 0, name.length + 1].forEach((number, i) => header.writeInt32LE(number, 4 * i));
  const data = Buffer.alloc(4 * values.length);
  values.forEach((number, i) => data.writeFloatLE(number, 4 * i));
  return Buffer.concat([header, Buffer.from(`${name}\0`, 'latin1'), data]);
}

const AFFINE = [1.02, 0.01, -0.02, -0.01, 0.98, 0.03, 0.02, -0.03, 1.01, 1.5, -2.25, 3];
const affine = (parameters = AFFINE) => Buffer.concat([matrix('AffineTransform_float_3_3', parameters), matrix('fixed', [0.5, -1, 2])]);

const fixed = volume((i) => (i % 7) * 10 + 5);
function outputs({ scale = 1, offset = 0, edit, role = 'registered', parameters } = {}) {
  const change = (name) => (name === role ? { scale, offset, edit } : { scale: 1, offset: 0 });
  const image = change('registered');
  const warp = change('warp');
  const inverse = change('inverse-warp');
  return {
    registered: volume((i) => ((i % 5) * 20 + (i % 7) * 3) * image.scale + image.offset, { edit: image.edit }),
    warp: volume((i) => (Math.sin(i) * 2) * warp.scale + warp.offset, { components: 3, edit: warp.edit }),
    'inverse-warp': volume((i) => (Math.cos(i) * 2) * inverse.scale + inverse.offset, { components: 3, edit: inverse.edit }),
    affine: affine(parameters),
  };
}

const reference = summarize(outputs(), fixed);
const failing = (files) => compare('test', summarize(files, fixed), reference, 'browser')
  .filter(([passed]) => !passed)
  .map(([, line]) => line.replace(/^test /, '').replace(/ (lies|header|voxels|voxel|correlation|bytes|parameters).*$/, ' $1'));

test('the affine reader returns ITK\'s parameters and fixed centre', () => {
  const { transform, parameters, fixed: centre } = readAffine(affine());
  assert.equal(transform, 'AffineTransform_float_3_3');
  assert.deepEqual(parameters.map((value) => Number(value.toFixed(5))), AFFINE);
  assert.deepEqual(centre, [0.5, -1, 2]);
});

test('outputs identical to the reference pass every comparison', () => {
  assert.deepEqual(failing(outputs()), []);
});

test('scaling the registered image fails its voxel hash, mean and std', () => {
  assert.deepEqual(failing(outputs({ scale: 1.01 })), ['registered voxels', 'registered voxel', 'registered voxel']);
});

test('offsetting the registered image fails its voxel hash and mean, and correlation cannot see either', () => {
  assert.deepEqual(failing(outputs({ offset: 1 })), ['registered voxels', 'registered voxel']);
});

test('a misaligned registered image fails its hash, statistics and correlation with the fixed brain', () => {
  const shifted = outputs();
  const values = outputs().registered;
  shifted.registered = volume((i) => (((i + 3) % 5) * 20 + ((i + 3) % 7) * 3));
  assert.notDeepEqual(shifted.registered, values);
  assert.deepEqual(failing(shifted), ['registered voxels', 'registered voxel', 'registered voxel', 'registered correlation']);
});

for (const role of ['warp', 'inverse-warp']) {
  test(`scaling the ${role} fails its voxel hash, mean and std`, () => {
    assert.deepEqual(failing(outputs({ role, scale: 1.01 })), [`${role} voxels`, `${role} voxel`, `${role} voxel`]);
  });
}

for (const role of ['registered', 'warp', 'inverse-warp']) {
  test(`a ${role} moved off the fixed grid fails both geometry checks`, () => {
    const files = outputs({ role, edit: (bytes) => bytes.writeFloatLE(bytes.readFloatLE(292) + 1, 292) });
    assert.deepEqual(failing(files), [`${role} lies`, `${role} header`]);
  });

  test(`a ${role} whose stored qform differs but whose sform still places it on the grid fails the header check`, () => {
    const files = outputs({ role, edit: (bytes) => bytes.writeFloatLE(bytes.readFloatLE(268) + 1, 268) });
    assert.deepEqual(failing(files), [`${role} header`]);
  });
}

test('an affine parameter changed beyond 1e-3 fails the affine bytes and parameters', () => {
  const parameters = AFFINE.map((value, i) => (i === 9 ? value + 0.01 : value));
  assert.deepEqual(failing(outputs({ parameters })), ['affine bytes', 'affine parameters']);
});

test('an affine change below 1e-3 fails only the byte gate', () => {
  const parameters = AFFINE.map((value, i) => (i === 0 ? value + 1e-6 : value));
  assert.deepEqual(failing(outputs({ parameters })), ['affine bytes']);
});
