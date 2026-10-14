import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createNiftiFromData, createNiftiHeaderFromVolume, parseNiftiHeader, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { InputMemoryError, MAX_BUFFER_BYTES, planInputMemory, prepareBrowserInput } from '../src/input-memory.js';
import { loadSynthseg } from '../src/wasm.js';

function image(dims, voxelSizeMm = 1, affine) {
  const header = createNiftiHeaderFromVolume({ dims, hdr: { pixDims: [voxelSizeMm, voxelSizeMm, voxelSizeMm],
    affine: affine ?? [[voxelSizeMm, 0, 0, 10], [0, voxelSizeMm, 0, 20], [0, 0, voxelSizeMm, 30], [0, 0, 0, 1]] } });
  return createNiftiFromData(new Uint8Array(dims.reduce((n, d) => n * d, 1)), header);
}

test('coarser preprocessing reduces padded buffers and preserves world coordinates', async () => {
  const wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
  const bytes = image([193, 129, 65]);
  const one = new wasm.Segmenter(new Uint8Array(bytes));
  const two = new wasm.Segmenter(new Uint8Array(bytes), { voxelSizeMm: 2 });
  try {
    assert.deepEqual(one.padded, [224, 160, 128]);
    assert.deepEqual(two.padded, [128, 128, 128]);
    assert.deepEqual(two.geometry.outputShape, [97, 65, 33]);
    assert.deepEqual(two.geometry.outputAffine, [[2, 0, 0, 10.5], [0, 2, 0, 20.5], [0, 0, 2, 30.5]]);
    assert.equal(planInputMemory(parseNiftiHeader(bytes), 2).requiredBufferBytes, 603979776);
    for (const voxelSizeMm of [1, 1.1, 1.5, 2, 3]) {
      const actual = new wasm.Segmenter(new Uint8Array(bytes), { voxelSizeMm });
      try {
        const predicted = planInputMemory(parseNiftiHeader(bytes), voxelSizeMm);
        assert.deepEqual(predicted.outputShape, actual.geometry.outputShape);
        assert.equal(predicted.requiredBufferBytes, actual.voxels * 288);
      } finally {
        actual.free();
      }
    }
  } finally {
    one.free();
    two.free();
  }
});

test('memory planning includes physical spacing, padding and permuted axes', async () => {
  const bytes = image([96, 128, 128], 2, [[0, -2, 0, 10], [2, 0, 0, 20], [0, 0, -2, 30], [0, 0, 0, 1]]);
  const plan = planInputMemory(parseNiftiHeader(bytes));
  assert.deepEqual(plan.outputShape, [192, 256, 256]);
  assert.equal(plan.requiredBufferBytes, 3623878656);
  const wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
  const actual = new wasm.Segmenter(new Uint8Array(bytes), { voxelSizeMm: 1.5 });
  try {
    assert.deepEqual(actual.padded, [192, 128, 192]);
    assert.equal(planInputMemory(parseNiftiHeader(bytes), 1.5).requiredBufferBytes, actual.voxels * 288);
  } finally {
    actual.free();
  }
});

test('coarse label downloads and soft volumes use the physical voxel size', async () => {
  const wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
  const seg = new wasm.Segmenter(new Uint8Array(image([4, 4, 4])), { voxelSizeMm: 2 });
  try {
    // The classifier supplies white matter everywhere; blur preserves a constant posterior.
    const posteriors = new Float32Array(33 * seg.voxels);
    posteriors.fill(1, seg.voxels, 2 * seg.voxels);
    seg.posteriors(posteriors);
    const { buffer, volumes } = seg.labels({ fast: true });
    const labels = await readNifti(buffer);
    assert.deepEqual(labels.dims, [2, 2, 2]);
    assert.deepEqual(labels.header.voxelSize, [2, 2, 2]);
    assert.deepEqual(Array.from(labels.data), Array(8).fill(2));
    assert.equal(volumes[0], 64);
    assert.equal(volumes[1], 64);
    assert.ok(volumes.slice(2).every((v) => v === 0));
  } finally {
    seg.free();
  }
});

test('scans that fit retain their original bytes without cropping', async () => {
  const bytes = image([8, 8, 8]);
  const result = await prepareBrowserInput({ file: new File([bytes], 'head.nii'), crop: () => assert.fail('unneeded crop') });
  assert.deepEqual(result.buffer, bytes);
  assert.deepEqual(result.preparation, { robustFov: false, originalShape: [8, 8, 8], voxelSizeMm: 1 });
});

test('neck cropping precedes the memory check and retains original geometry in provenance', async () => {
  const cropped = image([160, 160, 170]);
  let crops = 0;
  const { preparation, buffer } = await prepareBrowserInput({
    file: new File([image([160, 160, 512])], 'neck.nii'),
    crop: async () => { crops++; return cropped; },
  });
  assert.equal(crops, 1);
  assert.deepEqual(buffer, cropped);
  assert.deepEqual(preparation, { robustFov: true, originalShape: [160, 160, 512], croppedShape: [160, 160, 170], voxelSizeMm: 1 });
});

test('a crop that still exceeds memory proposes the smallest fitting tenth of a millimetre', async () => {
  const cropped = image([224, 224, 170]);
  const file = new File([image([224, 224, 320])], 'head.nii');
  let recommendation;
  await assert.rejects(prepareBrowserInput({ file, crop: async () => cropped }), (error) => {
    assert.ok(error instanceof InputMemoryError);
    recommendation = error.recommendation;
    assert.equal(recommendation.voxelSizeMm, 1.2);
    assert.deepEqual(recommendation.paddedShape, [224, 224, 192]);
    assert.equal(recommendation.preparation.robustFov, true);
    assert.match(error.message, /After neck cropping/);
    return true;
  });
  const retry = await prepareBrowserInput({ file, crop: async () => cropped, voxelSizeMm: recommendation.voxelSizeMm });
  assert.equal(retry.preparation.voxelSizeMm, 1.2);
  assert.ok(planInputMemory(parseNiftiHeader(retry.buffer), 1.2).requiredBufferBytes <= MAX_BUFFER_BYTES);
  assert.ok(planInputMemory(parseNiftiHeader(retry.buffer), 1.1).requiredBufferBytes > MAX_BUFFER_BYTES);
  assert.equal(file.size, 352 + 224 * 224 * 320);
});

test('adapter limits, disabled cropping and the minimum tensor all constrain the offer', async () => {
  const file = new File([image([160, 160, 512])], 'neck.nii');
  await assert.rejects(prepareBrowserInput({ file, robustFov: false, crop: () => assert.fail('crop disabled') }), (error) => {
    assert.equal(error.recommendation.preparation.robustFov, false);
    assert.ok(error.recommendation.voxelSizeMm > 1);
    return true;
  });
  await assert.rejects(prepareBrowserInput({ file, maxBufferBytes: 512 * 1024 * 1024, crop: async () => image([160, 160, 170]) }), (error) => {
    assert.equal(error.recommendation.voxelSizeMm, null);
    assert.match(error.message, /standalone SynthSeg/);
    return true;
  });
});

test('crop failures propagate and invalid processing resolutions cannot enter WASM', async () => {
  const file = new File([image([160, 160, 512])], 'neck.nii');
  await assert.rejects(prepareBrowserInput({ file, crop: async () => { throw new Error('crop failed'); } }), /crop failed/);
  const wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
  for (const voxelSizeMm of [0, 0.5, 3.1, NaN, Infinity]) {
    assert.throws(() => new wasm.Segmenter(new Uint8Array(image([2, 2, 2])), { voxelSizeMm }), /between 1 and 3 mm/);
  }
});
