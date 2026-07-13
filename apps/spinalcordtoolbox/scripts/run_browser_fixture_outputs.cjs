#!/usr/bin/env node
'use strict';

/**
 * Reference-output generator for the batch-parity fixtures. Drives the SCT
 * inference pipeline (shared with the browser worker via web/js/inference-pipeline.js)
 * on each fixture's input and writes the resulting browser_output.nii.gz.
 *
 * Single source of truth: this script uses the same pipeline module as
 * web/js/inference-worker.js. Patch size + threshold come from the per-task
 * model manifest at web/models/manifest.json so the two paths can never drift.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ort = require('onnxruntime-node');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti, compareNiftiOutputs } = require('./batch-parity-lib.cjs');
const { ensureHostedAsset } = require('./hosted-assets.cjs');
const loadClassicScript = require('./load-classic-script.cjs');
const pipeline = loadClassicScript(path.resolve(__dirname, '../web/js/inference-pipeline.js'));
const vertebrae = loadClassicScript(path.resolve(__dirname, '../web/js/modules/vertebrae.js'));

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
const THRESHOLD_OVERRIDE = process.env.BROWSER_THRESHOLD ? Number(process.env.BROWSER_THRESHOLD) : null;
const MIN_COMPONENT_SIZE_OVERRIDE = process.env.BROWSER_MIN_COMPONENT_SIZE ? Number(process.env.BROWSER_MIN_COMPONENT_SIZE) : null;

function readNiftiRaw(filePath) {
  const compressed = fs.readFileSync(filePath);
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (bytes.readInt32LE(0) !== 348) throw new Error(`Only little-endian NIfTI-1 is supported: ${filePath}`);
  const dims = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const datatype = bytes.readInt16LE(70);
  const voxOffset = Math.ceil(bytes.readFloatLE(108));
  const slopeRaw = bytes.readFloatLE(112);
  const interRaw = bytes.readFloatLE(116);
  const slope = Number.isFinite(slopeRaw) && slopeRaw !== 0 ? slopeRaw : 1;
  const inter = Number.isFinite(interRaw) ? interRaw : 0;
  const n = dims[0] * dims[1] * dims[2];
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (datatype === 2) data[i] = bytes[voxOffset + i] * slope + inter;
    else if (datatype === 4) data[i] = bytes.readInt16LE(voxOffset + i * 2) * slope + inter;
    else if (datatype === 8) data[i] = bytes.readInt32LE(voxOffset + i * 4) * slope + inter;
    else if (datatype === 16) data[i] = bytes.readFloatLE(voxOffset + i * 4) * slope + inter;
    else if (datatype === 64) data[i] = bytes.readDoubleLE(voxOffset + i * 8) * slope + inter;
    else throw new Error(`Unsupported datatype ${datatype}: ${filePath}`);
  }
  const header = bytes.subarray(0, voxOffset);
  return { header, dims, data, affine: extractAffine(header) };
}

function extractAffine(header) {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const sformCode = view.getInt16(254, true);
  const qformCode = view.getInt16(252, true);
  if (sformCode > 0) {
    const affine = [new Float64Array(4), new Float64Array(4), new Float64Array(4), new Float64Array([0, 0, 0, 1])];
    for (let i = 0; i < 4; i++) {
      affine[0][i] = view.getFloat32(280 + i * 4, true);
      affine[1][i] = view.getFloat32(296 + i * 4, true);
      affine[2][i] = view.getFloat32(312 + i * 4, true);
    }
    return affine;
  }
  if (qformCode > 0) {
    const pixDims = [];
    for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
    const qb = view.getFloat32(256, true);
    const qc = view.getFloat32(260, true);
    const qd = view.getFloat32(264, true);
    const qx = view.getFloat32(268, true);
    const qy = view.getFloat32(272, true);
    const qz = view.getFloat32(276, true);
    const sqr = qb * qb + qc * qc + qd * qd;
    const qa = sqr > 1.0 ? 0.0 : Math.sqrt(1.0 - sqr);
    const R = [
      [qa*qa+qb*qb-qc*qc-qd*qd, 2*(qb*qc-qa*qd), 2*(qb*qd+qa*qc)],
      [2*(qb*qc+qa*qd), qa*qa+qc*qc-qb*qb-qd*qd, 2*(qc*qd-qa*qb)],
      [2*(qb*qd-qa*qc), 2*(qc*qd+qa*qb), qa*qa+qd*qd-qb*qb-qc*qc]
    ];
    const qfac = pixDims[0] < 0 ? -1 : 1;
    return [
      new Float64Array([R[0][0]*pixDims[1], R[0][1]*pixDims[2], R[0][2]*pixDims[3]*qfac, qx]),
      new Float64Array([R[1][0]*pixDims[1], R[1][1]*pixDims[2], R[1][2]*pixDims[3]*qfac, qy]),
      new Float64Array([R[2][0]*pixDims[1], R[2][1]*pixDims[2], R[2][2]*pixDims[3]*qfac, qz]),
      new Float64Array([0, 0, 0, 1])
    ];
  }
  const pixDims = [];
  for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

function getOrientationTransform(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];
  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];
  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestVal = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const val = Math.abs(mat[outAxis][inAxis]);
      if (val > bestVal) {
        bestVal = val;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }
  return { perm, flip };
}

function orientToRAS(data, dims, perm, flip) {
  const srcDims = dims;
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new Float32Array(dx * dy * dz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dstDims[i] - 1 - coords[i]) : coords[i];
        }
        result[ox + oy*dx + oz*dx*dy] = data[src[0] + src[1]*dims[0] + src[2]*dims[0]*dims[1]];
      }
    }
  }
  return { data: result, dims: dstDims };
}

function inverseOrient(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Uint8Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        result[src[0] + src[1]*nx + src[2]*nx*ny] = data[ox + oy*dx + oz*dx*dy];
      }
    }
  }
  return result;
}

function writeUint8NiftiGz(outPath, header, dims, labels) {
  const out = Buffer.alloc(header.length + labels.length);
  Buffer.from(header).copy(out, 0, 0, header.length);
  out.writeInt16LE(2, 70);
  out.writeInt16LE(8, 72);
  out.writeInt16LE(3, 40);
  out.writeInt16LE(dims[0], 42);
  out.writeInt16LE(dims[1], 44);
  out.writeInt16LE(dims[2], 46);
  out.writeInt16LE(1, 48);
  out.writeFloatLE(1, 112);
  out.writeFloatLE(0, 116);
  out.writeFloatLE(1, 124);
  out.writeFloatLE(0, 128);
  Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength).copy(out, header.length);
  fs.writeFileSync(outPath, zlib.gzipSync(out));
}

/**
 * Look up the model asset (patchSize, defaults) used for a given fixture.
 * Mirrors the manifest the browser worker reads.
 */
