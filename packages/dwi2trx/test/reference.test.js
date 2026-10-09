import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { TENSOR_MAPS } from '../src/tensor.js';
import { compare, summarize } from '../validation/reference.mjs';

// A float32 NIfTI-1 on a 2 mm 6^3 grid, `frames` volumes of a smooth ramp.
function map({ frames = 1, scale = 1, edit = () => {} } = {}) {
  const voxels = 6 ** 3 * frames;
  const bytes = Buffer.alloc(352 + voxels * 4);
  bytes.writeInt32LE(348, 0);
  [frames > 1 ? 4 : 3, 6, 6, 6, frames].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  for (const [offset, number] of [[70, 16], [72, 32], [252, 1], [254, 1]]) bytes.writeInt16LE(number, offset);
  for (const [offset, number] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1], [280, 2], [300, 2], [320, 2]]) bytes.writeFloatLE(number, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < voxels; i += 1) bytes.writeFloatLE(scale * (i % 17) / 20, 352 + 4 * i);
  edit(bytes);
  return gzipSync(bytes);
}

const frames = (name) => ({ V1: 3, V2: 3, V3: 3, tensor: 6 })[name] ?? 1;
const maps = (name, change) => Object.fromEntries(TENSOR_MAPS.map((each) => [each, summarize(map({ frames: frames(each), ...(each === name ? change : {}) }))]));
const reference = maps();
const failed = (actual) => compare('command line', actual, reference, 'browser reference').filter(([passed]) => !passed).map(([, line]) => line);

test('identical maps pass every check', () => {
  assert.deepEqual(failed(maps()), []);
});

test('each check fails on the change it guards, in the map that changed', () => {
  const cases = [
    ['FA', 'one voxel changed', { edit: (bytes) => bytes.writeFloatLE(0.5001, 352 + 40) }, /FA voxels .* differs in fileSha256, voxelSha256, mean, std/],
    ['MD', 'scaled by 1.01', { scale: 1.01 }, /MD voxels .* differs in fileSha256, voxelSha256, maximum, mean, std/],
    ['V1', 'sform moved 1 mm', { edit: (bytes) => bytes.writeFloatLE(1, 292) }, /V1 header geometry/, /V1 voxels .* differs in fileSha256, headerSha256$/],
    ['tensor', 'description rewritten', { edit: (bytes) => bytes.write('other', 148, 'latin1') }, /tensor voxels .* differs in fileSha256, headerSha256$/],
    ['S0', 'one NaN voxel', { edit: (bytes) => bytes.writeFloatLE(Number.NaN, 352 + 8) }, /S0 voxels .* differs in fileSha256, voxelSha256, nonFinite/],
  ];
  for (const [name, description, change, ...expected] of cases) {
    const lines = failed(maps(name, change));
    assert.equal(lines.length, expected.length, `${description}: ${JSON.stringify(lines)}`);
    expected.forEach((pattern, i) => assert.match(lines[i], pattern, description));
  }
});

test('a missing map fails', () => {
  const actual = maps();
  delete actual.MO;
  assert.deepEqual(failed(actual), ['command line MO present in both outputs']);
});
