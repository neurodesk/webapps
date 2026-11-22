// The niimath dtifit option through the real dtifit-enabled niimath WASM in Node: it fits the
// same volumes as the WebAssembly tensor fit, its FA and MD equal DWI2TRX's fit of those
// volumes, and its maps agree with the WebAssembly ordinary least squares fit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { fitTensor } from "@neurodesk/dwi2trx";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { runNiimath } from "@neurodesk/dwi2trx/runner";
import { loadNoddi } from "@neurodesk/noddi";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { syntheticDwi, syntheticMask } from "../e2e/fixtures.mjs";
import { fitDtifit } from "@neurodesk/noddi/dtifit";

const noddi = await loadNoddi(readFileSync(new URL(import.meta.resolve("@neurodesk/noddi/wasm"))));

/** The app's view of a synthetic DWI, as readDwi gives it. */
function appInput(dwi) {
  const [image, bval, bvec] = dwi.files;
  const buffer = gunzipSync(image.buffer);
  const frames = readNiftiFrames(buffer);
  const { bvals, bvecs } = parseBvalBvec(bval.buffer.toString(), bvec.buffer.toString());
  const table = noddi.describe(bvals, bvecs);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return { buffer: arrayBuffer, data: frames.data, dims: frames.dims, bvals, bvecs, volumes: table.dtiVolumes };
}

/** DWI2TRX's fit of a DWI's files, as its tensor worker runs it. */
async function dwi2trxFit(dwi, mask) {
  const [image, bval, bvec] = dwi.files;
  const maps = await fitTensor(runNiimath, { dwi: image.buffer, bval: bval.buffer, bvec: bvec.buffer, mask: mask?.buffer });
  return { FA: readNiftiFrames(gunzipSync(maps.FA)).data, MD: readNiftiFrames(gunzipSync(maps.MD)).data };
}

test("FA and MD equal DWI2TRX's on a single-shell DWI, where the fit uses every volume", async () => {
  // Prolate tensor with two equal minor eigenvalues (rordenlab/niimath#83); the oblique test
  // below covers three distinct eigenvalues.
  const dwi = syntheticDwi({ shells: [1000], eigenvalues: [1.7e-3, 0.3e-3, 0.3e-3] });
  const input = appInput(dwi);
  assert.equal(input.volumes.length, input.bvals.length);
  const mask = Uint8Array.from(readNiftiFrames(gunzipSync(syntheticMask({ value: 1 }).buffer)).data);
  const maps = await fitDtifit(runNiimath, { ...input, data: null, mask });
  const reference = await dwi2trxFit(dwi, syntheticMask({ value: 1 }));
  assert.deepEqual(maps.FA, reference.FA);
  assert.deepEqual(maps.MD, reference.MD);
  const centre = 4 + 8 * (4 + 8 * 4);
  assert.ok(Math.abs(maps.AD[centre] - 1.7e-3) < 1e-5, `AD ${maps.AD[centre]}`);
  assert.ok(Math.abs(maps.RD[centre] - 0.3e-3) < 1e-5, `RD ${maps.RD[centre]}`);
  assert.ok(Math.abs(maps.S0[centre] - 1000) < 1, `S0 ${maps.S0[centre]}`);
  // The tensor lies on the x axis, so an x mirror cannot change V1 here. niimath can give
  // (-1, 0, 0) from its eigenvector sign convention; the app's sign rule makes it (1, 0, 0).
  // The oblique test below checks the -xflip 0 setting.
  assert.ok(Math.abs(maps.V1x[centre] - 1) < 1e-4, `V1x ${maps.V1x[centre]}`);
  assert.ok(Math.abs(maps.V1y[centre]) < 1e-4 && Math.abs(maps.V1z[centre]) < 1e-4);
});

test("on a two-shell DWI the fit uses the b0 volumes and b = 1000 only, as DWI2TRX's fit of them", async () => {
  const input = appInput(syntheticDwi({ shells: [1000, 2000] }));
  assert.equal(input.volumes.length, 32);
  const maps = await fitDtifit(runNiimath, { ...input, mask: null });
  // syntheticDwi with one shell holds exactly those volumes, in the same order.
  const reference = await dwi2trxFit(syntheticDwi({ shells: [1000] }));
  assert.deepEqual(maps.FA, reference.FA);
  assert.deepEqual(maps.MD, reference.MD);
});