function resolveTaskAsset(fixtureId) {
  const taskId = fixtureId.includes('lesion_sci_t2')
    ? 'lesion_sci_t2'
    : (fixtureId.includes('graymatter') ? 'graymatter' : 'spinalcord');
  const task = MANIFEST.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`No task in manifest matching fixture id ${fixtureId}`);
  const asset = task.modelAssets[0];
  if (!asset) throw new Error(`No model asset for task ${taskId}`);
  return { taskId, asset };
}

function resolveTaskTemplateAsset(taskId, assetId) {
  const task = MANIFEST.tasks.find(t => t.id === taskId);
  const asset = task?.templateAssets?.find(item => item.id === assetId);
  if (!asset) throw new Error(`No template asset ${assetId} for task ${taskId}`);
  return asset;
}

function browserOutputPathForFixture(fixture, stage = null) {
  if (stage && fixture.browserOutputPaths?.[stage]) {
    return path.join(ROOT, fixture.browserOutputPaths[stage]);
  }
  return path.join(path.dirname(path.join(ROOT, fixture.inputPath)), 'browser_output.nii.gz');
}

function expectedOutputPathForFixture(fixture, stage = null) {
  if (stage && fixture.expectedOutputPaths?.[stage]) {
    return path.join(ROOT, fixture.expectedOutputPaths[stage]);
  }
  return path.join(ROOT, fixture.expectedOutputPath);
}

function shouldUseZYXModelAxisOrder(preprocessing, dims, patchSize) {
  const modelAxisOrder = preprocessing?.modelAxisOrder;
  if (modelAxisOrder === 'zyx') return true;
  if (modelAxisOrder !== 'zyx-if-x-short-z-long') return false;

  const [nx, , nz] = dims;
  const [px] = Array.isArray(patchSize) ? patchSize : [];
  return Number.isFinite(px) && nx < px && nz >= px;
}

