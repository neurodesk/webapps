import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGreedySingleThread } from '../src/single.js';

const N = 32;

// A 2 mm float32 NIfTI-1 volume with a smooth ellipsoid and texture.
function phantom() {
  const bytes = new Uint8Array(352 + 4 * N ** 3);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  for (const [i, n] of [3, N, N, N, 1, 1, 1, 1].entries()) view.setInt16(40 + 2 * i, n, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (const [i, value] of [1, 2, 2, 2, 1, 1, 1, 1].entries()) view.setFloat32(76 + 4 * i, value, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  [[2, 0, 0, -32], [0, 2, 0, -32], [0, 0, 2, -32]].forEach((row, r) => row.forEach((value, c) => view.setFloat32(280 + 16 * r + 4 * c, value, true)));
  bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
  const c = N / 2;
  let offset = 352;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const r = Math.hypot((x - c) / 9, (y - c) / 7, (z - c) / 6);
        view.setFloat32(offset, 100 / (1 + Math.exp((r - 1) * 8)) + 10 * Math.sin(x / 2) * Math.cos(y / 3), true);
        offset += 4;
      }
    }
  }
  return bytes;
}

test('the single-threaded build runs without a thread pool', async () => {
  const api = await loadGreedySingleThread();
  assert.equal(api.initThreadPool, undefined);
  assert.ok(api.memoryBytes() > 0);
  // Fixed to moving +4 mm in x: each output voxel takes the moving voxel two along.
  const moving = phantom();
  const resliced = api.reslice_affine_options(moving, moving, '1 0 0 4\n0 1 0 0\n0 0 1 0\n0 0 0 1\n', false, 0);
  const at = (bytes, x, y, z) => new DataView(bytes.buffer, bytes.byteOffset).getFloat32(352 + 4 * (x + N * (y + N * z)), true);
  for (const [x, y, z] of [[10, 16, 16], [16, 12, 20], [5, 20, 9]]) {
    assert.ok(Math.abs(at(resliced, x, y, z) - at(moving, x + 2, y, z)) < 1e-4, `voxel ${x}, ${y}, ${z}`);
  }
});

test('the rigid export recovers a translation with an orthonormal matrix', async () => {
  const api = await loadGreedySingleThread();
  const fixed = phantom();
  // The moving image is the fixed one 4 mm along x: fixed point p maps to moving point p - 4 x.
  const moving = api.reslice_affine_options(fixed, fixed, '1 0 0 4\n0 1 0 0\n0 0 1 0\n0 0 0 1\n', false, 0);
  const rows = api.register_rigid_masked_wasm(fixed, moving, null, 'NMI', '100x50x10', false, null).trim().split('\n').map((line) => line.split(' ').map(Number));
  const rotation = rows.slice(0, 3).map((row) => row.slice(0, 3));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = rotation.reduce((sum, row) => sum + row[i] * row[j], 0);
      assert.ok(Math.abs(dot - (i === j ? 1 : 0)) < 1e-9, `columns ${i}, ${j}`);
    }
  }
  assert.ok(Math.abs(rows[0][3] + 4) < 0.5, `x translation ${rows[0][3]}`);
});
