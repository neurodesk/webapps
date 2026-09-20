import test from 'node:test';
import assert from 'node:assert/strict';
import { normalArrows, surfaceNormals } from '../src/normal-arrows.js';
import { readMz3 } from '../src/results.js';

function plane() {
  const white = [];
  const faces = [];
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      white.push(x - 10, y - 10, -2);
      const i = y * 20 + x;
      if (x < 19 && y < 19) faces.push(i, i + 20, i + 1, i + 1, i + 20, i + 21);
    }
  }
  return surfaceNormals(Float64Array.from(white), Float64Array.from(white, (v, i) => i % 3 === 2 ? v + 2 : v), Int32Array.from(faces));
}

test('arrows are anchored in scanner RAS and point white-to-pial with the requested length', async () => {
  const field = plane();
  for (const length of [0.5, 3, 10]) {
    const arrows = normalArrows(field, { spacing: 8, length });
    const mesh = await readMz3(arrows.bytes);
    for (const [arrow, vertex] of arrows.indices.entries()) {
      const start = Array.from(field.middle.subarray(vertex * 3, vertex * 3 + 3));
      const tip = Array.from(mesh.vertices.subarray((arrow * 19 + 18) * 3, (arrow * 19 + 19) * 3));
      assert.deepEqual(tip, [start[0], start[1], start[2] + length]);
    }
    assert.ok(arrows.count > 0);
    assert.ok(mesh.faces.every((index) => index >= 0 && index < mesh.vertices.length / 3));
  }
});

test('density uses physical separation, including negative scanner coordinates', () => {
  const field = plane();
  const sparse = normalArrows(field, { spacing: 12, length: 3 });
  const dense = normalArrows(field, { spacing: 5, length: 3 });
  assert.ok(dense.count > sparse.count);
  for (const [spacing, { indices }] of [[12, sparse], [5, dense]]) {
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const distance = Math.hypot(...[0, 1, 2].map((axis) => field.middle[indices[i] * 3 + axis] - field.middle[indices[j] * 3 + axis]));
        assert.ok(distance >= spacing);
      }
    }
  }
  assert.throws(() => normalArrows(field, { spacing: 0, length: 3 }));
  assert.throws(() => normalArrows(field, { spacing: 8, length: NaN }));
});
