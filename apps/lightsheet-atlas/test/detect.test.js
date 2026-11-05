import test from 'node:test';
import assert from 'node:assert/strict';
import { ballKernel, brightTiles, createDetector, deriveSettings, gaussianKernel, median3x3 } from '../src/detect.js';

test('voxel parameters follow cellfinder for 5 × 2 × 2 µm', () => {
  const s = deriveSettings([5, 2, 2]);
  assert.equal(s.somaDiameter, 8);
  assert.deepEqual(s.ball, { xy: 3, z: 3 });
  assert.equal(s.maxClusterSize, 5000);
  assert.ok(Math.abs(s.maxCellVolume - (4 / 3) * Math.PI * 5.6 ** 3) < 1e-9);
  // Python's round() is half to even: 6 µm / 4 µm = 1.5 -> 2, 15 µm / 6 µm = 2.5 -> 2.
  assert.deepEqual(deriveSettings([6, 4, 4]).ball, { xy: 2, z: 2 });
});

test('coarse voxels are refused rather than giving meaningless cells', () => {
  assert.throws(() => deriveSettings([50, 40, 40]), /soma spans 0 pixels/);
  assert.throws(() => deriveSettings([40, 2, 2]), /0 planes deep/);
  assert.throws(() => deriveSettings([5, 12, 12]), /spans 1 pixels/);
});

test('the Gaussian kernel is scipy.ndimage._gaussian_kernel1d with truncate 4', () => {
  const k = gaussianKernel(1.6);
  assert.equal(k.length, 13);
  // scipy.ndimage._gaussian_kernel1d(1.6, 0, 6)[6] and [0]
  assert.ok(Math.abs(k[6] - 0.24934808125697797) < 1e-15, k[6]);
  assert.ok(Math.abs(k[0] - 0.00022038039379869577) < 1e-15, k[0]);
  assert.ok(Math.abs(k.reduce((a, b) => a + b) - 1) < 1e-15);
});

test('the median filter pads with zeros as scipy.signal.medfilt2d does', () => {
  const out = median3x3(Float32Array.from([9, 9, 9, 9, 9, 9, 9, 9, 9]), 3, 3);
  assert.deepEqual([...out], [0, 9, 0, 9, 9, 9, 0, 9, 0]);
});

test('the ball kernel is symmetric and its centre fully inside', () => {
  const k = ballKernel(3, 3);
  assert.equal(k[13], 1);
  assert.equal(k[0], k[26]);
  assert.ok(k[0] > 0 && k[0] < 0.2, String(k[0]));
});

test('tiles brighter than the corner tile are in the brain', () => {
  const plane = new Float32Array(32 * 32).fill(10);
  for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) plane[y * 32 + x] = 100;
  const tiles = brightTiles(plane, 32, 32, 16);
  assert.deepEqual([...tiles.mask], [0, 0, 0, 1]);
});

test('two separate bright spheres give two candidates at their centres', () => {
  const [Z, H, W] = [24, 64, 64];
  const voxel = [5, 2, 2];
  const centres = [[20, 20, 12], [44, 40, 11]];
  const detector = createDetector({ height: H, width: W, voxelSizesUm: voxel });
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 20;
  for (let z = 0; z < Z; z++) {
    const plane = new Uint16Array(H * W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 100 + noise();
        // Gaussian somata, 3 µm standard deviation in plane and 4 µm across planes.
        for (const [cx, cy, cz] of centres) v += 3000 * Math.exp(-(((x - cx) * 2) ** 2 + ((y - cy) * 2) ** 2) / 18 - ((z - cz) * 5) ** 2 / 32);
        plane[y * W + x] = v;
      }
    }
    detector.push(plane);
  }
  const { cells } = detector.finish();
  assert.equal(cells.length, 2);
  for (const [cx, cy, cz] of centres) {
    assert.ok(cells.some(([x, y, z]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1 && Math.abs(z - cz) <= 1), JSON.stringify(cells));
  }
});
