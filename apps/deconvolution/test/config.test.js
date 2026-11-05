// DOM-independent unit tests (Node). Browser behaviour is covered by e2e/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNiftiFromVolume, parseNiftiHeader } from "@neurodesk/webapp-components/file-io";
import { writeImageJTiff } from "@neurodesk/microscopy-tiff";
import { APP, EXAMPLE_OPTICS, niftiGeometry, niftiSpacingUm, outputNames, provenance, spacingComplete, stem } from "../src/config.js";
import { formatOf, readVolume } from "../src/input.js";
import examples from "../examples.json" with { type: "json" };

test("app id and every example has optics", () => {
  assert.equal(APP.id, "deconvolution");
  for (const example of examples) assert.ok(EXAMPLE_OPTICS[example.id], example.id);
});

test("output names keep the input stem", () => {
  assert.equal(stem("cells.ome.tif"), "cells");
  assert.equal(stem("cells.nii.gz"), "cells");
  assert.deepEqual(outputNames("a.b.TIFF"), {
    tiff: "a.b_deconvolved.tif",
    nifti: "a.b_deconvolved.nii.gz",
    psfTiff: "a.b_psf.tif",
    psfNifti: "a.b_psf.nii.gz",
    previewNifti: "a.b.nii.gz",
  });
  assert.equal(formatOf("x.ome.tiff"), "tiff");
  assert.equal(formatOf("x.nii.gz"), "nifti");
  assert.equal(formatOf("x.czi"), null);
});

test("NIfTI headers written from a micrometre stack hold millimetres", () => {
  const dims = [3, 4, 5];
  const header = parseNiftiHeader(createNiftiFromVolume({ hdr: niftiGeometry(dims, { x: 0.065, y: 0.065, z: 0.13 }), img: new Float32Array(60) }));
  assert.deepEqual(header.dims.slice(0, 4), [3, 5, 4, 3]);
  assert.ok(Math.abs(header.pixDims[1] - 6.5e-5) < 1e-12 && Math.abs(header.pixDims[3] - 1.3e-4) < 1e-12, String(header.pixDims));
  assert.equal(header.xyztUnits & 7, 2);
  // The affine flips y so TIFF row 0 is shown at the top, as in ImageJ.
  assert.ok(Math.abs(header.affine[1][1] + 6.5e-5) < 1e-12);
  assert.ok(Math.abs(header.affine[1][3] - 3 * 6.5e-5) < 1e-12);
  assert.deepEqual(niftiSpacingUm(header), { x: header.pixDims[1] * 1000, y: header.pixDims[2] * 1000, z: header.pixDims[3] * 1000 });
});

test("NIfTI spacing honours xyzt_units", () => {
  const header = (units) => ({ xyztUnits: units, voxelSize: [0.5, 0.5, 2] });
  assert.deepEqual(niftiSpacingUm(header(3)), { x: 0.5, y: 0.5, z: 2 });
  assert.deepEqual(niftiSpacingUm(header(2)), { x: 500, y: 500, z: 2000 });
  assert.deepEqual(niftiSpacingUm(header(10)), { x: 500, y: 500, z: 2000 });
  assert.deepEqual(niftiSpacingUm(header(1)), { x: 500000, y: 500000, z: 2000000 });
});

test("readVolume reads TIFF and NIfTI into the same [z][y][x] layout and micrometres", async () => {
  const data = Float32Array.from({ length: 2 * 3 * 4 }, (_, i) => i);
  const spacingUm = { x: 0.2, y: 0.2, z: 0.5 };
  const tiff = await readVolume(new File([writeImageJTiff({ data, width: 4, height: 3, depth: 2, spacingUm })], "s.tif"));
  assert.deepEqual(tiff.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(tiff.data), Array.from(data));
  assert.equal(tiff.spacingUm.z, 0.5);
  const nifti = await readVolume(new File([createNiftiFromVolume({ hdr: niftiGeometry([2, 3, 4], spacingUm), img: data })], "s.nii"));
  assert.deepEqual(nifti.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(nifti.data), Array.from(data));
  for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(nifti.spacingUm[axis] - spacingUm[axis]) < 1e-6, axis);
  await assert.rejects(readVolume(new File(["x"], "s.png")), /not a TIFF or NIfTI/);
  await assert.rejects(readVolume(new File([], "s.tif")), /empty/);
});

test("spacing must be positive on every axis", () => {
  assert.ok(spacingComplete({ x: 0.1, y: 0.1, z: 0.2 }));
  assert.ok(!spacingComplete({ x: 0.1, y: 0.1, z: null }));
  assert.ok(!spacingComplete({ x: Number.NaN, y: 0.1, z: 0.2 }));
});

test("provenance names the PSF and method", () => {
  const record = provenance({
    input: "a.tif",
    dims: [2, 3, 4],
    spacingUm: { x: 0.1, y: 0.1, z: 0.2 },
    optics: { modality: "confocal", na: 1.4, ni: 1.518, ns: 1.47, emissionUm: 0.525, excitationUm: 0.488, depthUm: 0 },
    psf: { source: "theoretical", dims: [27, 43, 43] },
    settings: { method: "rltv", iterations: 10, tvWeight: 0.002 },
  });
  assert.equal(record.psf.source, "Gibson-Lanni");
  assert.equal(record.psf.excitationNm, 488);
  assert.match(record.method, /Dey et al/);
  assert.deepEqual(record.dimensions, { x: 4, y: 3, z: 2 });
});
