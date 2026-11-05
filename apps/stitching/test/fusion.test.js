import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseTiles, fusedGeometry, toSampleType } from '../src/core/fusion.js';

test('the fused image spans every tile, from the floor of the smallest position', () => {
  assert.deepEqual(fusedGeometry([[10, 8], [10, 8]], [[0.4, -2.5], [7.2, 1]]), { origin: [0, -3], shape: [18, 12] });
});

test('one tile at an integer position is copied unchanged', () => {
  const data = Float32Array.from({ length: 12 }, (_, i) => i * 3);
  const { data: fused, shape } = fuseTiles([{ shape: [4, 3], data }], [[5, 7]]);
  assert.deepEqual(shape, [4, 3]);
  assert.deepEqual(Array.from(fused), Array.from(data));
});

test('constant tiles fuse to the same constant, with zero where no tile reaches', () => {
  const tile = (value) => ({ shape: [6, 4], data: new Float32Array(24).fill(value) });
  const { data, shape } = fuseTiles([tile(10), tile(10)], [[0, 0], [3.5, 2]]);
  assert.deepEqual(shape, [10, 6]);
  for (let y = 0; y < shape[1]; y++) {
    for (let x = 0; x < shape[0]; x++) {
      const inside = (x < 6 && y < 4) || (x >= 4 && x <= 8 && y >= 2);
      assert.ok(Math.abs(data[y * shape[0] + x] - (inside ? 10 : 0)) < 1e-5, `pixel ${x}, ${y}`);
    }
  }
});

test('linear blending fades from one tile to the other across the overlap', () => {
  const a = { shape: [10, 1], data: new Float32Array(10).fill(0) };
  const b = { shape: [10, 1], data: new Float32Array(10).fill(100) };
  const { data } = fuseTiles([a, b], [[0, 0], [5, 0]]);
  // Overlap x = 5…9: each tile's weight is its distance to its nearer edge, from 1.
  const edge = (u) => Math.min(u + 1, 10 - u);
  for (let x = 5; x < 10; x++) assert.ok(Math.abs(data[x] - (100 * edge(x - 5)) / (edge(x) + edge(x - 5))) < 1e-4, `x = ${x}`);
  assert.equal(data[4], 0);
  assert.equal(data[10], 100);
});

test('a sub-pixel position interpolates linearly, in 3D too', () => {
  const data = Float32Array.from({ length: 8 }, (_, i) => i);
  const { data: fused, shape, origin } = fuseTiles([{ shape: [2, 2, 2], data }], [[0.25, 0, 0]]);
  assert.deepEqual(origin, [0, 0, 0]);
  assert.deepEqual(shape, [3, 2, 2]);
  // Output x = 1 samples the tile at x = 0.75.
  assert.ok(Math.abs(fused[1] - 0.75) < 1e-6);
  assert.ok(Math.abs(fused[1 + 3 * 2] - 4.75) < 1e-6);
});

test('integer sample types are rounded and clamped', () => {
  assert.deepEqual(Array.from(toSampleType(Float32Array.from([-3, 1.5, 70000]), 'uint16')), [0, 2, 65535]);
  assert.ok(toSampleType(Float32Array.from([1.5]), 'float32') instanceof Float32Array);
});

test('32-bit integer and float tiles keep their values exactly where one tile covers a pixel', () => {
  const cases = [
    ['uint32', Uint32Array.from([16777217, 4294967295, 0, 7])],
    ['int32', Int32Array.from([-16777217, 2147483647, -2147483648, 3])],
    ['float32', Float32Array.from([3e38, -3e38, 1.5, 1e-30])],
    ['float64', Float64Array.from([1e100, -1e300, 0.1, 16777217.25])],
  ];
  for (const [dtype, data] of cases) {
    const fused = fuseTiles([{ shape: [2, 2], data }], [[3, 4]]);
    assert.ok(fused.data instanceof Float64Array, dtype);
    assert.deepEqual(Array.from(toSampleType(fused.data, dtype)), Array.from(data), dtype);
  }
});

test('32-bit tiles blend in float64: overlapping uint32 and float32 tiles keep their common value', () => {
  for (const data of [new Uint32Array(24).fill(16777217), new Float32Array(24).fill(3e38)]) {
    const tile = { shape: [6, 4], data };
    const { data: fused } = fuseTiles([tile, tile], [[0, 0], [2.5, 1]]);
    for (let i = 0; i < fused.length; i++) if (fused[i] !== 0) assert.ok(Math.abs(fused[i] - data[0]) / data[0] < 1e-12, `pixel ${i}: ${fused[i]}`);
  }
});
