import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { cropToForeground, extractSlice, greyscale, modelSlice, readVolume, resizeBilinear, writeInputTensor } from '../src/slices.js';
import fixtures from './pillow-resize.json' with { type: 'json' };

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('bilinear resize matches Pillow 10.3 byte for byte (validation/pillow_fixture.py)', () => {
  for (const { rows, cols, sha256 } of fixtures) {
    const pixels = new Uint8Array(rows * cols);
    for (let i = 0; i < pixels.length; i++) pixels[i] = Number((BigInt(i) * 2654435761n) & 0xffffffffn) % 251;
    assert.equal(sha(resizeBilinear(pixels, rows, cols)), sha256, `${rows} x ${cols}`);
  }
});

// Expected bytes from ScalarMappable(cmap=Greys_r).to_rgba(a, bytes=True) in the original image.
test('greyscale maps the slice range through matplotlib Greys_r bytes', () => {
  assert.deepEqual([...greyscale(Float64Array.from([10, 20, 30]), 'float32')], [0, 150, 255]);
  assert.deepEqual([...greyscale(Float64Array.from([7, 7]), 'float32')], [0, 0]);
  assert.deepEqual([...greyscale(Float64Array.from([0, 1, 3]), 'float64')], [0, 104, 255]);
  assert.deepEqual([...greyscale(Float64Array.from([0, 1, NaN]), 'float32')], [0, 0, 0]);
  assert.deepEqual([...greyscale(Float64Array.from([0, 1, Infinity]), 'float32')], [0, 0, 0]);
  assert.deepEqual([...greyscale(Float64Array.from([-Infinity, 0, 1]), 'float64')], [0, 0, 0]);
});

test('cropping keeps the bounding box of positive voxels and slices rotate as np.rot90', () => {
  const dims = [4, 3, 2];
  const data = new Float64Array(24);
  const at = (i, j, k) => i + 4 * (j + 3 * k);
  data[at(1, 0, 0)] = 1;
  data[at(2, 2, 1)] = 5;
  data[at(3, 1, 1)] = -2;
  const cropped = cropToForeground({ dims, data, precision: 'float32' });
  assert.deepEqual(cropped.dims, [2, 3, 2]);
  assert.deepEqual(cropped.offset, [1, 0, 0]);
  // x slice: rows run along z reversed, columns along y.
  const x = extractSlice(cropped, 'x', 1);
  assert.deepEqual([x.rows, x.cols], [2, 3]);
  assert.deepEqual([...x.values], [0, 0, 5, 0, 0, 0]);
  const z = extractSlice(cropped, 'z', 0);
  assert.deepEqual([z.rows, z.cols], [3, 2]);
  assert.deepEqual([...z.values], [0, 0, 0, 0, 1, 0]);
  assert.throws(() => cropToForeground({ dims, data: new Float64Array(24), precision: 'float32' }), /no voxels above zero/);
});

test('the input tensor is ToTensor then ImageNet Normalize in float32', () => {
  const target = new Float32Array(3);
  writeInputTensor(Uint8Array.of(255), target);
  assert.deepEqual([...target], [Math.fround((1 - 0.485) / 0.229), Math.fround((1 - 0.456) / 0.224), Math.fround((1 - 0.406) / 0.225)]);
});

// Byte parity with the original container on the examples: set
// BRAINQCNET_EXAMPLE_DIR to a folder holding the two MR-ART example files.
for (const id of ['sub-000103-standard', 'sub-000103-headmotion2']) {
  test(`${id}: every 224 x 224 slice equals the original's`, { skip: !process.env.BRAINQCNET_EXAMPLE_DIR && 'BRAINQCNET_EXAMPLE_DIR not set' }, async () => {
    const reference = JSON.parse(await readFile(new URL(`../validation/references/${id}.json`, import.meta.url), 'utf8'));
    const bytes = await readFile(`${process.env.BRAINQCNET_EXAMPLE_DIR}/${reference.input.name}`);
    assert.equal(sha(bytes), reference.input.sha256);
    const cropped = cropToForeground(await readVolume(bytes));
    const mismatched = reference.slices.filter((s) => sha(modelSlice(cropped, s.axis, s.slice)) !== s.resized_sha256);
    assert.deepEqual(mismatched.map((s) => `${s.axis}${s.slice}`), []);
  });
}
