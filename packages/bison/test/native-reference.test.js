// Parity with the native MINC reference (validation/native): run_native.sh's ref-masked tree for one
// subject, and the held BISON assets. BISON_NATIVE_REFERENCE is the ref-masked directory,
// BISON_ASSET_DIR the directory that holds models/. The inputs are the export's NIfTI checkpoints
// (T1_VP, FLAIR_CR, the warped priors and average images on the native T1 grid), so features,
// classifier and writer are checked apart from preprocessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { decodeNiftiBuffer, extractNiftiHeader, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { buildFeatures, histogramTable, maskVoxels, modeSpec } from '../src/features.js';
import { classifyVoxels, createClassifier } from '../src/classify.js';
import { outputFiles } from '../src/outputs.js';

const reference = process.env.BISON_NATIVE_REFERENCE;
const assets = process.env.BISON_ASSET_DIR;
const skip = !reference || !assets ? 'set BISON_NATIVE_REFERENCE and BISON_ASSET_DIR' : false;

const NPY_TYPES = { '<f4': Float32Array, '<f8': Float64Array, '<i4': Int32Array, '<i8': BigInt64Array };

async function readNpy(path) {
  const bytes = await readFile(path);
  assert.equal(bytes.toString('latin1', 1, 6), 'NUMPY');
  const major = bytes[6];
  const length = major === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + length;
  const header = bytes.toString('latin1', start - length, start);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  assert.match(header, /'fortran_order':\s*False/);
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').filter((s) => s.trim()).map(Number);
  const Type = NPY_TYPES[descr];
  assert.ok(Type, `npy type ${descr}`);
  const data = new Type(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + bytes.length));
  return { data, shape };
}

async function volume(path, Ctor = Float32Array) {
  return (await readNifti(await readFile(path), Ctor)).data;
}

async function modeInputs(mode) {
  const spec = modeSpec(mode);
  const checkpoints = join(reference, mode, 'export', 'nifti', 'checkpoints');
  const models = join(assets, 'models');
  const priors = [];
  for (let k = 1; k <= spec.classes; k++) priors.push(await volume(join(checkpoints, `sp_${k}.nii.gz`)));
  const images = {
    mode,
    priors,
    t1: await volume(join(checkpoints, 'T1_VP.nii.gz')),
    avT1: await volume(join(checkpoints, 'av_t1.nii.gz')),
    t1Histogram: histogramTable(JSON.parse(await readFile(join(models, mode, 't1-histogram.json'), 'utf8')), spec.classes),
  };
  if (spec.flair) {
    images.flair = await volume(join(checkpoints, 'FLAIR_CR.nii.gz'));
    images.avFlair = await volume(join(checkpoints, 'av_flair.nii.gz'));
    images.flairHistogram = histogramTable(JSON.parse(await readFile(join(models, mode, 'flair-histogram.json'), 'utf8')), spec.classes);
  }
  return images;
}

async function nativeFile(mode, suffix) {
  const dir = join(reference, mode, 'export', 'nifti');
  const name = (await readdir(dir)).find((f) => f.endsWith(suffix));
  assert.ok(name, `native ${suffix}`);
  return { name, bytes: await readFile(join(dir, name)) };
}

