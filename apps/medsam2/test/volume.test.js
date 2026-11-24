import { test } from "node:test";
import assert from "node:assert/strict";
import { createFloat32Nifti, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";
import {
  IMAGE_SIZE,
  bilinearResize2D,
  computeVoxelVolumeMm3,
  computeWindow,
  exportLabelsNifti,
  extractLabelSlice,
  extractSliceUint8,
  readNifti3D,
  sliceGeometry,
  sliceToEncoderTensor,
  sliceToRas,
} from "../src/volume.js";

test("computeWindow handles exact numpy-style auto MRI percentile, CT presets and full range", () => {
  const data = Float32Array.from({ length: 1001 }, (_, i) => i);
  // Positive values are 1..1000 (n=1000): 0.5% -> pos 4.995 -> 5.995; 99.5% -> pos 994.005 -> 995.005
  const autoWin = computeWindow(data, "auto");
  assert.ok(Math.abs(autoWin.lo - 5.995) < 1e-4, `lo=${autoWin.lo}`);
  assert.ok(Math.abs(autoWin.hi - 995.005) < 1e-4, `hi=${autoWin.hi}`);
  assert.deepEqual(computeWindow(data, "ct-soft"), { lo: -160, hi: 240 });
  assert.deepEqual(computeWindow(data, "full"), { lo: 0, hi: 1000 });
});

test("sliceGeometry and sliceToRas map all three anatomical axes consistently", () => {
  const dims = [10, 12, 8];
  assert.deepEqual(sliceGeometry(dims, "axial"), { width: 10, height: 12, depth: 8 });
  assert.deepEqual(sliceGeometry(dims, "coronal"), { width: 10, height: 8, depth: 12 });
  assert.deepEqual(sliceGeometry(dims, "sagittal"), { width: 12, height: 8, depth: 10 });
  assert.deepEqual(sliceToRas(2, 0, 3, dims, "axial"), [2, 11, 3]);
  assert.deepEqual(sliceToRas(2, 0, 5, dims, "coronal"), [2, 5, 7]);
  assert.deepEqual(sliceToRas(4, 0, 1, dims, "sagittal"), [1, 4, 7]);
});

test("readNifti3D and exportLabelsNifti round-trip voxel coordinates on a synthetic NIfTI", async () => {
  const dims = [6, 8, 5];
  const data = Float32Array.from({ length: 6 * 8 * 5 }, (_, i) => i);
  const header = createNiftiHeaderFromVolume({ dims, pixDims: [1, 1.5, 2], datatypeCode: 16 });
  const niftiBytes = createFloat32Nifti(data, header, dims);
  const vol = await readNifti3D("synthetic.nii", niftiBytes);
  assert.deepEqual(vol.dims, dims);
  assert.deepEqual(vol.pixDims, [1, 1.5, 2]);
  const u8 = extractSliceUint8(vol.data, vol.dims, "axial", 2, 0, 239);
  assert.equal(u8.length, 6 * 8);
  const tensor = sliceToEncoderTensor(u8, 6, 8);
  assert.equal(tensor.length, 3 * IMAGE_SIZE * IMAGE_SIZE);
  assert.ok(tensor.every(Number.isFinite));

  const labels = new Uint8Array(vol.data.length);
  labels[10] = 2;
  const exported = exportLabelsNifti(labels, vol);
  assert.ok(exported.byteLength > 348);
  const slice = extractLabelSlice(labels, vol.dims, "axial", 0);
  assert.equal(slice.length, 6 * 8);
});

test("bilinearResize2D preserves constant fields and resizes cleanly", () => {
  const constant = Float32Array.from({ length: 16 }, () => 42.5);
  const resized = bilinearResize2D(constant, 4, 4, 8, 8);
  assert.equal(resized.length, 64);
  for (let i = 0; i < resized.length; i++) assert.ok(Math.abs(resized[i] - 42.5) < 1e-5);
});

test("computeVoxelVolumeMm3 honours NIfTI spatial units and sheared sform affines", async () => {
  // Sheared affine: det([[2, 1, 0], [0, 3, 0], [0, 0, 4]]) = 24 mm³ (not col-norm product ~ 26.83)
  const sheared = [
    [2, 1, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 1],
  ];
  assert.equal(computeVoxelVolumeMm3(sheared, [1, 1, 1], 2), 24);
  // Metres (xyzt_units = 1): 0.001 m × 0.002 m × 0.003 m = 6 mm³
  const inMetres = [
    [0.001, 0, 0, 0],
    [0, 0.002, 0, 0],
    [0, 0, 0.003, 0],
    [0, 0, 0, 1],
  ];
  assert.ok(Math.abs(computeVoxelVolumeMm3(inMetres, [0.001, 0.002, 0.003], 1) - 6) < 1e-9);
  // End-to-end readNifti3D with xyzt_units = 1 (metres) in the header
  const dims = [4, 4, 4];
  const data = new Float32Array(64);
  const header = createNiftiHeaderFromVolume({ dims, pixDims: [0.002, 0.002, 0.002], datatypeCode: 16 });
  new DataView(header instanceof ArrayBuffer ? header : header.buffer, header.byteOffset || 0, header.byteLength).setUint8(123, 1);
  const vol = await readNifti3D("metres.nii", createFloat32Nifti(data, header, dims));
  assert.ok(Math.abs(vol.voxelVolumeMm3 - 8) < 1e-4);
  assert.ok(Math.abs(vol.pixDims[0] - 2) < 1e-4);
});
