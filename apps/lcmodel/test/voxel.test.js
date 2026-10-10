import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { decodeNiftiBuffer, parseNiftiVolume } from "@neurodesk/webapp-components/file-io";
import { voxelWeights, tissueFractions, invert4, multiply4, apply4 } from "@neurodesk/lcmodel/voxel";

const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const box = (size, center) => [[size[0], 0, 0, center[0]], [0, size[1], 0, center[1]], [0, 0, size[2], center[2]], [0, 0, 0, 1]];

test("an axis-aligned box covers whole and half voxels exactly", () => {
  const { weights, volumeMm3, nominalMm3 } = voxelWeights(box([4, 4, 4], [10, 10, 10]), { affine: identity, dims: [20, 20, 20] }, { samples: 4 });
  const at = (x, y, z) => weights[x + 20 * (y + 20 * z)];
  assert.equal(at(10, 10, 10), 1);
  assert.equal(at(8, 10, 10), 0.5);
  assert.equal(at(12, 10, 10), 0.5);
  assert.equal(at(8, 8, 8), 0.125);
  assert.equal(at(7, 10, 10), 0);
  assert.equal(volumeMm3, 64);
  assert.equal(nominalMm3, 64);
});

test("an oblique box keeps its volume on the grid", () => {
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  // 20 x 30 x 25 mm, rotated about z then tilted about x.
  const rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, Math.cos(0.3), -Math.sin(0.3)], [0, Math.sin(0.3), Math.cos(0.3)]];
  const r = rx.map((row) => [0, 1, 2].map((j) => row.reduce((sum, v, k) => sum + v * rz[k][j], 0)));
  const sizes = [20, 30, 25];
  const affine = [0, 1, 2].map((i) => [...[0, 1, 2].map((j) => r[i][j] * sizes[j]), [30.3, 29.7, 30.1][i]]).concat([[0, 0, 0, 1]]);
  const { volumeMm3, nominalMm3 } = voxelWeights(affine, { affine: identity, dims: [64, 64, 64] });
  assert.ok(Math.abs(nominalMm3 - 15000) < 1e-6);
  assert.ok(Math.abs(volumeMm3 / nominalMm3 - 1) < 0.005, `${volumeMm3} vs ${nominalMm3}`);
});

test("fractions do not depend on how the image grid is oriented", () => {
  // Grey matter left of x = 10 mm, white matter right of it; CSF above z = 12 mm.
  const tissueAt = ([x, , z]) => (z > 12 ? "csf" : x < 10 ? "gm" : "wm");
  const voxel = box([4, 4, 6], [10, 10, 11]);
  const grids = [
    { affine: identity, dims: [24, 24, 24] },
    // PIR-like grid as Philips writes: i -> -y, j -> -z, k -> +x, offset.
    { affine: [[0, 0, 1, -2], [-1, 0, 0, 21], [0, -1, 0, 22], [0, 0, 0, 1]], dims: [24, 24, 24] },
    // 0.8 mm voxels with a shifted origin.
    { affine: [[0.8, 0, 0, 0.3], [0, 0.8, 0, -0.2], [0, 0, 0.8, 0.1], [0, 0, 0, 1]], dims: [30, 30, 30] },
  ];
  const results = grids.map((grid) => {
    const n = grid.dims[0] * grid.dims[1] * grid.dims[2];
    const maps = { gm: new Float32Array(n), wm: new Float32Array(n), csf: new Float32Array(n) };
    for (let z = 0; z < grid.dims[2]; z += 1) for (let y = 0; y < grid.dims[1]; y += 1) for (let x = 0; x < grid.dims[0]; x += 1) {
      maps[tissueAt(apply4(grid.affine, [x, y, z]))][x + grid.dims[0] * (y + grid.dims[1] * z)] = 1;
    }
    const { weights } = voxelWeights(voxel, grid, { samples: 6 });
    return tissueFractions(weights, maps);
  });
  // On the 1 mm grids the tissue changes at voxel centres x = 10 (GM is 8.5..9.5
  // plus half of voxel 8) and z = 13 (CSF is voxel 13 and half of 14): exactly
  // 1.5/6 CSF and 1.5/4 of the rest GM. The permuted grid samples the same points.
  for (const f of results.slice(0, 2)) {
    assert.ok(Math.abs(f.csf - 0.25) < 1e-6 && Math.abs(f.gm - 0.75 * 0.375) < 1e-6, JSON.stringify(f));
    assert.equal(f.coverage, 1);
  }
  // The 0.8 mm grid approaches the continuous answer, a third each.
  for (const t of ["gm", "wm", "csf"]) assert.ok(Math.abs(results[2][t] - 1 / 3) < 0.1, JSON.stringify(results[2]));
});

