import test from 'node:test';
import assert from 'node:assert/strict';
import { ballKernel, brightTiles, createDetector, deriveSettings, dtypeLimits, gaussianKernel, median3x3, StructureDetector } from '../src/detect.js';

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

// Two Gaussian somata (3 µm SD in plane, 4 µm across planes) on noise, at 5 × 2 × 2 µm.
const [Z, H, W] = [24, 64, 64];
const CENTRES = [[20, 20, 12], [44, 40, 11]];
function spheres(Type, scale = 1) {
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 20;
  return Array.from({ length: Z }, (_, z) => {
    const plane = new Type(H * W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 100 + noise();
        for (const [cx, cy, cz] of CENTRES) v += 3000 * Math.exp(-(((x - cx) * 2) ** 2 + ((y - cy) * 2) ** 2) / 18 - ((z - cz) * 5) ** 2 / 32);
        plane[y * W + x] = v * scale;
      }
    }
    return plane;
  });
}

function detect(planes, dtype) {
  const detector = createDetector({ height: H, width: W, voxelSizesUm: [5, 2, 2], dtype });
  for (const plane of planes) detector.push(plane);
  return detector.finish().cells;
}

function assertCentres(cells) {
  assert.equal(cells.length, 2, JSON.stringify(cells));
  for (const [cx, cy, cz] of CENTRES) {
    assert.ok(cells.some(([x, y, z]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1 && Math.abs(z - cz) <= 1), JSON.stringify(cells));
  }
}

test('two separate bright spheres give two candidates at their centres', () => {
  assertCentres(detect(spheres(Uint16Array), 'uint16'));
});

test("clipping, threshold and soma values follow the sample type, as cellfinder's DetectionSettings", () => {
  assert.deepEqual(dtypeLimits('uint16'), { clippingValue: 65533, thresholdValue: 65534, somaValue: 65535 });
  assert.deepEqual(dtypeLimits('uint8'), { clippingValue: 253, thresholdValue: 254, somaValue: 255 });
  assert.deepEqual(dtypeLimits('int16'), { clippingValue: 32765, thresholdValue: 32766, somaValue: 32767 });
  assert.deepEqual(dtypeLimits('float32'), { clippingValue: 2 ** 23 - 2, thresholdValue: 2 ** 23 - 1, somaValue: 2 ** 23 });
  // cellfinder filters these in float64; the port refuses them rather than clipping them flat.
  for (const dtype of ['uint32', 'int32', 'float64']) assert.throws(() => dtypeLimits(dtype), /8- and 16-bit integer and float32/);
  assert.throws(() => createDetector({ height: H, width: W, voxelSizesUm: [5, 2, 2], dtype: 'uint32' }), /this stack is uint32/);
});

test('float32 intensities above the uint16 range are not clipped flat', () => {
  // Scaled 1000-fold every voxel is above 65,533 (background 1e5, somata 3e6, under 2 ** 23): a
  // uint16 clip would leave a flat image and no candidates.
  assertCentres(detect(spheres(Float32Array, 1000), 'float32'));
});

test('a structure that gains no voxel on a plane is handed over and dropped', () => {
  const closed = [];
  const detector = new StructureDetector(2, 3, 0, { onClose: (id, points) => closed.push([id, points.length]) });
  const plane = (...on) => (i) => on.includes(i);
  detector.process(plane(0, 2));
  detector.process(plane(0));
  // The structure at pixel 2 did not continue onto plane 1.
  assert.deepEqual(closed, [[2, 1]]);
  assert.deepEqual([...detector.structures.keys()], [1]);
  assert.equal(detector.openPoints, 2);
  detector.process(plane());
  assert.deepEqual(closed, [[2, 1], [1, 2]]);
  assert.equal(detector.structures.size, 0);
  assert.equal(detector.obsolete.size, 0);
});

test('too many open soma voxels are refused', () => {
  const detector = new StructureDetector(2, 2, 0, { onClose: () => {}, maxOpenPoints: 3 });
  assert.throws(() => detector.process(() => true), /More than 3 soma voxels are in open structures/);
});
