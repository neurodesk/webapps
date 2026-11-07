import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSection, resliceLocal, SLAB_SPACING } from '../src/core/register.js';
import { slicePlane, samplePlane } from '../src/core/plane.js';
import { readWarp, scalarNifti } from '../src/core/nifti.js';
import { formatMatrix } from '../src/core/matrix.js';
import { landmarkErrors, summarise, syntheticLandmarks, syntheticSection, syntheticTransform } from '../validation/synthetic.js';
import { nodeGreedy, phantomSlice, phantomVolume } from './helpers.js';

test('the JavaScript reslice through affine and warp equals Greedy reslice', async () => {
  const { api } = await nodeGreedy();
  const n = 64;
  const spacing = 0.5;
  const fixedImage = phantomSlice(n, n);
  const width = 50;
  const height = 44;
  const placement = [[0.6 * Math.cos(0.2), -0.6 * Math.sin(0.2), 0, 4], [0.6 * Math.sin(0.2), 0.6 * Math.cos(0.2), 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]];
  const movingImage = Float32Array.from({ length: width * height }, (_, k) => phantomSlice(width, height)[k]);
  const slab = (image, w, h, sform) => {
    const data = new Float32Array(image.length * 3);
    for (let k = 0; k < 3; k++) data.set(image, k * image.length);
    return scalarNifti(data, [w, h, 3], sform);
  };
  const fixedSform = [[spacing, 0, 0, 0], [0, spacing, 0, 0], [0, 0, SLAB_SPACING, -SLAB_SPACING], [0, 0, 0, 1]];
  const movingSform = placement.map((row) => [...row]);
  movingSform[2] = [0, 0, SLAB_SPACING, -SLAB_SPACING];
  const fixed = slab(fixedImage, n, n, fixedSform);
  const moving = slab(movingImage, width, height, movingSform);
  const mask = new Float32Array(n * n * 3).fill(1, n * n, 2 * n * n);
  const affine = [[1.02, 0.03, 0, 0.4], [-0.02, 0.98, 0, -0.3], [0, 0, 1, 0], [0, 0, 0, 1]];
  const warpBytes = api.register_svf_masked_wasm(fixed, moving, scalarNifti(mask, [n, n, 3], fixedSform), formatMatrix(affine), 'NMI', '0x0x30');
  const field = readWarp(warpBytes);
  const pixels = n * n;
  const warp = new Float32Array(3 * pixels);
  for (let c = 0; c < 2; c++) warp.set(field.data.subarray(c * field.voxels + pixels, c * field.voxels + 2 * pixels), c * pixels);
  assert.ok(warp.some((value) => Math.abs(value) > 0.2), 'the warp moves pixels');
  const greedy = api.reslice_warp_affine_options(fixed, moving, warpBytes, formatMatrix(affine), null, false, 0);
  const expected = new Float32Array(greedy.buffer.slice(greedy.byteOffset + 352)).subarray(pixels, 2 * pixels);
  const mine = resliceLocal({ grid: { nu: n, nv: n, spacing }, image: movingImage, width, height, placement, matrix: affine, warp });
  let compared = 0;
  for (let i = 0; i < pixels; i++) {
    if (!mine.inside[i]) continue;
    compared++;
    assert.ok(Math.abs(expected[i] - mine.values[i]) < 1e-2, `pixel ${i}: ${expected[i]} vs ${mine.values[i]}`);
  }
  assert.ok(compared > pixels / 3);
});

test('a re-coloured, deformed phantom section registers with sub-voxel landmark error', async () => {
  const greedy = await nodeGreedy();
  const [nu, nv] = [120, 100];
  const slice = phantomSlice(nu, nv);
  const volume = phantomVolume(nu, nv, 5, () => slice);
  const plane = slicePlane(volume, { axis: 2, index: 2 });
  const transform = syntheticTransform(plane);
  const section = syntheticSection(samplePlane(volume, plane), plane, transform);
  const result = await registerSection({ volume, section, plane: { axis: 2, index: 2 }, options: { refinePlane: false }, greedy });
  assert.equal(result.contrastInverted, true, 'brightfield background is detected');
  assert.deepEqual(result.orientation, { id: 0, rotation: 0, flip: false });
  assert.ok(result.nmi.final > result.nmi.initial);
  const summary = summarise(landmarkErrors(result, transform, syntheticLandmarks(plane, slice)));
  assert.ok(summary.landmarks >= 40, `${summary.landmarks} landmarks`);
  assert.ok(summary.meanVoxels < 1, `mean ${summary.meanVoxels} voxels`);
});

test('a flipped and rotated section is found by the orientation search', async () => {
  const greedy = await nodeGreedy();
  const [nu, nv] = [120, 100];
  const slice = phantomSlice(nu, nv);
  const volume = phantomVolume(nu, nv, 5, () => slice);
  const plane = slicePlane(volume, { axis: 2, index: 2 });
  const transform = syntheticTransform(plane);
  const upright = syntheticSection(samplePlane(volume, plane), plane, transform);
  // Rotate the section image by 180° and mirror it left-right: a vertical flip.
  const { width, height } = upright;
  const data = new Uint8Array(upright.data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(upright.data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3), ((height - 1 - y) * width + x) * 3);
  const result = await registerSection({ volume, section: { ...upright, data }, plane: { axis: 2, index: 2 }, options: { refinePlane: false, deformable: false }, greedy });
  assert.equal(result.orientation.flip, true);
  assert.equal(result.orientation.rotation, 180);
  const flipBack = { ...transform, toPixel: (point) => { const [x, y] = transform.toPixel(point); return [x, height - 1 - y]; } };
  const summary = summarise(landmarkErrors(result, flipBack, syntheticLandmarks(plane, slice)));
  assert.ok(summary.meanVoxels < 1.5, `mean ${summary.meanVoxels} voxels`);
});

test('the plane search finds the slice and tilt the section was cut from', async () => {
  const greedy = await nodeGreedy();
  const [nu, nv] = [120, 100];
  // The folds and ventricles change from slice to slice, as they do between real sections.
  const volume = phantomVolume(nu, nv, 12, (k) => phantomSlice(nu, nv, { phase: 0.35 * (k - 6), ventricles: 1 + 0.12 * (k - 6) }));
  const truth = slicePlane(volume, { axis: 2, index: 7, tilt: [0, 2] });
  const transform = syntheticTransform(truth);
  const section = syntheticSection(samplePlane(volume, truth), truth, transform);
  const result = await registerSection({ volume, section, plane: { axis: 2, index: 6 }, options: { deformable: false, searchOffset: 2, searchTilt: 3 }, greedy });
  assert.equal(result.search.offsetSlices, 1);
  assert.deepEqual(result.search.tilt, [0, 2]);
  assert.ok(result.search.nmi > result.search.startNmi);
});
