import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { registerSection, resliceLocal } from '../src/core/register.js';
import { registrationImages, sectionsInVolume, warpedSection, worldTransforms } from '../src/core/outputs.js';
import { samplePlane, slicePlane } from '../src/core/plane.js';
import { syntheticSection, syntheticTransform } from '../validation/synthetic.js';
import { nodeGreedy, phantomSlice } from './helpers.js';

// An oblique MRI grid (rotated 20° about x, 0.6 × 0.7 × 0.8 mm) so world and plane frames differ.
function obliqueVolume(nu, nv, nz) {
  const c = Math.cos(0.35);
  const s = Math.sin(0.35);
  const affine = [[0.6, 0, 0, -30], [0, 0.7 * c, -0.8 * s, -20], [0, 0.7 * s, 0.8 * c, 4], [0, 0, 0, 1]];
  const slice = phantomSlice(nu, nv);
  const data = new Float32Array(nu * nv * nz);
  for (let k = 0; k < nz; k++) data.set(slice, k * nu * nv);
  return { dims: [nu, nv, nz], affine, data };
}

// A mirrored (left-handed) grid sliced along i: the phantom lies in the j-k plane, the i axis
// runs right to left and j and k are swapped in world space.
function mirroredVolume(nu, nv, ni) {
  const affine = [[-0.7, 0, 0, 3], [0, 0, 0.6, -25], [0, 0.6, 0, -30], [0, 0, 0, 1]];
  const slice = phantomSlice(nu, nv);
  const data = new Float32Array(ni * nu * nv);
  for (let k = 0; k < nv; k++) for (let j = 0; j < nu; j++) for (let i = 0; i < ni; i++) data[i + ni * (j + nu * k)] = slice[k * nu + j];
  return { dims: [ni, nu, nv], affine, data };
}

async function registered(volume = obliqueVolume(100, 86, 7), start = { axis: 2, index: 3, tilt: [2, -1] }) {
  const greedy = await nodeGreedy();
  const plane = slicePlane(volume, start);
  const transform = syntheticTransform(plane);
  const section = syntheticSection(samplePlane(volume, plane), plane, transform);
  const result = await registerSection({ volume, section, plane: start, options: { refinePlane: false, orientation: 0 }, greedy });
  return { greedy, volume, section, result };
}

const state = registered();

async function assertGreedyReproduces({ greedy, result }) {
  const images = registrationImages(result);
  const transforms = worldTransforms(result);
  const local = resliceLocal({ grid: result.plane, image: result.moving.data, width: result.moving.width, height: result.moving.height, placement: result.placement, matrix: result.affine, warp: result.warp });
  const resliced = greedy.api.reslice_warp_affine_options(images.plane, images.section, transforms.warp, transforms.matrix, null, false, 0);
  const header = parseNiftiHeader(resliced.buffer.slice(resliced.byteOffset, resliced.byteOffset + 352));
  const values = new Float32Array(resliced.buffer.slice(resliced.byteOffset + Math.ceil(header.voxOffset)));
  let compared = 0;
  let maximum = 0;
  for (let i = 0; i < values.length; i++) if (local.inside[i]) maximum = Math.max(maximum, Math.abs(local.values[i]));
  for (let i = 0; i < values.length; i++) {
    if (!local.inside[i]) continue;
    compared++;
    assert.ok(Math.abs(values[i] - local.values[i]) < 1e-3 * maximum, `pixel ${i}: ${values[i]} vs ${local.values[i]}`);
  }
  assert.ok(compared > values.length / 4, `${compared} pixels compared`);
}

test('the world-space files reproduce the registration through Greedy reslice', async () => {
  await assertGreedyReproduces(await state);
});

test('the world-space files reproduce it on a mirrored grid sliced along i', async () => {
  await assertGreedyReproduces(await registered(mirroredVolume(100, 86, 7), { axis: 0, index: 3, tilt: [-1, 2] }));
});

test('written images carry millimetre spacing and the plane frame as an sform', async () => {
  const { result } = await state;
  const { plane } = registrationImages(result);
  const header = parseNiftiHeader(plane.buffer.slice(plane.byteOffset, plane.byteOffset + 352));
  assert.equal(header.qformCode, 0);
  assert.ok(header.sformCode > 0);
  assert.equal(header.xyztUnits & 7, 2, 'millimetres');
  assert.deepEqual([header.nx, header.ny, header.nz], [result.plane.nu, result.plane.nv, 1]);
  for (const axis of [0, 1]) {
    const column = [0, 1, 2].map((row) => header.affine[row][axis]);
    assert.ok(Math.abs(Math.hypot(...column) - result.plane.spacing) < 1e-5);
    assert.ok(Math.abs(header.voxelSize[axis] - result.plane.spacing) < 1e-6);
  }
  const origin = [0, 1, 2].map((row) => header.affine[row][3]);
  origin.forEach((value, row) => assert.ok(Math.abs(value - result.plane.frame[row][3]) < 1e-4));
});

test('the warped section and its copy in the MRI grid are RGBA with tissue opaque', async () => {
  const { volume, section, result } = await state;
  const warped = warpedSection(result, section);
  assert.equal(warped.rgba.length, warped.nu * warped.nv * 4);
  assert.ok(warped.spacing < result.plane.spacing);
  let opaque = 0;
  for (let i = 3; i < warped.rgba.length; i += 4) opaque += warped.rgba[i] === 255;
  assert.ok(opaque > 0.2 * warped.nu * warped.nv, `${opaque} opaque pixels`);
  const { bytes, written } = sectionsInVolume(volume, [{ result, warped }]);
  const header = parseNiftiHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 352));
  assert.equal(header.datatype, 2304);
  assert.deepEqual([header.nx, header.ny, header.nz], volume.dims);
  header.affine.slice(0, 3).forEach((row, r) => row.forEach((value, c) => assert.ok(Math.abs(value - volume.affine[r][c]) < 1e-5)));
  assert.ok(written > 1000, `${written} voxels`);
  assert.throws(() => sectionsInVolume(volume, [{ result, warped }], 100), /too large/);
});
