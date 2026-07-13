#!/usr/bin/env node --no-warnings
// Real-data registration quality gate for the SynthMorph browser model.
//
// The existing registration parity test proves the ONNX/runtime plumbing on
// a self-pair. This test uses the real ds004884 T1 fixture and asserts that
// the nonlinear registration improves measurable alignment to the fixed
// lnm-mni160 template: foreground brain-mask Dice, masked intensity NCC, and
// centroid drift. It runs the active manifest model by default, or a local
// candidate model when REGISTRATION_MODEL_PATH is supplied.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_CACHE = path.join(ROOT, 'web/models/_dev_cache');
const MANIFEST_PATH = path.join(ROOT, 'web/models/manifest.json');
const EXPECTED_PATH = path.join(ROOT, 'tests/fixtures/ds004884-mini/expected_registration_quality.json');
const T1_PATH = path.join(ROOT, 'tests/fixtures/ds004884-mini/T1.nii.gz');

const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
const modelAsset = manifest.modelAssets.find(a => a.id === 'lnm-synthmorph-mni');
if (!modelAsset) throw new Error("manifest missing modelAsset 'lnm-synthmorph-mni'");
const refAsset = manifest.atlasAssets.find(a => a.id === 'lnm-mni160');
if (!refAsset) throw new Error("manifest missing atlasAsset 'lnm-mni160'");

const { principalAxisAlign, centroidOfMask } =
  await import(path.join(ROOT, 'web/js/modules/prealign.js'));
const { resampleAffine } =
  await import(path.join(ROOT, 'web/js/modules/resample.js'));
const { resampleVolume } =
  await import(path.join(ROOT, 'web/js/modules/volume-utils.js'));
const { integrateSvf, upsampleDisplacementField, warpVolume, displacementMagnitudeField } =
  await import(path.join(ROOT, 'web/js/modules/registration.js'));
const niftiMod = await import('nifti-reader-js');
const nifti = niftiMod.default || niftiMod;

function parseDims(spec) {
  if (!spec) return null;
  const dims = spec.split('x').map(v => Number(v));
  if (dims.length !== 3 || dims.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error(`Invalid dimension spec '${spec}'`);
  }
  return dims;
}

function dimsFromFilename(filePath) {
  const match = path.basename(filePath).match(/(\d+)x(\d+)x(\d+)/);
  return match ? match.slice(1).map(v => Number(v)) : null;
}