for (const mode of ['t1', 't1-flair']) {
  test(`${mode}: features, ONNX labels and probabilities, label NIfTI equal the native reference`, { skip, timeout: 3_600_000 }, async (t) => {
    const spec = modeSpec(mode);
    const exportDir = join(reference, mode, 'export');
    const images = await modeInputs(mode);
    const mask = await nativeFile(mode, '_bison-mask.nii.gz');
    const voxels = maskVoxels(await volume(join(reference, mode, 'export', 'nifti', mask.name), Uint8Array));

    const maskIndex = await readNpy(join(exportDir, 'mask_index.npy'));
    assert.equal(voxels.length, maskIndex.data.length);
    for (let r = 0; r < voxels.length; r++) {
      if (voxels[r] !== Number(maskIndex.data[r])) assert.fail(`voxel order differs at row ${r}`);
    }

    const X = await readNpy(join(exportDir, 'X.npy'));
    assert.deepEqual(X.shape, [voxels.length, spec.features]);
    const ours = buildFeatures(images, voxels);
    const maxDiff = new Float64Array(spec.features);
    const differing = new Uint32Array(spec.features);
    for (let i = 0; i < ours.length; i++) {
      const d = Math.abs(ours[i] - X.data[i]);
      const c = i % spec.features;
      if (d > maxDiff[c]) maxDiff[c] = d;
      if (d > 0) differing[c]++;
    }
    t.diagnostic(`${mode} rows ${voxels.length}, feature max abs diff per column ${JSON.stringify([...maxDiff])}`);
    t.diagnostic(`${mode} differing voxels per column ${JSON.stringify([...differing])}`);
    assert.ok(maxDiff.every((d) => d === 0), 'feature matrix differs from X.npy');

    const model = await readFile(join(assets, 'models', `bison-${mode}.onnx`));
    const classifier = await createClassifier(ort, model);
    const started = performance.now();
    const result = await classifyVoxels(classifier, images, voxels);
    t.diagnostic(`${mode} classification ${((performance.now() - started) / 1000).toFixed(1)} s`);
    const predict = await readNpy(join(exportDir, 'predict.npy'));
    const proba = await readNpy(join(exportDir, 'predict_proba.npy'));
    const classes = await readNpy(join(exportDir, 'classes.npy'));
    assert.deepEqual([...classes.data].map(Number), Array.from({ length: result.classCount }, (_, c) => c));
    assert.deepEqual(proba.shape, [voxels.length, result.classCount]);
    let labelMismatch = 0;
    for (let r = 0; r < voxels.length; r++) {
      if (result.labels[r] !== predict.data[r]) labelMismatch++;
    }
    let probaMax = 0;
    for (let i = 0; i < proba.data.length; i++) probaMax = Math.max(probaMax, Math.abs(result.probabilities[i] - proba.data[i]));
    t.diagnostic(`${mode} label mismatches ${labelMismatch}, probability max abs diff ${probaMax}`);
    assert.equal(labelMismatch, 0);
    assert.ok(probaMax < 1e-5, `probability max abs diff ${probaMax}`);

    const t1Header = extractNiftiHeader(await decodeNiftiBuffer(await readFile(join(exportDir, 'nifti', 'checkpoints', 'T1_VP.nii.gz'))));
    const t1Name = mask.name.replace('_bison-mask.nii.gz', '.nii.gz');
    const files = new Map();
    for (const file of outputFiles({ t1Name, t1Header, mode, voxels, ...result })) files.set(file.name, file.bytes);
    assert.equal(files.size, spec.classes + 2);
    const native = await nativeFile(mode, '_bison-labels.nii.gz');
    const ourLabels = await readNifti(files.get(native.name), Uint8Array);
    const nativeLabels = await readNifti(native.bytes, Uint8Array);
    assert.deepEqual(ourLabels.dims, nativeLabels.dims);
    assert.equal(ourLabels.header.datatype, nativeLabels.header.datatype);
    assert.equal(ourLabels.header.sformCode, nativeLabels.header.sformCode);
    assert.equal(ourLabels.header.qformCode, nativeLabels.header.qformCode);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(ourLabels.header.affine[r][c] - nativeLabels.header.affine[r][c]) < 1e-4);
    }
    assert.ok(Buffer.from(ourLabels.data).equals(Buffer.from(nativeLabels.data)), 'label voxels differ from the native NIfTI');
    let probFileMax = 0;
    for (const slugFile of [...files.keys()].filter((n) => n.includes('_bison-prob-'))) {
      const suffix = slugFile.slice(slugFile.indexOf('_bison-prob-'));
      const theirs = (await readNifti((await nativeFile(mode, suffix)).bytes)).data;
      const mine = (await readNifti(files.get(slugFile))).data;
      for (let i = 0; i < mine.length; i++) probFileMax = Math.max(probFileMax, Math.abs(mine[i] - theirs[i]));
    }
    const nativeMask = await readNifti(mask.bytes, Uint8Array);
    const ourMask = await readNifti(files.get(mask.name), Uint8Array);
    assert.ok(Buffer.from(ourMask.data).equals(Buffer.from(nativeMask.data)), 'mask voxels differ from the native NIfTI');
    t.diagnostic(`${mode} label NIfTI voxels identical; probability NIfTI max abs diff ${probFileMax}`);
    assert.ok(probFileMax < 1e-5);
  });
}
