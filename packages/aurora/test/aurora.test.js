import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNiftiHeader, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import {
  ATLAS_DIMS,
  checkLogits,
  checkPreparedGrid,
  densePatchOrigins,
  monaiGaussianWeights,
  monaiToNiftiUint8,
  niftiToMonai,
  padReplicate,
  postprocessLogits,
  scaleIntensityPercentiles,
  segmentMetastasis,
} from '../src/pipeline.js';
import { DEFAULT_MODEL_ID, MODELS, modelById } from '../src/models.js';
import {
  compareLabels,
  connectedLesions,
  segmentationResults,
  stemName,
  volumeRows,
  volumeTable,
} from '../src/results.js';

const IDENTITY_AFFINE = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

test('manifest pins t1c-o_best model metadata', () => {
  assert.equal(MODELS.length, 1);
  const model = modelById(DEFAULT_MODEL_ID);
  assert.equal(model.filename, 'aurora-t1c-o_best.onnx');
  assert.deepEqual(model.channels, ['t1c']);
  assert.deepEqual(model.patch, [192, 192, 32]);
  assert.match(model.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => modelById('unknown'), /no model/);
});

test('checkPreparedGrid enforces 240x240x155 1 mm atlas grid', () => {
  assert.doesNotThrow(() => checkPreparedGrid({ dims: [...ATLAS_DIMS], affine: IDENTITY_AFFINE }));
  assert.throws(() => checkPreparedGrid({ dims: [128, 128, 128], affine: IDENTITY_AFFINE }), /240 × 240 × 155/);
  assert.throws(
    () => checkPreparedGrid({ dims: [...ATLAS_DIMS], affine: [[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }),
    /1 mm/,
  );
  assert.throws(
    () => checkPreparedGrid({ dims: [...ATLAS_DIMS], affine: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }),
    /degenerate/,
  );
});

test('scaleIntensityPercentiles matches MONAI 0.5-99.5 percentile scaling and handles NaN/Inf', () => {
  const input = new Float32Array(201);
  for (let i = 0; i < 201; i++) input[i] = i;
  input[0] = Number.NaN; // becomes 0 -> 0.5 percentile is 1.0, 99.5 percentile is 199.0
  const scaled = scaleIntensityPercentiles(input, 0.5, 99.5);
  assert.equal(scaled[0], 0);
  assert.equal(scaled[1], 0);
  assert.ok(Math.abs(scaled[100] - (100 - 1) / (199 - 1)) < 1e-6);
  assert.equal(scaled[199], 1);
  assert.equal(scaled[200], 1);
});

test('niftiToMonai and monaiToNiftiUint8 invert cleanly across non-cubic dims', () => {
  const dims = [4, 5, 3];
  const nifti = new Float32Array(4 * 5 * 3);
  for (let z = 0; z < 3; z++) {
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 4; x++) {
        nifti[(z * 5 + y) * 4 + x] = x + y * 10 + z * 100;
      }
    }
  }
  const monai = niftiToMonai(nifti, dims);
  // Check C-order (x, y, z) indexing:
  assert.equal(monai[(2 * 5 + 3) * 3 + 1], 2 + 30 + 100);
  const back = monaiToNiftiUint8(Uint8Array.from(monai, (v) => v % 250), dims);
  assert.equal(back[(1 * 5 + 3) * 4 + 2], (2 + 30 + 100) % 250);
});

test('densePatchOrigins and monaiGaussianWeights match MONAI on 240x240x155 with 192x192x32', () => {
  const origins = densePatchOrigins([240, 240, 155], [192, 192, 32], 0.5);
  assert.equal(origins.length, 36);
  assert.deepEqual([...new Set(origins.map((o) => o[0]))], [0, 48]);
  assert.deepEqual([...new Set(origins.map((o) => o[1]))], [0, 48]);
  assert.deepEqual([...new Set(origins.map((o) => o[2]))], [0, 16, 32, 48, 64, 80, 96, 112, 123]);

  const weights = monaiGaussianWeights([192, 192, 32], 0.125);
  assert.equal(weights.length, 192 * 192 * 32);
  let minW = Infinity;
  let maxW = -Infinity;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] < minW) minW = weights[i];
    if (weights[i] > maxW) maxW = weights[i];
  }
  assert.ok(Math.abs(minW - 1e-3) < 1e-6);
  assert.ok(maxW > 0.99 && maxW <= 1.0);
});

test('padReplicate pads smaller dimensions symmetrically using edge replication', () => {
  const data = new Float32Array([1, 2, 3, 4]); // 2x2x1
  const padded = padReplicate(data, [2, 2, 1], [4, 2, 3]);
  assert.deepEqual(padded.shape, [4, 2, 3]);
  assert.deepEqual(padded.before, [1, 0, 1]);
  assert.equal(padded.data[0], 1); // replicated edge (x=0 -> rx=0, y=0, z=0 -> rz=0)
});

