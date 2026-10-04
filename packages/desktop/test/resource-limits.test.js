import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseContract, validateRequest } from '../src/contracts.js';
import { createAutomationService } from '../src/automation.js';
import { planSynthsegGeometry } from '../src/resource-limits.js';
import { loadSynthseg } from '../../synthseg/src/wasm.js';
import { planGpuGraph } from '../../runtime-support/src/gpu-unet/session.js';
import graph from '../../synthseg/src/gpu-model.json' with { type: 'json' };

const rawContract = JSON.parse(await readFile(new URL('../../../apps/synthseg/automation.json', import.meta.url)));
const contract = parseContract(rawContract);
const limit = contract.operations.segment.limits.browser.inputs.image;
let wasm;
before(async () => { wasm = await loadSynthseg(await readFile(new URL('../../synthseg/src/synthseg.wasm', import.meta.url))); });

function nifti({ dims = [7, 5, 3], pixdim = [1, 1, 1], affine, qform = null, units = 2, littleEndian = true, data = false } = {}) {
  const bytes = Buffer.alloc(352 + (data ? dims.reduce((a, b) => a * b, 1) : 0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i16 = (offset, value) => view.setInt16(offset, value, littleEndian);
  const f32 = (offset, value) => view.setFloat32(offset, value, littleEndian);
  view.setInt32(0, 348, littleEndian);
  i16(40, 3);
  dims.forEach((value, axis) => i16(42 + axis * 2, value));
  i16(70, 2);
  i16(72, 8);
  f32(76, qform?.qfac ?? 1);
  pixdim.forEach((value, axis) => f32(80 + axis * 4, value));
  f32(108, 352);
  bytes[123] = units;
  if (qform) {
    i16(252, 1);
    qform.rotation.forEach((value, axis) => f32(256 + 4 * axis, value));
  }
  if (affine) {
    i16(254, 2);
    affine.forEach((row, r) => row.forEach((value, c) => f32(280 + 16 * r + 4 * c, value)));
  }
  bytes.write('n+1\0', 344, 'ascii');
  for (let i = 352; i < bytes.length; i++) bytes[i] = i % 193;
  return bytes;
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'synthseg-preflight-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('declared limits match the actual GPU graph and retain its validated cap', () => {
  assert.equal(limit.maxBufferBytes, 2 ** 31 - 1);
  assert.equal(limit.maxPaddedVoxels, Math.floor(limit.maxBufferBytes / limit.bytesPerPaddedVoxel));
  for (const dims of [[128, 128, 128], [192, 224, 160], [192, 256, 256], [160, 128, 288], [512, 32, 64]]) {
    const plan = planGpuGraph(dims, graph, { outputChannels: 33, label: 'SynthSeg' });
    const expected = Math.max(...plan.slots.map(slot => slot.bytes));
    assert.equal(dims.reduce((a, b) => a * b, 1) * limit.bytesPerPaddedVoxel, expected, dims.join('×'));
  }
});

test('header planning matches real Rust WASM preprocessing across spacing and orientation policies', () => {
  const permutations = [
    [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0]],
    [[0, 0, -1, 0], [1, 0, 0, 0], [0, 1, 0, 0]],
  ];
  const cases = [
    { dims: [129, 3, 4] },
    ...permutations.map(affine => ({ dims: [129, 3, 4], affine })),
    { dims: [129, 3, 4], littleEndian: false },
    { dims: [129, 3, 4], pixdim: [2, 0.9, 1.2], littleEndian: false },
    { dims: [129, 3, 4], pixdim: [0.95, 1, 1] },
    { dims: [129, 3, 4], pixdim: [1.05, 1, 1] },
    { dims: [129, 3, 4], pixdim: [1.051, 1, 1] },
    { dims: [129, 3, 4], pixdim: [1, 1, 1], affine: [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0]] },
    { dims: [129, 3, 4], pixdim: [2, 2, 2], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
    { dims: [129, 3, 4], qform: { rotation: [0, 0, Math.SQRT1_2], qfac: -1 } },
    { dims: [129, 3, 4], pixdim: [0.9, 1.2, 2], qform: { rotation: [0.2, 0.3, 0.4], qfac: -1 }, littleEndian: false },
    { dims: [9, 5, 3], pixdim: [2, 2, 2], affine: [[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 10, 0]] },
    { dims: [129, 3, 4], affine: permutations[0], qform: { rotation: [0.2, 0.3, 0.4] } },
    ...[0, 1, 2, 3].map(units => ({ dims: [129, 3, 4], pixdim: [1.2, 0.8, 2], units })),
  ];
  for (const options of cases) {
    const bytes = nifti({ ...options, data: true });
    const predicted = planSynthsegGeometry(bytes.subarray(0, 352));
    const actual = new wasm.Segmenter(bytes);
    try {
      assert.deepEqual(predicted.inputShape, actual.geometry.inputShape, JSON.stringify(options));
      assert.deepEqual(predicted.resampledShape, actual.geometry.outputShape, JSON.stringify(options));
      assert.deepEqual(predicted.paddedShape, actual.padded, JSON.stringify(options));
    } finally { actual.free(); }
  }
});