test("voxels outside the mask stay zero", async () => {
  const input = appInput(syntheticDwi({ shells: [1000] }));
  const voxels = input.dims[0] * input.dims[1] * input.dims[2];
  const centre = 4 + 8 * (4 + 8 * 4);
  const mask = new Uint8Array(voxels);
  mask[centre] = 1;
  const maps = await fitDtifit(runNiimath, { ...input, data: null, mask });
  assert.ok(maps.FA[centre] > 0.5);
  for (const name of ["FA", "MD", "AD", "RD", "S0"]) {
    assert.equal(maps[name].reduce((count, value, i) => count + (i !== centre && value !== 0 ? 1 : 0), 0), 0, name);
  }
});

/** The centre voxel of niimath dtifit and of the WebAssembly OLS fit, on the same DWI. */
async function centreFits(options) {
  const input = appInput(syntheticDwi({ shells: [1000], ...options }));
  const voxels = input.dims[0] * input.dims[1] * input.dims[2];
  const centre = 4 + 8 * (4 + 8 * 4);
  const dtifit = await fitDtifit(runNiimath, { ...input, mask: null });
  const ols = noddi.dtiFit(input.data, voxels, input.bvals, input.bvecs, { weighted: false });
  const at = (maps) => Object.fromEntries(Object.entries(maps).map(([key, values]) => [key, values[centre]]));
  return { dtifit: at(dtifit), ols: at(ols) };
}

function assertSameTensor({ dtifit, ols }, label) {
  for (const key of ["FA", "MD", "AD", "RD", "S0"]) {
    assert.ok(Math.abs(dtifit[key] - ols[key]) <= 1e-5 * Math.abs(ols[key]), `${label} ${key}: dtifit ${dtifit[key]}, OLS ${ols[key]}`);
  }
  for (const key of ["V1x", "V1y", "V1z"]) {
    assert.ok(Math.abs(dtifit[key] - ols[key]) < 1e-5, `${label} ${key}: dtifit ${dtifit[key]}, OLS ${ols[key]}`);
  }
}

// An oblique first eigenvector, so that a mirror in x is not the same as a sign change.
const OBLIQUE = { direction: [1, 1, 0.3], eigenvalues: [1.7e-3, 0.5e-3, 0.3e-3] };

test("on an oblique tensor every map equals the WebAssembly OLS fit, with either sign of the sform determinant", async () => {
  const positive = await centreFits({ ...OBLIQUE, affine: [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0]] });
  assertSameTensor(positive, "positive determinant");
  const truth = OBLIQUE.direction.map((value) => value / Math.hypot(...OBLIQUE.direction));
  assert.ok(Math.abs(positive.dtifit.V1x - truth[0]) < 1e-4 && Math.abs(positive.dtifit.V1y - truth[1]) < 1e-4, `V1 ${positive.dtifit.V1x}, ${positive.dtifit.V1y}`);
  assertSameTensor(await centreFits({ ...OBLIQUE, affine: [[-2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0]] }), "negative determinant");
});

test("bvecs of length 0.9 give the same diffusivities as unit bvecs, as in the WebAssembly fit", async () => {
  assertSameTensor(await centreFits({ ...OBLIQUE, bvecScale: 0.9 }), "bvecs of length 0.9");
});

test("with a negative eigenvalue FA, MD, AD and RD are all zero", async () => {
  const { dtifit } = await centreFits({ eigenvalues: [1.7e-3, 0.3e-3, -0.2e-3] });
  for (const key of ["FA", "MD", "AD", "RD"]) assert.equal(dtifit[key], 0, key);
  assert.ok(dtifit.S0 > 0);
});

for (const [name, options] of [
  ["axial prolate", { eigenvalues: [1.7e-3, 0.3e-3, 0.3e-3] }],
  ["oblique prolate", { direction: [1, -2, 3], eigenvalues: [1.7e-3, 0.3e-3, 0.3e-3] }],
  ["nearly equal minor eigenvalues", { direction: [0.2, 0.9, -0.4], eigenvalues: [1.7e-3, 0.3e-3, 0.3e-3 * (1 - 1e-7)] }],
]) {
  test(`the actual niimath fit preserves the unique principal direction for ${name} tensors`, async () => {
    const fits = await centreFits(options);
    assertSameTensor(fits, name);
    const direction = options.direction ?? [1, 0, 0];
    const norm = Math.hypot(...direction);
    for (const [axis, key] of ["V1x", "V1y", "V1z"].entries()) {
      assert.ok(Math.abs(fits.dtifit[key] - direction[axis] / norm) < 1e-5, `${name} ${key} equals the analytic direction`);
    }
  });
}

