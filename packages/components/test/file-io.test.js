import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FileIOController,
  categorizeNeuroFile,
  createFloat64Nifti,
  createNiftiFromData,
  createNiftiHeaderFromVolume,
  createNiftiFromVolume,
  isNiftiFile,
  parseNiftiHeader,
  readNiftiFrames,
  readNiftiImageData
} from '../src/file-io/index.js';

function fakeFile(name) {
  return { name };
}

test('detects NIfTI files', () => {
  assert.equal(isNiftiFile('image.nii'), true);
  assert.equal(isNiftiFile('image.nii.gz'), true);
  assert.equal(isNiftiFile('image.json'), false);
});

test('categorizes QSM bucket files', () => {
  assert.equal(categorizeNeuroFile(fakeFile('sub_mag_e1.nii.gz')), 'magnitude');
  assert.equal(categorizeNeuroFile(fakeFile('sub_phase_e1.nii.gz')), 'phase');
  assert.equal(categorizeNeuroFile(fakeFile('sub_total_fieldmap.nii.gz')), 'totalField');
  assert.equal(categorizeNeuroFile(fakeFile('sub_local_chi.nii.gz')), 'localField');
  assert.equal(categorizeNeuroFile(fakeFile('sub.json')), 'json');
});

test('bucketed FileIOController enforces exclusive field inputs', () => {
  const io = new FileIOController({ mode: 'bucketed' });
  io.addFiles([fakeFile('a_phase.nii.gz'), fakeFile('b_phase.nii.gz')]);
  assert.equal(io.getBucket('phase').length, 2);
  io.addFiles([fakeFile('fieldmap_total.nii.gz')]);
  assert.equal(io.getBucket('phase').length, 0);
  assert.equal(io.getBucket('totalField').length, 1);
  assert.equal(io.getBucket('extra').length, 2);
  assert.equal(io.getInputMode(), 'totalField');
});

test('creates NIfTI output from NiiVue-style volume metadata', () => {
  const header = createNiftiHeaderFromVolume({
    dims: [2, 2, 1],
    pixDims: [0.7, 0.8, 1.5],
    img: new Float32Array([1, 2, 3, 4])
  });
  const output = createFloat64Nifti(new Float64Array([1.25, 2.5, 3.75, 5]), header);
  const parsed = parseNiftiHeader(output);
  assert.deepEqual([parsed.nx, parsed.ny, parsed.nz], [2, 2, 1]);
  assert.deepEqual(parsed.voxelSize.map(value => Number(value.toFixed(2))), [0.7, 0.8, 1.5]);
  const { data } = readNiftiImageData(output, Float64Array);
  assert.deepEqual(Array.from(data), [1.25, 2.5, 3.75, 5]);
});

test('preserves a NiiVue volume scalar datatype when creating NIfTI output', () => {
  const cases = [
    [Int8Array, 256, 8],
    [Uint8Array, 2, 8],
    [Int16Array, 4, 16],
    [Uint16Array, 512, 16],
    [Int32Array, 8, 32],
    [Uint32Array, 768, 32],
    [Float32Array, 16, 32],
    [Float64Array, 64, 64],
  ];

  for (const [TypedArray, datatype, bitpix] of cases) {
    const values = new TypedArray([1, 2, 3, 4]);
    const output = createNiftiFromVolume({ dims: [2, 2, 1], img: values });
    const parsed = parseNiftiHeader(output);
    assert.equal(parsed.datatype, datatype, TypedArray.name);
    assert.equal(parsed.bitpix, bitpix, TypedArray.name);
    assert.deepEqual(Array.from(readNiftiImageData(output, Float64Array).data), [1, 2, 3, 4], TypedArray.name);
  }
});

test('preserves NIfTI intensity scaling when exporting an existing volume', () => {
  const output = createNiftiFromVolume({
    hdr: {
      dims: [3, 1, 1, 1, 1, 1, 1, 1],
      scl_slope: 2,
      scl_inter: 10,
    },
    img: new Uint8Array([3]),
  });

  const parsed = parseNiftiHeader(output);
  assert.equal(parsed.sclSlope, 2);
  assert.equal(parsed.sclInter, 10);
  assert.deepEqual(Array.from(readNiftiImageData(output, Float64Array).data), [16]);
});

test('reads every frame of a 4D NIfTI with its scaling', () => {
  const header = createNiftiHeaderFromVolume({
    hdr: { dims: [4, 2, 1, 1, 3, 1, 1, 1], scl_slope: 2, scl_inter: 1 },
  });
  const view = new DataView(header);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  const output = new Uint8Array(header.byteLength + 12);
  output.set(new Uint8Array(header));
  output.set(new Uint8Array(new Int16Array([0, 1, 2, 3, 4, 5]).buffer), header.byteLength);
  const { data, dims, frames } = readNiftiFrames(output, Float64Array);
  assert.deepEqual(dims, [2, 1, 1]);
  assert.equal(frames, 3);
  assert.deepEqual(Array.from(data), [1, 3, 5, 7, 9, 11]);
  assert.deepEqual(Array.from(readNiftiImageData(output, Float64Array).data), [1, 3]);
});

test('resets source scaling when writing newly derived voxel data', () => {
  const sourceHeader = createNiftiHeaderFromVolume({
    hdr: { dims: [3, 1, 1, 1], scl_slope: 2, scl_inter: 10 },
  });
  const output = createNiftiFromData(new Uint8Array([3]), sourceHeader);
  const parsed = parseNiftiHeader(output);

  assert.equal(parsed.sclSlope, 1);
  assert.equal(parsed.sclInter, 0);
  assert.deepEqual(Array.from(readNiftiImageData(output, Float64Array).data), [3]);
});

test('single-image conversion rejects ambiguous series and frees its worker', async () => {
  const { DicomController, readSingleImage } = await import('../src/file-io/index.js');
  await assert.rejects(readSingleImage([fakeFile('one.nii'), fakeFile('two.nii')]), /one NIfTI/);
  let terminated = false;
  const controller = new DicomController({ requireSingle: true });
  controller._createInstance = async () => ({
    input() { return this; },
    async run() { return [fakeFile('series1.nii'), fakeFile('series2.nii')]; },
    worker: { terminate() { terminated = true; } }
  });
  await assert.rejects(controller.convertFiles([fakeFile('slice.IMA')]), /one series at a time/);
  assert.equal(terminated, true);
  assert.equal(controller.converting, false);
});
