import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { inspectScientificImage } from '../scripts/lib/scientific-output-checks.mjs';

function nifti(data, frames = 1) {
  const bytes = new Uint8Array(352 + data.length * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [frames > 1 ? 4 : 3, 2, 2, 2, frames, 1, 1, 1].forEach((size, index) => view.setInt16(40 + index * 2, size, true));
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (const offset of [80, 84, 88, 112]) view.setFloat32(offset, 1, true);
  view.setFloat32(108, 352, true);
  bytes.set([110, 43, 49, 0], 344);
  data.forEach((value, index) => view.setFloat32(352 + index * 4, value, true));
  return gzipSync(bytes);
}

test('scientific output verification accepts 3D images and full 4D diffusion series', async () => {
  assert.deepEqual(await inspectScientificImage(nifti(Array(8).fill(1))), { dims: [2, 2, 2], frames: 1, voxels: 8 });
  assert.deepEqual(await inspectScientificImage(nifti(Array(16).fill(1), 2)), { dims: [2, 2, 2], frames: 2, voxels: 16 });
});

test('scientific output verification checks later diffusion frames', async () => {
  await assert.rejects(inspectScientificImage(nifti([...Array(15).fill(1), Number.NaN], 2)), /finite voxel values/);
  await assert.rejects(inspectScientificImage(nifti([...Array(15).fill(1), Infinity], 2)), /finite voxel values/);
});

test('mask verification rejects nonbinary output in any frame', async () => {
  await inspectScientificImage(nifti(Array(8).fill(1)), 'neuro:mask');
  await assert.rejects(inspectScientificImage(nifti([...Array(15).fill(1), 2], 2), 'neuro:mask'), /binary/);
});