for (const [name, eigenvalues] of [
  ["prolate", [1.7e-3, 0.3e-3, 0.3e-3]],
  ["oblate", [1.2e-3, 1.2e-3, 0.3e-3]],
  ["isotropic", [1e-3, 1e-3, 1e-3]],
]) {
  test(`the actual niimath fit returns an orthonormal frame for ${name} tensors`, async () => {
    const [image, bval, bvec] = syntheticDwi({ shells: [1000], direction: [1, -2, 3], eigenvalues }).files;
    const maps = await fitTensor(runNiimath, { dwi: image.buffer, bval: bval.buffer, bvec: bvec.buffer, xflip: '0' });
    const centre = 4 + 8 * (4 + 8 * 4);
    const vectors = ["V1", "V2", "V3"].map((name) => {
      const { data } = readNiftiFrames(gunzipSync(maps[name]));
      return [0, 1, 2].map((axis) => data[centre + axis * 512]);
    });
    for (let i = 0; i < vectors.length; i += 1) {
      assert.ok(Math.abs(Math.hypot(...vectors[i]) - 1) < 1e-6, `${name} V${i + 1} must be unit length`);
      for (let j = 0; j < i; j += 1) {
        const dot = vectors[i].reduce((sum, value, axis) => sum + value * vectors[j][axis], 0);
        assert.ok(Math.abs(dot) < 1e-6, `${name} V${i + 1} and V${j + 1} must be orthogonal`);
      }
    }
    if (name !== "isotropic") {
      // For direction (1,-2,3), the fixture's third axis is (-13,-2,3).
      const [vector, expected] = name === "prolate" ? [vectors[0], [1, -2, 3]] : [vectors[2], [-13, -2, 3]];
      const dot = vector.reduce((sum, value, axis) => sum + value * expected[axis], 0) / Math.hypot(...expected);
      assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6, `${name} keeps its unique analytic eigendirection`);
    }
    // The direction inside a repeated-eigenvalue subspace is not unique.
    // Scalar diffusivities remain defined even for an isotropic tensor.
    for (let i = 0; i < eigenvalues.length; i += 1) {
      const { data } = readNiftiFrames(gunzipSync(maps[`L${i + 1}`]));
      assert.ok(Math.abs(data[centre] - eigenvalues[i]) < 1e-8, `${name} L${i + 1}`);
    }
  });
}

// Positive eigenvalues below 1e-4 must not be zeroed (rordenlab/niimath#84, fixed in 1.4.20261114).
for (const [name, options] of [
  ["small positive L3", { direction: [1, -2, 3], eigenvalues: [1.7e-3, 0.3e-3, 5e-5] }],
  ["prolate with small equal minor eigenvalues", { direction: [0.3, -0.7, 0.6], eigenvalues: [1.7e-3, 5e-5, 5e-5] }],
  ["all small positive eigenvalues", { direction: [1, 1, 0.3], eigenvalues: [8e-5, 5e-5, 2e-5] }],
]) {
  test(`the actual niimath fit preserves ${name} below 1e-4`, async () => {
    const fits = await centreFits(options);
    assertSameTensor(fits, name);
    const [image, bval, bvec] = syntheticDwi({ shells: [1000], ...options }).files;
    const maps = await fitTensor(runNiimath, { dwi: image.buffer, bval: bval.buffer, bvec: bvec.buffer, xflip: "0" });
    const centre = 4 + 8 * (4 + 8 * 4);
    for (let i = 0; i < options.eigenvalues.length; i += 1) {
      const { data } = readNiftiFrames(gunzipSync(maps[`L${i + 1}`]));
      assert.ok(Math.abs(data[centre] - options.eigenvalues[i]) < 1e-7, `${name} L${i + 1}: got ${data[centre]}, expected ${options.eigenvalues[i]}`);
    }
  });
}