function diceVsExpected(producedLabels, expectedData) {
  let expectedNz = 0, producedNz = 0, intersection = 0;
  for (let i = 0; i < expectedData.length; i++) {
    const e = expectedData[i] > 0;
    const p = producedLabels[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  const dice = expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  return { expectedNz, producedNz, intersection, dice };
}

function multilabelDiceVsExpected(producedLabels, expectedData) {
  const labels = new Set();
  for (let i = 0; i < expectedData.length; i++) {
    const e = Math.round(expectedData[i]);
    const p = Math.round(producedLabels[i]);
    if (e > 0) labels.add(e);
    if (p > 0) labels.add(p);
  }
  let meanDice = 0;
  for (const label of labels) {
    let expectedNz = 0, producedNz = 0, intersection = 0;
    for (let i = 0; i < expectedData.length; i++) {
      const e = Math.round(expectedData[i]) === label;
      const p = Math.round(producedLabels[i]) === label;
      if (e) expectedNz++;
      if (p) producedNz++;
      if (e && p) intersection++;
    }
    meanDice += expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  }
  return labels.size ? meanDice / labels.size : 1;
}

function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const newDims = [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / tgtSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / tgtSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / tgtSpacing[2]))
  ];
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);
  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);
  for (let z = 0; z < nnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;
    for (let y = 0; y < nny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;
      for (let x = 0; x < nnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;
        const c000 = data[x0 + y0*nx + z0*nx*ny];
        const c100 = data[x1 + y0*nx + z0*nx*ny];
        const c010 = data[x0 + y1*nx + z0*nx*ny];
        const c110 = data[x1 + y1*nx + z0*nx*ny];
        const c001 = data[x0 + y0*nx + z1*nx*ny];
        const c101 = data[x1 + y0*nx + z1*nx*ny];
        const c011 = data[x0 + y1*nx + z1*nx*ny];
        const c111 = data[x1 + y1*nx + z1*nx*ny];
        const c00 = c000*(1-wx) + c100*wx;
        const c10 = c010*(1-wx) + c110*wx;
        const c01 = c001*(1-wx) + c101*wx;
        const c11 = c011*(1-wx) + c111*wx;
        result[x + y*nnx + z*nnx*nny] = (c00*(1-wy) + c10*wy)*(1-wz) + (c01*(1-wy) + c11*wy)*wz;
      }
    }
  }
  return { data: result, dims: newDims };
}

function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  for (let z = 0; z < tnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / tnz)), nz - 1);
    for (let y = 0; y < tny; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / tny)), ny - 1);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / tnx)), nx - 1);
        result[x + y*tnx + z*tnx*tny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return result;
}

function transposeXYZToZYX(data, dims, OutputCtor) {
  const [nx, ny, nz] = dims;
  const result = new (OutputCtor || Float32Array)(data.length);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        result[z + y*nz + x*nz*ny] = data[x + y*nx + z*nx*ny];
  return { data: result, dims: [nz, ny, nx] };
}

function transposeZYXToXYZ(data, dims, OutputCtor) {
  const [nz, ny, nx] = dims;
  const result = new (OutputCtor || Uint8Array)(data.length);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        result[x + y*nx + z*nx*ny] = data[z + y*nz + x*nz*ny];
  return { data: result, dims: [nx, ny, nz] };
}

