import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NATIVE_VOXELS,
  MAX_WORKING_VOXELS,
  createReferenceReoriented,
  createRescaledGeometry,
  niftiRasToSitkLps,
  prepareVolume1mm,
  resampleLabelsNearest,
  resampleLinear,
  roundHalfToEven,
} from '../src/geometry.js';
import {
  CLASSES,
  CPU_OUTPUT_PATCH,
  WEBGPU_OUTPUT_PATCH,
  extractPaddedPatch,
  intensityWindowNormalize,
  planPatches,
  segmentHeadCt,
  writePatchArgmax,
} from '../src/pipeline.js';
import {
  compareMultiClassLabels,
  lesionsCsv,
  measureLesions,
  writeLabelNifti,
} from '../src/results.js';

test('roundHalfToEven matches Python round() half-to-even convention', () => {
  assert.equal(roundHalfToEven(2.5), 2);
  assert.equal(roundHalfToEven(3.5), 4);
  assert.equal(roundHalfToEven(186.5), 186);
  assert.equal(roundHalfToEven(187.5), 188);
});

test('niftiRasToSitkLps and createReferenceReoriented handle flipped and oblique affines', () => {
  // Standard RAS positive diagonal -> LPS has -1 on X and Y, so reorientation flips X and Y.
  const rasIdentity = [
    [1, 0, 0, -10],
    [0, 1, 0, -20],
    [0, 0, 2, 5],
    [0, 0, 0, 1],
  ];
  const lps = niftiRasToSitkLps([16, 12, 8], rasIdentity);
  assert.deepEqual(lps.spacing, [1, 1, 2]);
  assert.deepEqual(lps.origin, [10, 20, 5]);
  assert.deepEqual(lps.direction, [[-1, 0, 0], [0, -1, 0], [0, 0, 1]]);

  const reor = createReferenceReoriented(lps);
  assert.deepEqual(reor.size, [16, 12, 8]);
  assert.deepEqual(reor.direction, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  // Origin shifted by new_dir @ (new_size * new_spacing * flip): [10 - 16, 20 - 12, 5] = [-6, 8, 5]
  assert.deepEqual(reor.origin, [-6, 8, 5]);

  const iso = createRescaledGeometry(reor, [1, 1, 1]);
  assert.deepEqual(iso.size, [16, 12, 15]); // (8 - 1) * 2 + 1 = 15
});

test('prepareVolume1mm checks 1 mm working bound and accepts thin-slice clinical head CTs > 32M native voxels', () => {
  const hugeIsoGeom = {
    size: [500, 500, 200],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  };
  assert.ok(500 * 500 * 200 > MAX_WORKING_VOXELS);
  assert.throws(() => prepareVolume1mm(new Float32Array(1), hugeIsoGeom), /exceeding the 32M-voxel browser limit/);

  const hugeNativeGeom = {
    size: [1000, 1000, 200],
    spacing: [0.1, 0.1, 0.5],
    origin: [0, 0, 0],
    direction: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  };
  assert.ok(1000 * 1000 * 200 > MAX_NATIVE_VOXELS);
  assert.throws(() => prepareVolume1mm(new Float32Array(1), hugeNativeGeom), /exceeding the 150M-voxel browser limit/);

  // Thin-slice 512 x 512 x 125 at 0.45 x 0.45 x 0.625 mm = 32.8M native voxels, 231 x 231 x 78 = 4.2M at 1 mm (78.5 rounds to even 78)
  const thinSliceGeom = {
    size: [512, 512, 125],
    spacing: [0.45, 0.45, 0.625],
    origin: [0, 0, 0],
    direction: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  };
  const thinData = new Float32Array(512 * 512 * 125);
  const { data: isoData, isoGeom } = prepareVolume1mm(thinData, thinSliceGeom);
  assert.deepEqual(isoGeom.size, [231, 231, 78]);
  assert.equal(isoData.length, 231 * 231 * 78);

  // Zero-copy shortcut when geometry is unchanged and input is already Float32Array
  const sameOut = resampleLinear(thinData, thinSliceGeom, thinSliceGeom, 0, MAX_NATIVE_VOXELS);
  assert.equal(sameOut, thinData);
});

test('writeLabelNifti preserves geometry and resets CT display/metadata header fields', () => {
  const hdr = new Uint8Array(352);
  const dv = new DataView(hdr.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, 4, true);
  dv.setInt16(44, 4, true);
  dv.setInt16(46, 4, true);
  dv.setInt16(68, 0, true);
  dv.setInt16(70, 16, true);
  dv.setInt16(72, 32, true);
  dv.setFloat32(108, 352, true);
  dv.setFloat32(124, 2000, true); // CT cal_max
  dv.setFloat32(128, -1000, true); // CT cal_min
  hdr.set(Buffer.from('CT scanner descrip'), 148);
  dv.setInt16(252, 1, true);
  dv.setInt16(254, 1, true);
  hdr.set([0x6e, 0x2b, 0x31, 0x00], 344);

  const labels = new Uint8Array(64).fill(2);
  const out = writeLabelNifti(labels, [4, 4, 4], hdr.buffer);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(outDv.getInt16(68, true), 1002); // NIFTI_INTENT_LABEL
  assert.equal(outDv.getInt16(70, true), 2); // uint8
  assert.equal(outDv.getFloat32(124, true), 4); // cal_max
  assert.equal(outDv.getFloat32(128, true), 0); // cal_min
  assert.equal(outDv.getInt16(252, true), 1); // qform_code preserved
  assert.equal(outDv.getInt16(254, true), 1); // sform_code preserved
  const descrip = Buffer.from(out.subarray(148, 228)).toString('ascii').replace(/\0+$/, '');
  assert.equal(descrip, 'BLAST-CT TBI lesion segmentation');
});

test('intensityWindowNormalize clamps [-15, 100] HU and maps linearly to [-1, 1]', () => {
  const input = new Float32Array([-1024, -15, 42.5, 100, 2000]);
  const out = intensityWindowNormalize(input);
  assert.ok(Math.abs(out[0] - (-1)) < 1e-6);
  assert.ok(Math.abs(out[1] - (-1)) < 1e-6);
  assert.ok(Math.abs(out[2] - 0) < 1e-6);
  assert.ok(Math.abs(out[3] - 1) < 1e-6);
  assert.ok(Math.abs(out[4] - 1) < 1e-6);
});

test('planPatches aligns every tile to multiples of 15 and shrinks edge tiles cleanly', () => {
  const patches = planPatches([149, 201, 201], CPU_OUTPUT_PATCH);
  assert.equal(patches.length, 18); // 2 * 3 * 3
  for (const p of patches) {
    for (let a = 0; a < 3; a++) {
      assert.equal(p.outStart[a] % 15, 0);
      assert.equal(p.outSize[a] % 15, 0);
      assert.equal(p.inSize[a], p.outSize[a] + 80);
    }
  }
  const edge = patches.at(-1);
  assert.deepEqual(edge.outStart, [75, 150, 150]);
  assert.deepEqual(edge.outSize, [75, 60, 60]);
  assert.deepEqual(edge.inSize, [155, 140, 140]);

  const gpuPatches = planPatches([149, 201, 201], WEBGPU_OUTPUT_PATCH);
  assert.equal(gpuPatches.length, 100); // 4 * 5 * 5
});

test('extractPaddedPatch uses edge padding and writePatchArgmax maps 5-class logits', () => {
  const shape = [10, 10, 10];
  const vol = new Float32Array(1000);
  vol[0] = 0.25;
  vol[999] = 0.75;
  const patch = extractPaddedPatch(vol, shape, [0, 0, 0], [15, 15, 15]);
  assert.equal(patch.length, 95 * 95 * 95);
  // Corner (-40, -40, -40) clamps to (0, 0, 0) -> 0.25
  assert.equal(patch[0], 0.25);
  // Far corner (+54, +54, +54) clamps to (9, 9, 9) -> 0.75
  assert.equal(patch[patch.length - 1], 0.75);

  const outSize = [15, 15, 15];
  const patchVox = 15 * 15 * 15;
  const logits = new Float32Array(5 * patchVox);
  // Set class 2 highest at (1, 2, 3)
  logits[2 * patchVox + 1 * 225 + 2 * 15 + 3] = 5.0;
  const dst = new Uint8Array(1000);
  writePatchArgmax(logits, outSize, [0, 0, 0], dst, shape);
  assert.equal(dst[1 * 100 + 2 * 10 + 3], 2);
});

test('segmentHeadCt, resampleLabelsNearest, measureLesions, and lesionsCsv integrate end to end', async () => {
  const dims = [16, 16, 10];
  const rasAffine = [
    [-1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]).fill(-500);
  const res = await segmentHeadCt({
    data,
    dimsXYZ: dims,
    rasAffine,
    maxOutputPatch: 15,
    runModel: async (_patch, [, , iz, iy, ix]) => {
      const oz = iz - 80;
      const oy = iy - 80;
      const ox = ix - 80;
      const n = oz * oy * ox;
      const logits = new Float32Array(5 * n);
      // Mark class 1 (IPH) at voxel (0, 0, 0) and class 4 (IVH) at (1, 1, 1)
      logits[1 * n + 0] = 3.0;
      logits[4 * n + 1 * oy * ox + 1 * ox + 1] = 3.0;
      return logits;
    },
  });
  assert.equal(res.patches, 8); // iso is 16x16x19 -> 2 x 2 x 2 tiles at maxOutputPatch=15
  assert.equal(res.labels.length, dims[0] * dims[1] * dims[2]);
  assert.equal(res.labels[0], 1);

  const summary = measureLesions(res.labels, res.nativeGeom.spacing);
  assert.equal(summary.classes.length, CLASSES.length);
  assert.ok(summary.classes[0].voxels >= 1);
  assert.ok(Math.abs(summary.voxelMl - 0.002) < 1e-9);

  const csv = lesionsCsv(summary, 'head_ct.nii.gz');
  assert.match(csv, /^scan,class_id,class_key,class_label,voxels,volume_ml\n/);
  assert.match(csv, /"head_ct\.nii\.gz",1,iph,"Intraparenchymal haemorrhage"/);
  assert.match(csv, /"head_ct\.nii\.gz",all,total,"Total lesion burden"/);

  const cmp = compareMultiClassLabels(res.labels, res.labels);
  assert.equal(cmp.diffVoxels, 0);
  assert.equal(cmp.perClass.iph.dice, 1);

  // Verify nearest-neighbor label round-trip on identical geometry
  const same = resampleLabelsNearest(res.labels, res.nativeGeom, res.nativeGeom);
  assert.deepEqual(same, res.labels);
});
