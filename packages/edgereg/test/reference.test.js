import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { compareWithBrowser, compareWithNative, summarize } from '../validation/reference.mjs';

const SIZE = 16;
const VOXELS = SIZE ** 3;

// A 16^3 uint8 NIfTI-1 on a 1 mm grid holding a smooth blob, as allineate writes the example.
function volume({ value = blob, edit = () => {} } = {}) {
  const bytes = Buffer.alloc(352 + VOXELS);
  bytes.writeInt32LE(348, 0);
  [3, SIZE, SIZE, SIZE, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  for (const [offset, number] of [[70, 2], [72, 8], [252, 1], [254, 1]]) bytes.writeInt16LE(number, offset);
  for (const [offset, number] of [[76, 1], [80, 1], [84, 1], [88, 1], [108, 352], [112, 1], [280, 1], [292, -8], [300, 1], [308, -8], [320, 1], [324, -8]]) bytes.writeFloatLE(number, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < VOXELS; i += 1) bytes[352 + i] = Math.max(0, Math.min(255, Math.round(value(i))));
  edit(bytes);
  return bytes;
}

function blob(i, shift = 0) {
  const [x, y, z] = [i % SIZE, Math.floor(i / SIZE) % SIZE, Math.floor(i / SIZE ** 2)];
  return 250 * Math.exp(-((x - 8 - shift) ** 2 + (y - 7) ** 2 + (z - 8) ** 2) / 18);
}

const fixed = gzipSync(volume({ value: (i) => blob(i, 0.5) }));
const reference = summarize(volume(), fixed);
const failed = (checks) => checks.filter(([passed]) => !passed).map(([, line]) => line);

test('an identical download passes every browser check', () => {
  assert.deepEqual(failed(compareWithBrowser('command line', summarize(volume(), fixed), reference)), []);
});

test('each browser check fails on the output change it guards', () => {
  const cases = [
    ['one voxel one step brighter', { edit: (bytes) => { bytes[352 + 8 + SIZE * (7 + SIZE * 8)] += 1; } }, [/voxels .* identical/, /mean .* equal/, /correlation with the fixed image/]],
    ['header description rewritten', { edit: (bytes) => bytes.write('other', 148, 'latin1') }, [/header bytes/]],
    ['sform moved by 1 mm', { edit: (bytes) => bytes.writeFloatLE(-7, 292) }, [/fixed image's grid/, /header geometry/, /header bytes/]],
    ['intensities scaled by 1.01', { value: (i) => 1.01 * blob(i) }, [/voxels .* identical/, /value range/, /mean .* equal/]],
  ];
  for (const [name, change, expected] of cases) {
    const lines = failed(compareWithBrowser('command line', summarize(volume(change), fixed), reference));
    for (const pattern of expected) assert.ok(lines.some((line) => pattern.test(line)), `${name}: ${pattern} in ${JSON.stringify(lines)}`);
  }
});

test('native niimath passes within its tolerances and fails a shift, a rescale or another grid', () => {
  const cli = volume();
  assert.deepEqual(failed(compareWithNative(volume({ value: (i) => blob(i, 0.02) }), cli, fixed)), []);
  const cases = [
    ['shifted one voxel', volume({ value: (i) => blob(i, 1) }), [/correlate/, /99.9th percentile/]],
    ['scaled by 1.01', volume({ value: (i) => 1.01 * blob(i) }), [/voxel mean/, /voxel std/]],
    ['written on another grid', volume({ edit: (bytes) => bytes.writeFloatLE(2, 280) }), [/header geometry/]],
  ];
  for (const [name, native, expected] of cases) {
    const lines = failed(compareWithNative(native, cli, fixed));
    for (const pattern of expected) assert.ok(lines.some((line) => pattern.test(line)), `${name}: ${pattern} in ${JSON.stringify(lines)}`);
  }
});