function flipVolumeAxes(data, dims, axes, OutputCtor) {
  const [nx, ny, nz] = dims;
  const result = new (OutputCtor || data.constructor || Uint8Array)(data.length);
  const flipX = axes.includes(0);
  const flipY = axes.includes(1);
  const flipZ = axes.includes(2);
  for (let z = 0; z < nz; z++) {
    const sz = flipZ ? nz - 1 - z : z;
    for (let y = 0; y < ny; y++) {
      const sy = flipY ? ny - 1 - y : y;
      for (let x = 0; x < nx; x++) {
        const sx = flipX ? nx - 1 - x : x;
        result[x + y*nx + z*nx*ny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return { data: result, dims: [...dims] };
}

function orientationFlipAxesFromRAS(modelOrientation) {
  if (!modelOrientation || modelOrientation === 'RAS') return [];
  if (modelOrientation === 'RPI') return [1, 2];
  if (modelOrientation === 'LPI') return [0, 1, 2];
  throw new Error(`Unsupported modelOrientation "${modelOrientation}"`);
}

async function runCase(fixture) {
  const inputPath = path.join(ROOT, fixture.inputPath);
  const { taskId, asset } = resolveTaskAsset(fixture.id);
  const { path: modelPath } = await ensureHostedAsset(ROOT, asset);

  const { header, dims, data, affine } = readNiftiRaw(inputPath);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const nativeSpacing = [headerView.getFloat32(80, true), headerView.getFloat32(84, true), headerView.getFloat32(88, true)].map(v => Math.abs(v) || 1);
  const { perm, flip } = getOrientationTransform(affine);
  const isIdentityOrientation = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip[0] && !flip[1] && !flip[2];
  const rasSpacing = [nativeSpacing[perm[0]], nativeSpacing[perm[1]], nativeSpacing[perm[2]]];
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const patchSize = asset.patchSize;
  const overlap = asset.inferenceDefaults?.overlap ?? 0;
  const threshold = THRESHOLD_OVERRIDE != null ? THRESHOLD_OVERRIDE : (asset.inferenceDefaults?.probabilityThreshold ?? 0.5);
  const minComponentSize = MIN_COMPONENT_SIZE_OVERRIDE != null ? MIN_COMPONENT_SIZE_OVERRIDE : (asset.inferenceDefaults?.minComponentSize ?? 10);
  const keepLargestComponent = !!asset.inferenceDefaults?.keepLargestComponent;
  const testTimeAugmentation = !!asset.inferenceDefaults?.testTimeAugmentation;

  const runPatch = async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const tensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const result = await session.run({ [inputName]: tensor });
    return result[outputName].data;
  };

  let modelInputData = data;
  let modelInputDims = dims;
  let modelOutputToInput = (labels, labelDims) => ({ labels, dims: labelDims });
  if (!isIdentityOrientation) {
    const oriented = orientToRAS(data, dims, perm, flip);
    modelInputData = oriented.data;
    modelInputDims = oriented.dims;
  }
  if (Array.isArray(asset.preprocessing?.targetSpacing)) {
    const targetSpacing = asset.preprocessing.targetSpacing.map((value, index) => value == null ? rasSpacing[index] : Number(value));
    const resampleSourceDims = [...modelInputDims];
    const resampled = resampleVolume(modelInputData, modelInputDims, rasSpacing, targetSpacing);
    modelInputData = resampled.data;
    modelInputDims = resampled.dims;
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restored = previous(labels, labelDims);
      return { labels: resampleLabelsNearest(restored.labels, restored.dims, resampleSourceDims), dims: resampleSourceDims };
    };
  }
  const modelOrientationFlipAxes = orientationFlipAxesFromRAS(asset.preprocessing?.modelOrientation);
  if (modelOrientationFlipAxes.length > 0) {
    const oriented = flipVolumeAxes(modelInputData, modelInputDims, modelOrientationFlipAxes, Float32Array);
    modelInputData = oriented.data;
    modelInputDims = oriented.dims;
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restoredOrientation = flipVolumeAxes(labels, labelDims, modelOrientationFlipAxes, Uint8Array);
      return previous(restoredOrientation.data, restoredOrientation.dims);
    };
  }
  if (shouldUseZYXModelAxisOrder(asset.preprocessing, modelInputDims, patchSize)) {
    const transposed = transposeXYZToZYX(modelInputData, modelInputDims, Float32Array);
    modelInputData = transposed.data;
    modelInputDims = transposed.dims;
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restoredAxes = transposeZYXToXYZ(labels, labelDims, Uint8Array);
      return previous(restoredAxes.data, restoredAxes.dims);
    };
  }
  if (!isIdentityOrientation) {
    const previous = modelOutputToInput;
    modelOutputToInput = (labels, labelDims) => {
      const restored = previous(labels, labelDims);
      return { labels: inverseOrient(restored.labels, restored.dims, perm, flip, dims), dims };
    };
  }

  if (asset.output?.activation === 'sigmoid-regions') {
    const result = await pipeline.runRegionInferencePipeline(
      { data: modelInputData, dims: modelInputDims, patchSize },
      runPatch,
      {
        overlap,
        threshold,
        minComponentSize,
        testTimeAugmentation,
        channelCount: asset.output.channelCount || asset.output.channelOrder?.length || asset.output.regions?.length || 1,
        regions: asset.output.regions || [],
        onLog: () => {},
        onProgress: (stepsDone, totalSteps) => {
          if (totalSteps && stepsDone % 5 === 0) process.stderr.write(`${fixture.id}: ${stepsDone}/${totalSteps}\n`);
        },
        onPatchStats: () => {}
      }
    );
    await session.release();

    const outputs = [];
    for (const region of result.regions) {
      const stage = region.stage || region.name;
      if (!fixture.browserOutputPaths?.[stage]) continue;
      const outPath = browserOutputPathForFixture(fixture, stage);
      const restored = modelOutputToInput(region.labels, region.dims);
      writeUint8NiftiGz(outPath, header, dims, restored.labels);

      const expected = loadNifti(expectedOutputPathForFixture(fixture, stage));
      const produced = loadNifti(outPath);
      const mismatches = compareNiftiOutputs(expected, produced, fixture.tolerancePolicy, path.basename(outPath), path.basename(outPath));
      const { expectedNz, producedNz, dice } = diceVsExpected(produced.data, expected.data);
      outputs.push({ id: fixture.id, stage, outPath: path.relative(ROOT, outPath), mismatches, expectedNz, producedNz, dice, multilabelDice: null, threshold, taskId });
    }
    return outputs;
  }

  const result = await pipeline.runInferencePipeline(
    { data: modelInputData, dims: modelInputDims, patchSize },
    runPatch,
    {
      overlap,
      threshold,
      minComponentSize,
      keepLargestComponent,
      testTimeAugmentation,
      onLog: () => {},
      onProgress: (stepsDone, totalSteps) => {
        if (totalSteps && stepsDone % 5 === 0) process.stderr.write(`${fixture.id}: ${stepsDone}/${totalSteps}\n`);
      },
      onPatchStats: () => {}
    }
  );
  await session.release();

  const restored = modelOutputToInput(result.labels, result.dims);
  let outputLabels = restored.labels;
  if (fixture.id === 'batch_t2_label_vertebrae') {
    const { path: pam50LevelsPath } = await ensureHostedAsset(ROOT, resolveTaskTemplateAsset('vertebrae', 'pam50-levels'));
    const labeled = await vertebrae.labelVertebrae({
      anatomy: data,
      segmentation: restored.labels,
      dims,
      c2c3ModelUrl: path.join(ROOT, 'web/models/c2c3_disc_models/t2_model.yml'),
      pam50LevelsUrl: pam50LevelsPath,
      scaleDist: 0.55,
      detectorMinScore: 0.1
    });
    process.stderr.write(`${fixture.id}: C2-C3 z=${labeled.detected.z} score=${labeled.detected.score.toFixed(4)} fallback=${!!labeled.detected.fallback}\n`);
    outputLabels = labeled.labels;
  }
  const outPath = browserOutputPathForFixture(fixture);
  writeUint8NiftiGz(outPath, header, dims, outputLabels);

  const expected = loadNifti(expectedOutputPathForFixture(fixture));
  const produced = loadNifti(outPath);
  const mismatches = compareNiftiOutputs(expected, produced, fixture.tolerancePolicy, 'browser_output.nii.gz', 'browser_output.nii.gz');
  const { expectedNz, producedNz, dice } = diceVsExpected(produced.data, expected.data);
  const multilabelDice = fixture.id === 'batch_t2_label_vertebrae'
    ? multilabelDiceVsExpected(produced.data, expected.data)
    : null;
  return [{ id: fixture.id, stage: 'segmentation', outPath: path.relative(ROOT, outPath), mismatches, expectedNz, producedNz, dice, multilabelDice, threshold, taskId }];
}

(async () => {
  const results = [];
  const filter = process.env.BROWSER_FIXTURE_FILTER || '';
  const selectedFixtures = fixtures.FIXTURE_CASES.filter(fixture => !filter || fixture.id.includes(filter));
  for (const fixture of selectedFixtures) {
    results.push(...await runCase(fixture));
  }
  for (const result of results) {
    console.log(JSON.stringify({
      id: result.id,
      stage: result.stage,
      outPath: result.outPath,
      mismatchCount: result.mismatches.length,
      firstMismatch: result.mismatches[0] || null,
      expectedNz: result.expectedNz,
      producedNz: result.producedNz,
      dice: Number(result.dice.toFixed(6)),
      multilabelDice: result.multilabelDice == null ? null : Number(result.multilabelDice.toFixed(6)),
      threshold: result.threshold,
      taskId: result.taskId
    }));
  }
})();
