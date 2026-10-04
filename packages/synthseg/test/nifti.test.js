import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSynthseg } from '../src/wasm.js';

const types = [
  [2, 1, 'setUint8'],
  [256, 1, 'setInt8'],
  [4, 2, 'setInt16'],
  [512, 2, 'setUint16'],
  [8, 4, 'setInt32'],
  [768, 4, 'setUint32'],
  [16, 4, 'setFloat32'],
  [64, 8, 'setFloat64'],
];

function image([datatype, width, setter] = types[0], le = true, channels = 1) {
  const bytes = new Uint8Array(352 + 8 * channels * width);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, le);
  view.setInt16(40, channels === 1 ? 3 : 4, le);
  for (let axis = 1; axis < 8; axis++) {
    view.setInt16(40 + 2 * axis, axis < 4 ? 2 : axis === 4 ? channels : 1, le);
  }
  view.setInt16(70, datatype, le);
  for (let axis = 0; axis < 4; axis++) view.setFloat32(76 + 4 * axis, 1, le);
  view.setFloat32(108, 352, le);
  view.setFloat32(112, 1, le);
  bytes.set([110, 43, 49, 0], 344);
  for (let i = 0; i < 8 * channels; i++) view[setter](352 + width * i, i + 1, le);
  return bytes;
}

let wasm;
before(async () => {
  wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
});

test('WASM preprocessing preserves every scalar type in both byte orders', () => {
  const reference = new wasm.Segmenter(image());
  const expectedGeometry = reference.geometry;
  const expectedInput = reference.input();
  reference.free();
  for (const type of types) {
    for (const le of [true, false]) {
      const seg = new wasm.Segmenter(image(type, le));
      try {
        assert.deepEqual(seg.geometry, expectedGeometry, `datatype ${type[0]}, LE ${le}`);
        assert.deepEqual(seg.input(), expectedInput, `datatype ${type[0]}, LE ${le}`);
      } finally {
        seg.free();
      }
    }
  }
});

test('WASM averages big-endian channels before preprocessing', () => {
  const averaged = image(types[7]);
  const view = new DataView(averaged.buffer);
  for (let i = 0; i < 8; i++) view.setFloat64(352 + 8 * i, i + 5, true);
  const reference = new wasm.Segmenter(averaged);
  const actual = new wasm.Segmenter(image(types[7], false, 2));
  try {
    assert.deepEqual(actual.geometry, reference.geometry);
    assert.deepEqual(actual.input(), reference.input());
  } finally {
    reference.free();
    actual.free();
  }
});

test('WASM retains reader error priority and exact messages', () => {
  const invalid = image();
  const view = new DataView(invalid.buffer);
  view.setInt16(42, 1, true);
  view.setInt16(70, 32, true);
  view.setFloat32(108, 0, true);
  assert.throws(() => new wasm.Segmenter(invalid), { message: 'Unsupported image dimensions.' });
  view.setInt16(42, 2, true);
  assert.throws(() => new wasm.Segmenter(invalid), {
    message: 'Unsupported NIfTI datatype 32. Use a scalar intensity image.',
  });
  view.setInt16(70, 2, true);
  assert.throws(() => new wasm.Segmenter(invalid), { message: 'Invalid NIfTI vox_offset.' });
  view.setFloat32(108, 352, true);
  assert.throws(() => new wasm.Segmenter(invalid.subarray(0, 359)), {
    message: 'The NIfTI voxel data is truncated.',
  });
});
