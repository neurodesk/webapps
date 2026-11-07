import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, formatMatrix, inPlane, inPlaneRigid, invert, multiply, parseMatrix } from '../src/core/matrix.js';
import { axisPlanes, placeOnPlane, samplePlane, slicePlane } from '../src/core/plane.js';
import { blockAverage, otsuThreshold } from '../src/core/image2d.js';

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} vs ${b}`);

// A 0.6 × 0.8 × 1 mm volume whose voxel value is a linear function of its world position.
function linearVolume() {
  const dims = [20, 16, 12];
  const affine = [[-0.6, 0, 0, 5], [0, 0, -1, 3], [0, -0.8, 0, 7], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  const field = ([x, y, z]) => 2 * x - 3 * y + 0.5 * z + 10;
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) data[i + dims[0] * (j + dims[1] * k)] = field(apply(affine, [i, j, k]));
  return { volume: { dims, affine, data }, field };
}

test('matrices invert, multiply and round-trip through Greedy text', () => {
  const m = [[1.1, 0.2, 0, 3], [-0.1, 0.9, 0.05, -2], [0.01, 0, 1.2, 0.5], [0, 0, 0, 1]];
  const product = multiply(m, invert(m));
  product.forEach((row, r) => row.forEach((value, c) => close(value, r === c ? 1 : 0, 1e-12)));
  assert.deepEqual(parseMatrix(formatMatrix(m)), m);
  assert.throws(() => parseMatrix('1 0 0\n0 1 0'), /four rows/);
  assert.deepEqual(inPlane(m)[2], [0, 0, 1, 0]);
  assert.equal(inPlane(m)[0][2], 0);
  const angle = 0.3;
  const rigid = inPlaneRigid([[Math.cos(angle), -Math.sin(angle), 0.02, 4], [Math.sin(angle), Math.cos(angle), -0.01, 5], [0.01, 0, 1, 7], [0, 0, 0, 1]]);
  close(Math.atan2(rigid[1][0], rigid[0][0]), angle, 1e-12);
  assert.deepEqual([rigid[0][3], rigid[1][3], rigid[2][3]], [4, 5, 0]);
});

test('voxel axes are named by the world axis they follow', () => {
  assert.deepEqual(axisPlanes(linearVolume().volume.affine), ['sagittal', 'axial', 'coronal']);
});

test('a slice plane samples the volume at its world positions, tilted and offset', () => {
  const { volume, field } = linearVolume();
  const plane = slicePlane(volume, { axis: 2, index: 6, offset: 0.4, tilt: [3, -2] });
  assert.equal(plane.spacing, 0.6);
  const n = [plane.frame[0][2], plane.frame[1][2], plane.frame[2][2]];
  close(Math.hypot(...n), 1, 1e-12);
  const image = samplePlane(volume, plane);
  // Interior pixels of a linear field are exact under trilinear interpolation.
  for (const [i, j] of [[10, 8], [14, 12], [5, 9]]) {
    const world = apply(plane.frame, [i * plane.spacing, j * plane.spacing, 0]);
    close(image[j * plane.nu + i], field(world), 1e-3);
  }
  const untilted = slicePlane(volume, { axis: 2, index: 6 });
  const centre = apply(untilted.frame, [((untilted.nu - 1) / 2) * untilted.spacing, ((untilted.nv - 1) / 2) * untilted.spacing, 0]);
  apply(volume.affine, [9.5, 7.5, 6]).forEach((value, axis) => close(centre[axis], value, 1e-9));
  close(untilted.halfThickness, 0.5, 1e-12);
});

test('placing an image on an axis-aligned plane writes exactly that slice', () => {
  const { volume } = linearVolume();
  const plane = slicePlane(volume, { axis: 2, index: 4 });
  const written = new Map();
  const count = placeOnPlane(volume, plane, (x, y) => [x, y], (index, value) => written.set(index, value));
  assert.equal(count, 20 * 16);
  const [nx, ny] = volume.dims;
  for (const index of written.keys()) assert.equal(Math.floor(index / (nx * ny)), 4);
  // Voxel (3, 2, 4) projects to its own position on the plane.
  const [x, y] = written.get(3 + nx * (2 + ny * 4));
  const local = apply(invert(plane.frame), apply(volume.affine, [3, 2, 4]));
  close(x, local[0]);
  close(y, local[1]);
  const tilted = slicePlane(volume, { axis: 2, index: 4, tilt: [10, 0] });
  const layer = placeOnPlane(volume, tilted, () => 1, () => {});
  assert.ok(layer >= 20 * 16 && layer <= 2 * 20 * 16, `${layer} voxels`);
});

test('block averaging keeps partial edge blocks and Otsu splits two levels', () => {
  const image = { width: 5, height: 3, channels: 1, maxValue: 10, data: Uint8Array.from({ length: 15 }, (_, i) => i % 5) };
  const { width, height, planes } = blockAverage(image, 2);
  assert.deepEqual([width, height], [3, 2]);
  assert.deepEqual(Array.from(planes[0], (v) => Math.round(v * 1000) / 1000), [0.05, 0.25, 0.4, 0.05, 0.25, 0.4]);
  const twoLevels = Float32Array.from({ length: 100 }, (_, i) => (i < 60 ? 1 + (i % 3) * 0.01 : 5 + (i % 3) * 0.01));
  const threshold = otsuThreshold(twoLevels);
  assert.ok(threshold > 1.02 && threshold < 5, `${threshold}`);
});
