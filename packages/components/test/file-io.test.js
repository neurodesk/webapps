import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FileIOController,
  categorizeNeuroFile,
  classifyImageComponent,
  createFloat64Nifti,
  createNiftiFromData,
  createNiftiHeaderFromVolume,
  createNiftiFromVolume,
  isNiftiFile,
  parseNiftiHeader,
  readNiftiFrames,
  readNiftiImageData,
  sameNiftiGrid
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

test('classifies image components from sidecars before names', () => {
  const bruker = (phase) => ({ Manufacturer: 'Bruker', ImageType: ['ORIGINAL', 'PRIMARY', 'MULTIECHO', 'NONE', ...(phase ? ['PHASE'] : [])] });
  assert.equal(classifyImageComponent('_MGE_phaseimage_lowres_90001_e1.nii', bruker(false)), 'magnitude');
  assert.equal(classifyImageComponent('_MGE_phaseimage_lowres_90002_e1_ph.nii', bruker(true)), 'phase');
  assert.equal(classifyImageComponent('phase.nii.gz', { ImageType: ['ORIGINAL', 'PRIMARY', 'M'] }), 'magnitude');
  assert.equal(classifyImageComponent('localizer.nii', { ImageType: ['ORIGINAL', 'PRIMARY', 'LOCALIZER'] }), 'extra');
  assert.equal(classifyImageComponent('scan.nii', { ComplexImageComponent: 'REAL' }), 'extra');
  assert.equal(classifyImageComponent('sub-1_echo-01_part-mag_MEGRE.nii', { ImageType: ['ORIGINAL', 'PRIMARY', 'OTHER'] }), 'magnitude');
  assert.equal(classifyImageComponent('sub-1_echo-01_part-phase_MEGRE.nii', { ImageType: ['ORIGINAL', 'PRIMARY', 'OTHER'] }), 'phase');
  assert.equal(classifyImageComponent('sub-1_part-imag_MEGRE.nii'), 'extra');
  assert.equal(classifyImageComponent('scan_e2.nii'), 'magnitude');
  assert.equal(classifyImageComponent('scan_e2_ph.nii'), 'phase');
  assert.equal(classifyImageComponent('scan.nii'), null);
});

test('a phase token is not hidden by an echo suffix or a protocol name', () => {
  assert.equal(categorizeNeuroFile(fakeFile('sub_phase_e1.nii.gz')), 'phase');
  assert.equal(categorizeNeuroFile(fakeFile('_MGE_phaseimage_lowres_90001_e1.nii')), 'magnitude');
  assert.notEqual(categorizeNeuroFile(fakeFile('swi_phaseimage.nii')), 'phase');
});

function gridHeader() {
  const buffer = new ArrayBuffer(352);
  const view = new DataView(buffer);
  [96, 82, 18].forEach((dim, i) => view.setInt16(42 + i * 2, dim, true));
  [1, 0.167, 0.195, 0.8].forEach((value, i) => view.setFloat32(76 + i * 4, value, true));
  view.setInt16(254, 1, true);
  view.setUint8(123, 2);
  [0.167, 0, 0, -8, 0, 0.195, 0, -1, 0, 0, 0.8, -8].forEach((value, i) => view.setFloat32(280 + i * 4, value, true));
  return buffer;
}

test('sameNiftiGrid allows float32 rounding but rejects translated and flipped grids', () => {
  const a = gridHeader();
  const b = gridHeader();
  const view = new DataView(b);
  view.setFloat32(292, -8.000002, true);
  assert.equal(sameNiftiGrid(a, b), true);
  view.setFloat32(292, -7, true);
  assert.equal(sameNiftiGrid(a, b), false);
  view.setFloat32(292, -8, true);
  view.setFloat32(280, -0.167, true);
  assert.equal(sameNiftiGrid(a, b), false);
});

test('sameNiftiGrid matches qform-only and sform headers of one grid', () => {
  const a = gridHeader();
  const b = gridHeader();
  const view = new DataView(b);
  view.setInt16(254, 0, true);
  view.setInt16(252, 1, true);
  [-8, -1, -8].forEach((value, i) => view.setFloat32(268 + i * 4, value, true));
  assert.equal(sameNiftiGrid(a, b), true);
  view.setFloat32(76, -1, true);
  assert.equal(sameNiftiGrid(a, b), false);
});

test('sameNiftiGrid honours spatial units and rejects non-finite transforms', () => {
  const a = gridHeader();
  const b = gridHeader();
  const view = new DataView(b);
  view.setUint8(123, 1);
  for (let offset = 280; offset < 328; offset += 4) view.setFloat32(offset, view.getFloat32(offset, true) / 1000, true);
  assert.equal(sameNiftiGrid(a, b), true);
  view.setFloat32(280, NaN, true);
  assert.equal(sameNiftiGrid(a, b), false);
});

test('sameNiftiGrid rejects different dimensions', () => {
  const b = gridHeader();
  new DataView(b).setInt16(46, 19, true);
  assert.equal(sameNiftiGrid(gridHeader(), b), false);
});
