import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { compare, recorded, summarize } from '../validation/reference.mjs';

const SIZE = 8;

// An 8^3 float32 NIfTI-1 on a 2 mm grid whose voxel values come from `value(i)`.
function volume(value, edit = () => {}) {
  const bytes = Buffer.alloc(352 + SIZE ** 3 * 4);
  bytes.writeInt32LE(348, 0);
  for (const [offset, number] of [[40, 3], [42, SIZE], [44, SIZE], [46, SIZE], [48, 1], [70, 16], [72, 32], [252, 1], [254, 1]]) bytes.writeInt16LE(number, offset);
  for (const [offset, number] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1], [280, 2], [292, -8], [300, 2], [308, -8], [320, 2], [324, -8]]) bytes.writeFloatLE(number, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < SIZE ** 3; i += 1) bytes.writeFloatLE(value(i), 352 + 4 * i);
  edit(bytes);
  return gzipSync(bytes);
}

const fixed = volume((i) => (i % 7) * 10 + 5);
const registered = (scale = 1, offset = 0, edit) => volume((i) => ((i % 5) * 20 + (i % 7) * 3) * scale + offset, edit);
const reference = recorded(summarize(registered(), fixed));
const KINDS = ['header geometry equals', 'header geometry and', 'voxels', 'voxel mean', 'voxel std', 'correlation'];
const failing = (output) => compare('test', summarize(output, fixed), reference, 'browser')
  .filter(([passed]) => !passed)
  .map(([, line]) => KINDS.find((kind) => line.startsWith(`test ${kind}`)));

test('an output identical to the reference passes every comparison', () => {
  assert.deepEqual(failing(registered()), []);
});

test('scaling every voxel fails the voxel hash, mean and std, though correlation cannot see it', () => {
  assert.deepEqual(failing(registered(1.01)), ['voxels', 'voxel mean', 'voxel std']);
});

test('offsetting every voxel fails the voxel hash and mean', () => {
  assert.deepEqual(failing(registered(1, 1)), ['voxels', 'voxel mean']);
});

test('an output whose sform or qform differs from the fixed image fails the geometry checks', () => {
  for (const offset of [292, 268]) {
    const output = registered(1, 0, (bytes) => bytes.writeFloatLE(bytes.readFloatLE(offset) + 1, offset));
    assert.deepEqual(failing(output), ['header geometry equals', 'header geometry and'], `offset ${offset}`);
  }
});