async function ensureFile(cachePath, url, minBytes, label) {
  try {
    const stat = await fs.stat(cachePath);
    if (stat.size > minBytes) return cachePath;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!url) throw new Error(`${label} is missing locally and no download URL was provided`);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  console.log(`Downloading ${label} from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= minBytes) {
    throw new Error(`${label} unexpectedly small: ${bytes.length} bytes`);
  }
  await fs.writeFile(cachePath, bytes);
  return cachePath;
}

async function decodeNifti(filePath) {
  const bytes = await fs.readFile(filePath);
  let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buffer = nifti.decompress(buffer);
  if (!nifti.isNIFTI(buffer)) throw new Error(`Not a NIfTI file: ${filePath}`);
  const header = nifti.readHeader(buffer);
  const image = nifti.readImage(header, buffer);
  let data;
  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8: data = new Uint8Array(image); break;
    case nifti.NIFTI1.TYPE_INT16: data = new Int16Array(image); break;
    case nifti.NIFTI1.TYPE_INT32: data = new Int32Array(image); break;
    case nifti.NIFTI1.TYPE_FLOAT32: data = Float32Array.from(new Float32Array(image)); break;
    case nifti.NIFTI1.TYPE_FLOAT64: data = Float32Array.from(new Float64Array(image)); break;
    default: throw new Error(`Unsupported datatype ${header.datatypeCode}: ${filePath}`);
  }
  return {
    data,
    dims: [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])],
    affine: header.affine
  };
}

function foregroundMask(data, fractionOfMax) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = Number(data[i]);
    if (value > max) max = value;
  }
  const threshold = (Number.isFinite(max) ? max : 0) * fractionOfMax;
  const mask = new Uint8Array(data.length);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number(data[i]) > threshold) {
      mask[i] = 1;
      count++;
    }
  }
  if (count === 0) throw new Error('foreground mask is empty');
  return { mask, count, threshold };
}

function robustNormalizeMasked(data, mask, { zeroOutside = false } = {}) {
  const values = [];
  for (let i = 0; i < data.length; i++) {
    if (!mask || mask[i]) values.push(Number(data[i]) || 0);
  }
  values.sort((a, b) => a - b);
  const valueAt = q => values[Math.max(0, Math.min(values.length - 1, Math.floor(q * (values.length - 1))))];
  const lo = valueAt(0.01);
  const hi = valueAt(0.99);
  const range = (hi - lo) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (zeroOutside && mask && !mask[i]) {
      out[i] = 0;
      continue;
    }
    const v = (Number(data[i]) - lo) / range;
    out[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return out;
}

function fOrderToNDHWC(data, dims) {
  const [X, Y, Z] = dims;
  const out = new Float32Array(X * Y * Z);
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        out[(x * Y + y) * Z + z] = data[x + y * X + z * X * Y];
      }
    }
  }
  return out;
}

function dice(a, b) {
  let ca = 0, cb = 0, inter = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) ca++;
    if (b[i]) cb++;
    if (a[i] && b[i]) inter++;
  }
  return (2 * inter) / (ca + cb);
}

function centroid(mask, dims) {
  const c = centroidOfMask(mask, dims);
  return c.map(v => Number(v));
}

function maskedNcc(a, b, mask) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue;
    n++;
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let va = 0, vb = 0, cov = 0;
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue;
    const da = a[i] - ma;
    const db = b[i] - mb;
    va += da * da;
    vb += db * db;
    cov += da * db;
  }
  return cov / Math.sqrt(va * vb);
}

function unionMask(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

function maxAbs(values) {
  return Math.max(...values.map(v => Math.abs(v)));
}

function round(value, places = 4) {
  return Number(value.toFixed(places));
}

function roundedArray(values, places = 2) {
  return values.map(v => Number(v.toFixed(places)));
}

const overrideModelPath = process.env.REGISTRATION_MODEL_PATH
  ? path.resolve(ROOT, process.env.REGISTRATION_MODEL_PATH)
  : null;
const modelPath = overrideModelPath || path.join(DEV_CACHE, path.basename(modelAsset.filename));
const modelUrl = overrideModelPath ? null : modelAsset.sourceUrl;
await ensureFile(modelPath, modelUrl, 50_000_000, 'SynthMorph registration model');
const refPath = path.join(DEV_CACHE, path.basename(refAsset.filename || 'lnm-mni160.nii.gz'));
await ensureFile(refPath, refAsset.sourceUrl, 5_000_000, 'lnm-mni160 reference');

const modelDims =
  parseDims(process.env.REGISTRATION_MODEL_DIMS) ||
  dimsFromFilename(modelPath) ||
  modelAsset.browserRuntime?.inputDims ||
  modelAsset.inputShape?.slice(1, 4);
const svfDims =
  parseDims(process.env.REGISTRATION_SVF_DIMS) ||
  modelDims.map(v => v / 2);
const gridKey = modelDims.join('x');

const expected = JSON.parse(await fs.readFile(EXPECTED_PATH, 'utf8'));
const expectedForGrid = expected.models[gridKey];
if (!expectedForGrid) {
  throw new Error(`No registration quality golden metrics for grid ${gridKey}`);
}

const t1 = await decodeNifti(T1_PATH);
const ref = await decodeNifti(refPath);
assert.deepEqual(ref.dims, [160, 160, 192], 'lnm-mni160 reference dimensions changed');

const sourceForeground = foregroundMask(t1.data, 0.10);
const targetForeground = foregroundMask(ref.data, 0.05);
const targetCentroid = centroid(targetForeground.mask, ref.dims);
const { dstAffine, mniDims } = principalAxisAlign(sourceForeground.mask, t1.dims, t1.affine, {
  mniDims: ref.dims,
  mniCenterVox: targetCentroid
});

const prealignedT1 = resampleAffine(t1.data, t1.dims, t1.affine, mniDims, dstAffine, 'trilinear');
const prealignedMask = Uint8Array.from(
  resampleAffine(sourceForeground.mask, t1.dims, t1.affine, mniDims, dstAffine, 'nearest'),
  v => v > 0.5 ? 1 : 0
);

const sourceNormalized = robustNormalizeMasked(prealignedT1, prealignedMask, { zeroOutside: true });
const targetNormalized = robustNormalizeMasked(ref.data, targetForeground.mask, { zeroOutside: true });
const modelSpacing = ref.dims.map((dim, i) => dim / modelDims[i]);
const sourceModel = resampleVolume(sourceNormalized, ref.dims, [1, 1, 1], modelSpacing);
const targetModel = resampleVolume(targetNormalized, ref.dims, [1, 1, 1], modelSpacing);
assert.deepEqual(sourceModel.dims, modelDims, 'source downsample grid mismatch');
assert.deepEqual(targetModel.dims, modelDims, 'target downsample grid mismatch');

console.log(`Running registration quality gate with ${gridKey} model: ${path.relative(ROOT, modelPath)}`);
const session = await ort.InferenceSession.create(await fs.readFile(modelPath), {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all'
});
const inputNames = session.inputNames;
const outputName = session.outputNames[0];
const out = await session.run({
  [inputNames[0]]: new ort.Tensor('float32', fOrderToNDHWC(sourceModel.data, modelDims), [1, ...modelDims, 1]),
  [inputNames[1]]: new ort.Tensor('float32', fOrderToNDHWC(targetModel.data, modelDims), [1, ...modelDims, 1])
});
const svf = out[outputName].data;
const halfDisp = integrateSvf(svf, svfDims, 7);
const fullDisp = upsampleDisplacementField(halfDisp, svfDims, ref.dims);
const registeredT1 = warpVolume(sourceNormalized, ref.dims, fullDisp, ref.dims);
const registeredMask = Uint8Array.from(
  warpVolume(Float32Array.from(prealignedMask), ref.dims, fullDisp, ref.dims),
  v => v > 0.5 ? 1 : 0
);

const preCentroid = centroid(prealignedMask, ref.dims);
const regCentroid = centroid(registeredMask, ref.dims);
const preDrift = preCentroid.map((v, i) => v - targetCentroid[i]);
const regDrift = regCentroid.map((v, i) => v - targetCentroid[i]);
const dispMagnitude = displacementMagnitudeField(fullDisp, ref.dims);
let dispMax = 0, dispSum = 0;
for (let i = 0; i < dispMagnitude.length; i++) {
  const v = dispMagnitude[i];
  if (v > dispMax) dispMax = v;
  dispSum += v;
}
const preUnion = unionMask(prealignedMask, targetForeground.mask);
const regUnion = unionMask(registeredMask, targetForeground.mask);
const metrics = {
  grid: gridKey,
  prealign: {
    brainDice: round(dice(prealignedMask, targetForeground.mask)),
    maskedNcc: round(maskedNcc(sourceNormalized, targetNormalized, preUnion)),
    centroidDrift: roundedArray(preDrift),
    maxCentroidDrift: round(maxAbs(preDrift), 2)
  },
  registered: {
    brainDice: round(dice(registeredMask, targetForeground.mask)),
    maskedNcc: round(maskedNcc(registeredT1, targetNormalized, regUnion)),
    centroidDrift: roundedArray(regDrift),
    maxCentroidDrift: round(maxAbs(regDrift), 2)
  },
  displacement: {
    maxMagnitude: round(dispMax, 2),
    meanMagnitude: round(dispSum / dispMagnitude.length, 2)
  }
};

console.log(JSON.stringify(metrics, null, 2));

const tol = expectedForGrid.tolerances;
for (const stage of ['prealign', 'registered']) {
  assert.ok(
    metrics[stage].brainDice >= expectedForGrid[stage].brainDice - tol.brainDice,
    `${stage} brain Dice ${metrics[stage].brainDice} below expected ${expectedForGrid[stage].brainDice}`
  );
  assert.ok(
    metrics[stage].maskedNcc >= expectedForGrid[stage].maskedNcc - tol.maskedNcc,
    `${stage} masked NCC ${metrics[stage].maskedNcc} below expected ${expectedForGrid[stage].maskedNcc}`
  );
  assert.ok(
    metrics[stage].maxCentroidDrift <= expectedForGrid[stage].maxCentroidDrift + tol.centroidVoxels,
    `${stage} centroid drift ${metrics[stage].maxCentroidDrift} exceeds expected ` +
      `${expectedForGrid[stage].maxCentroidDrift}`
  );
}
assert.ok(
  metrics.registered.brainDice >= metrics.prealign.brainDice + expectedForGrid.minimumGains.brainDice,
  `registered Dice must improve over prealign by at least ${expectedForGrid.minimumGains.brainDice}`
);
assert.ok(
  metrics.registered.maskedNcc >= metrics.prealign.maskedNcc + expectedForGrid.minimumGains.maskedNcc,
  `registered NCC must improve over prealign by at least ${expectedForGrid.minimumGains.maskedNcc}`
);
assert.ok(
  metrics.registered.maxCentroidDrift <= metrics.prealign.maxCentroidDrift,
  'registered centroid drift must not be worse than prealign'
);
assert.ok(
  metrics.displacement.maxMagnitude <= expectedForGrid.displacement.maxMagnitude + tol.displacementMagnitude,
  `displacement max ${metrics.displacement.maxMagnitude} exceeds expected bound`
);

console.log(
  `registration-quality OK: ${gridKey} Dice ${metrics.prealign.brainDice} -> ` +
  `${metrics.registered.brainDice}, NCC ${metrics.prealign.maskedNcc} -> ` +
  `${metrics.registered.maskedNcc}, centroid max drift ${metrics.prealign.maxCentroidDrift} -> ` +
  `${metrics.registered.maxCentroidDrift} voxels.`
);