test('the committed scientific fixture agrees with the real WASM geometry', async () => {
  const bytes = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
  const predicted = planSynthsegGeometry(gunzipSync(bytes).subarray(0, 352));
  const actual = new wasm.Segmenter(bytes);
  try {
    assert.deepEqual(predicted.resampledShape, actual.geometry.outputShape);
    assert.deepEqual(predicted.paddedShape, actual.padded);
  } finally { actual.free(); }
});

test('apps_validate and runs_start reject oversize NIfTI before execution, including 2 mm sources', async t => {
  const outputRoot = await directory(t);
  let executions = 0;
  const service = createAutomationService({ contracts: [{ contract, sha256: 'a'.repeat(64) }], outputRoot,
    nativeBinary: '/installed/synthseg', execute: async () => { executions++; throw new Error('must not execute'); } });
  for (const [name, bytes] of [
    ['head.nii', nifti({ dims: [192, 256, 256] })],
    ['head-2mm.nii.gz', gzipSync(nifti({ dims: [96, 128, 128], pixdim: [2, 2, 2] }))],
  ]) {
    const path = join(outputRoot, name);
    await writeFile(path, bytes);
    const request = { inputs: { image: [path] } };
    const check = error => {
      assert.equal(error.code, 'INPUT_RESOURCE_LIMIT');
      assert.deepEqual(error.details.paddedShape, [192, 256, 256]);
      assert.equal(error.details.requiredBufferBytes, 192 * 256 * 256 * 288);
      assert.match(error.message, /engine "native"/);
      return true;
    };
    await assert.rejects(service.validate('synthseg', request), check);
    await assert.rejects(service.start('synthseg', request), check);
    assert.equal((await service.validate('synthseg', { ...request, engine: 'native', parameters: { ct: false } })).engine, 'native');
  }
  assert.equal(executions, 0);
});

test('supported inputs pass, compressed reads are bounded, and DICOM remains explicitly deferred', async t => {
  const root = await directory(t);
  const supported = join(root, 'supported.nii.gz');
  await writeFile(supported, gzipSync(nifti({ dims: [192, 224, 160] })));
  assert.equal((await validateRequest(contract, { inputs: { image: [supported] } })).engine, 'browser');
  const dicom = join(root, 'slice.dcm');
  await writeFile(dicom, 'DICOM is resolved by conversion');
  await validateRequest(contract, { inputs: { image: [dicom] } });
  assert.deepEqual(limit.deferredFormats, ['dicom']);
  const gzip = gzipSync(nifti());
  gzip[3] = 8;
  const tooLong = join(root, 'long-name.nii.gz');
  await writeFile(tooLong, Buffer.concat([gzip.subarray(0, 10), Buffer.alloc(1024 * 1024, 65), Buffer.from([0]), gzip.subarray(10)]));
  await assert.rejects(validateRequest(contract, { inputs: { image: [tooLong] } }), /within 1 MiB/);
  const truncated = join(root, 'truncated.nii');
  await writeFile(truncated, nifti().subarray(0, 120));
  await assert.rejects(validateRequest(contract, { inputs: { image: [truncated] } }), /NIfTI/);
});

test('contracts reject altered policy constants and limits on undeclared inputs', () => {
  for (const [field, value] of [['maxBufferBytes', 2 ** 32], ['maxPaddedVoxels', 10000000], ['bytesPerPaddedVoxel', 4], ['paddingMultiple', 16]]) {
    const invalid = structuredClone(rawContract);
    invalid.operations.segment.limits.browser.inputs.image[field] = value;
    assert.throws(() => parseContract(invalid), field);
  }
  const invalid = structuredClone(rawContract);
  invalid.operations.segment.limits.browser.inputs.unknown = limit;
  assert.throws(() => parseContract(invalid), /declared browser NIfTI/);
});