test("matrix helpers invert and compose", () => {
  const a = [[0, 0, 1, -98.3], [-1, 0, 0, 134.2], [0, -1, 0, 146.2], [0, 0, 0, 1]];
  const p = multiply4(invert4(a), a);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) assert.ok(Math.abs(p[r][c] - identity[r][c]) < 1e-12);
  assert.throws(() => invert4([[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]), /inverted/);
  assert.throws(() => tissueFractions(new Float32Array(3), { gm: [1, 1, 1], wm: [0, 0, 0], csf: [0, 0, 0] }), /outside/);
});

test("tissue the maps leave out counts as CSF unless excluded", () => {
  // Four voxels: GM, WM, ventricle CSF, and one no map labels (a sulcus).
  const weights = new Float32Array([1, 1, 1, 1]);
  const maps = { gm: [1, 0, 0, 0], wm: [0, 1, 0, 0], csf: [0, 0, 1, 0] };
  assert.deepEqual(tissueFractions(weights, maps), { gm: 0.25, wm: 0.25, csf: 0.5, coverage: 0.75 });
  assert.deepEqual(tissueFractions(weights, maps, { unlabelled: "exclude" }), { gm: 1 / 3, wm: 1 / 3, csf: 1 / 3, coverage: 0.75 });
});

// Osprey's own voxel mask for its twix example (MIT, exampledata/twix/UnEdited/
// sub-01, ses-01_T1w_overlay.nii.gz), with the voxel spec2nii writes for
// sub-01_PRESS30.dat (exes/fida/tests/geometry.rs checks the reader gives it).
const osprey = process.env.OSPREY_EXAMPLES;
const anat = osprey && `${osprey}/twix/UnEdited/sub-01/ses-01/anat/sub-01`;
test("the twix voxel matches Osprey's own mask of it", { skip: !(anat && existsSync(`${anat}/ses-01_T1w_overlay.nii.gz`)) && "set OSPREY_EXAMPLES" }, async () => {
  const mask = parseNiftiVolume(await decodeNiftiBuffer(readFileSync(`${anat}/ses-01_T1w_overlay.nii.gz`)));
  const twixVoxel = [
    [29.999996, 0.000318, -0.016325, -4.395912],
    [-0.000318, -29.977212, -1.169079, 8.7819],
    [-0.016325, 1.169079, -29.977208, 58.784504],
    [0, 0, 0, 1],
  ];
  const dice = (weights) => {
    let both = 0;
    let ours = 0;
    let theirs = 0;
    for (let i = 0; i < weights.length; i += 1) {
      const a = weights[i] >= 0.5;
      const b = mask.imageData[i] > 0.5;
      both += a && b;
      ours += a;
      theirs += b;
    }
    return (2 * both) / (ours + theirs);
  };
  const exact = voxelWeights(twixVoxel, { affine: mask.affine, dims: mask.dims });
  assert.ok(Math.abs(exact.volumeMm3 - 27000) < 50, `volume ${exact.volumeMm3}`);
  // Osprey's coreg_siemens shifts the T1's voxel centres by half a voxel
  // (-0.5, -0.5, +0.5 mm here), taking SPM's centres for corners, so its mask
  // sits half a voxel off: 1.5 mm of a 30 mm cube.
  assert.ok(dice(exact.weights) > 0.94, `Dice ${dice(exact.weights)}`);
  const shifted = mask.affine.map((row, r) => Array.from(row).map((v, c) => (c === 3 && r < 3 ? v + [-0.5, -0.5, 0.5][r] : v)));
  const asOsprey = voxelWeights(twixVoxel, { affine: shifted, dims: mask.dims });
  assert.ok(dice(asOsprey.weights) > 0.99, `Dice with Osprey's shift ${dice(asOsprey.weights)}`);
});
