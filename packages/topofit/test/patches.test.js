import assert from 'node:assert/strict';
import test from 'node:test';
import { erodeCortex, findPatches, surfaceNormals, validatePatchOptions } from '../src/patches.js';
import { mapCortex } from '../src/cortex-atlas.js';

export function plane(size = 31, slope = 0) {
  const white = [];
  const pial = [];
  const faces = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      white.push(x, y, slope * x);
      pial.push(x, y, slope * x + 2);
      if (x + 1 < size && y + 1 < size) {
        const a = x + y * size;
        faces.push(a, a + 1, a + size, a + 1, a + size + 1, a + size);
      }
    }
  }
  return { white: Float64Array.from(white), pial: Float64Array.from(pial), faces: Int32Array.from(faces) };
}

test('mid-ribbon normals have unit length and point white-to-pial under either winding', () => {
  const { white, pial, faces } = plane(8, 0.3);
  for (const triangles of [faces, Int32Array.from(Array.from(faces).reverse())]) {
    const { middle, normals } = surfaceNormals(white, pial, triangles);
    assert.equal(middle[2], 1);
    for (let i = 0; i < normals.length; i += 3) {
      assert.ok(Math.abs(Math.hypot(...normals.subarray(i, i + 3)) - 1) < 1e-12);
      assert.ok(normals[i + 2] > 0);
      assert.ok(Math.abs(normals[i] + 0.3 / Math.hypot(1, 0.3)) < 1e-12);
    }
  }
});

test('planar patches satisfy area, RMS, signed coherence and disjointness', () => {
  const { white, pial, faces } = plane(31, 0.3);
  const { middle } = surfaceNormals(white, pial, faces);
  const patches = findPatches(middle, faces, new Uint8Array(white.length / 3).fill(1));
  assert.equal(patches.length, 3);
  const used = new Set();
  for (const patch of patches) {
    assert.ok(patch.rms < 1e-6);
    assert.ok(patch.coherence > 0.999999);
    assert.ok(patch.area >= Math.PI * 100 * 0.25);
    assert.ok(patch.indices.some((i) => patch.center.every((v, axis) => v === middle[i * 3 + axis])));
    for (const i of patch.indices) {
      assert.ok(!used.has(i));
      used.add(i);
    }
  }
});

test('small and excluded regions do not produce a relaxed fallback patch', () => {
  const { white, pial, faces } = plane(3);
  const { middle } = surfaceNormals(white, pial, faces);
  assert.deepEqual(findPatches(middle, faces, new Uint8Array(9).fill(1)), []);
  assert.deepEqual(findPatches(middle, faces, new Uint8Array(9)), []);
});

test('medial-wall margin follows mesh-edge distance and excludes the 5 mm boundary', () => {
  const { white, faces } = plane(12);
  const cortex = Uint8Array.from({ length: 144 }, (_, i) => i % 12 > 0 ? 1 : 0);
  const eligible = erodeCortex(white, faces, cortex);
  assert.equal(eligible[5], 0);
  assert.equal(eligible[6], 1);
});

test('registration mapping normalizes spheres before nearest-neighbor lookup', () => {
  const atlas = { points: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), lh: new Uint8Array([1, 0, 1]) };
  assert.deepEqual(mapCortex(new Float32Array([99, 1, 0, 0, 100, 0]), atlas, 'lh'), new Uint8Array([1, 0]));
  assert.throws(() => mapCortex(new Float32Array(3), atlas, 'lh'), /Invalid/);
});

test('patch settings reject invalid numerical and hemisphere values', () => {
  for (const options of [{ radius: NaN }, { radius: 1.5 }, { count: 1.5 }, { count: 51 }, { hemisphere: 'left' }, { maxRms: 3 }]) assert.throws(() => validatePatchOptions(options));
});

test('patch settings accept small radii and many patches', () => {
  assert.deepEqual(validatePatchOptions({ radius: 2, count: 50 }), { radius: 2, count: 50, hemisphere: 'both', maxRms: 0.5, minAreaFraction: 0.25 });
});