test('postprocessLogits preserves upstream 2-region convention (enhancing overwrites whole)', () => {
  const logits = new Float32Array([
    -5, 2, 2, -2, // channel 0: whole
    -5, -2, 2, 2, // channel 1: enhancing (voxel 3 has enh=1, whole=0 -> label 2)
  ]);
  const { labels, wholeMask, enhancingMask } = postprocessLogits(logits, 4, 0.5);
  assert.deepEqual(Array.from(labels), [0, 1, 2, 2]);
  assert.deepEqual(Array.from(wholeMask), [0, 1, 1, 0]);
  assert.deepEqual(Array.from(enhancingMask), [0, 0, 1, 1]);
  assert.throws(() => checkLogits(new Float32Array([0, 0, 0, 0])), /same score/);
  assert.throws(() => checkLogits(new Float32Array([0, Number.NaN])), /non-finite/);
});

test('segmentMetastasis, connectedLesions, and segmentationResults integrate end to end', async () => {
  const dims = [8, 8, 8];
  const data = new Float32Array(512);
  for (let z = 0; z < 8; z++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        data[(z * 8 + y) * 8 + x] = x + y + z;
      }
    }
  }
  const result = await segmentMetastasis({
    volume: { data, dims, affine: IDENTITY_AFFINE },
    model: { patch: [6, 6, 6], overlap: 0.5 },
    skipGridCheck: true,
    runPatch: async (tile) => {
      const n = tile.length;
      const out = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        out[i] = tile[i] > 0.5 ? 3.0 : -3.0; // whole
        out[n + i] = tile[i] > 0.75 ? 3.0 : -3.0; // enhancing
      }
      return out;
    },
  });
  assert.equal(result.windows, 8);
  const rows = volumeRows(result.labels, IDENTITY_AFFINE);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[1].id, '2');
  assert.ok(rows[0].voxels > 0 && rows[1].voxels > 0);
  const lesions = connectedLesions(result.labels, dims, IDENTITY_AFFINE, { minVoxels: 2 });
  assert.equal(lesions.length, 1);
  assert.equal(lesions[0].voxels, rows[1].voxels);
  const pack = segmentationResults(result, stemName('BraTS-MET-00110-000-t1c.nii.gz'));
  assert.equal(pack.segmentation.name, 'BraTS-MET-00110-000-t1c_aurora_seg.nii');
  const tableText = volumeTable(rows, lesions);
  assert.match(tableText, /region\tstructure\tvoxels\tvolume_ml\tlesions_26conn_ge5/);
  assert.match(tableText, /^MET\tMetastasis \(label 2\)\t\d+\t[\d.]+\t1$/m);
  const cmp = compareLabels(result.labels, result.labels);
  assert.equal(cmp.differing, 0);
  assert.equal(cmp.dice.WL, 1);
  assert.equal(cmp.dice.MET, 1);
});

test('parseNiftiVolume preserves NaN/Inf for nanToNum and segmentationResults preserves qform/sform headers', async () => {
  const dims = [8, 8, 8];
  const nvox = 8 * 8 * 8;
  const buf = new ArrayBuffer(352 + nvox * 4);
  const dv = new DataView(buf);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, dims[0], true);
  dv.setInt16(44, dims[1], true);
  dv.setInt16(46, dims[2], true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, 16, true); // float32
  dv.setInt16(72, 32, true);
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, 1, true);
  dv.setFloat32(84, 1, true);
  dv.setFloat32(88, 1, true);
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true);
  dv.setUint8(123, 2);
  dv.setInt16(252, 1, true); // qform_code = 1
  dv.setInt16(254, 1, true); // sform_code = 1
  dv.setFloat32(280, 1, true);
  dv.setFloat32(300, 1, true);
  dv.setFloat32(320, 1, true);
  new Uint8Array(buf).set([0x6e, 0x2b, 0x31, 0x00], 344);
  const voxels = new Float32Array(buf, 352, nvox);
  for (let i = 0; i < nvox; i++) voxels[i] = i / nvox;
  voxels[0] = Number.NaN;
  voxels[1] = Number.POSITIVE_INFINITY;

  const parsed = parseNiftiVolume(buf);
  assert.ok(Number.isNaN(parsed.imageData[0]));
  const result = await segmentMetastasis({
    volume: { data: parsed.imageData, dims: parsed.dims, affine: parsed.affine },
    model: { patch: [6, 6, 6], overlap: 0.5 },
    skipGridCheck: true,
    runPatch: async (tile) => {
      for (let i = 0; i < tile.length; i++) assert.ok(Number.isFinite(tile[i]));
      const out = new Float32Array(2 * tile.length);
      for (let i = 0; i < tile.length; i++) {
        out[i] = tile[i] > 0.5 ? 2 : -2;
        out[tile.length + i] = tile[i] > 0.8 ? 2 : -2;
      }
      return out;
    },
  });
  const pack = segmentationResults({ ...result, headerBytes: parsed.headerBytes }, 'nan_case');
  const outHeader = parseNiftiHeader(pack.segmentation.bytes);
  assert.equal(outHeader.qformCode, 1);
  assert.equal(outHeader.sformCode, 1);
  assert.equal(outHeader.datatype, 2);
});
