import test from 'node:test';
import assert from 'node:assert/strict';

import { isCurvFormat, readCurvValues } from '../src/io/freesurferCurv.js';

/** A FreeSurfer "new format" curv file: 3 magic bytes, 3 big-endian uint32, data. */
function makeCurv(values, { vertexCount = values.length, frames = 1 } = {}) {
  const buffer = new ArrayBuffer(15 + values.length * 4);
  const view = new DataView(buffer);
  view.setUint8(0, 255);
  view.setUint8(1, 255);
  view.setUint8(2, 255);
  view.setUint32(3, vertexCount, false);
  view.setUint32(7, vertexCount * 2, false);
  view.setUint32(11, frames, false);
  values.forEach((value, at) => view.setFloat32(15 + at * 4, value, false));
  return buffer;
}

test('the magic bytes are what identify the format', () => {
  assert.ok(isCurvFormat(makeCurv([1, 0, 1])));
  assert.ok(!isCurvFormat(new ArrayBuffer(40)));
  assert.ok(!isCurvFormat(new ArrayBuffer(4)), 'too short to hold a header');
  assert.ok(!isCurvFormat(null));
});

test('the values come back as the file wrote them', () => {
  // The reason this reader exists. NiiVue's readCURV does
  // `1 - (v - min) * scale`, so it would hand back [0, 1, 0] for this file —
  // a mask covering precisely the vertices the file excludes.
  const values = readCurvValues(makeCurv([1, 0, 1]), 3);
  assert.deepEqual([...values], [1, 0, 1]);

  const signed = readCurvValues(makeCurv([-0.5, 0, 0.25]), 3);
  assert.deepEqual([...signed], [-0.5, 0, 0.25]);
});

test('a mask for a different mesh is refused, not silently misread', () => {
  assert.throws(() => readCurvValues(makeCurv([1, 0, 1]), 4), /different mesh/);
  assert.throws(() => readCurvValues(new ArrayBuffer(40), 4), /not a FreeSurfer curv/);
});

test('a truncated file is refused', () => {
  const short = makeCurv([1, 0, 1]).slice(0, 20);
  assert.throws(() => readCurvValues(short, 3), /shorter than its header/);
});

test('only the first frame of a multi-frame file is read', () => {
  const buffer = makeCurv([1, 0, 1, 9, 9, 9], { vertexCount: 3, frames: 2 });
  assert.deepEqual([...readCurvValues(buffer, 3)], [1, 0, 1]);
});
