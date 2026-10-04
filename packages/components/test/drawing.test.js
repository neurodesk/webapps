import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  createFloat32Nifti,
  createNiftiFromData,
  createNiftiHeaderFromVolume,
  parseNiftiHeader,
  readNiftiImageData,
} from '../src/file-io/NiftiUtils.js';
import { createDrawingAdapter, distinctLabels, editedFileName, maskToUint8Nifti } from '../src/viewer/drawing.js';

const DIMS = [4, 3, 2];

function sourceHeader() {
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, ...DIMS, 1, 1, 1, 1],
      pixDims: [1, 1.5, 2, 2.5, 1, 1, 1, 1],
      affine: [[-1.5, 0, 0, 30], [0, 2, 0, -40], [0, 0, 2.5, 12], [0, 0, 0, 1]],
    },
  });
}

function float32Mask() {
  const values = new Float32Array(24);
  values.set([0.4, 0.6, 1.2, 2.5, -3, 300, Number.NaN, 1.49]);
  return new Uint8Array(createFloat32Nifti(values, sourceHeader()));
}

function labelBytes(nifti) {
  return readNiftiImageData(nifti, Uint8Array).data;
}

test('maskToUint8Nifti rounds and clamps any datatype onto the same grid', async () => {
  const source = float32Mask();
  const converted = await maskToUint8Nifti(source);
  const header = parseNiftiHeader(converted.buffer);
  assert.equal(header.datatype, 2);
  assert.equal(header.bitpix, 8);
  assert.deepEqual(header.dims.slice(0, 4), [3, ...DIMS]);
  assert.deepEqual(header.pixDims.slice(1, 4), [1.5, 2, 2.5]);
  assert.deepEqual(converted.subarray(252, 328), source.subarray(252, 328), 'qform, sform and affine bytes unchanged');
  assert.deepEqual([...labelBytes(converted).subarray(0, 9)], [0, 1, 1, 3, 0, 255, 0, 1, 0]);
});

test('maskToUint8Nifti applies scaling, reads gzip and drops the scale', async () => {
  const labels = new Int16Array(24);
  labels.set([2, 4, 0, 6]);
  const header = sourceHeader();
  const scaled = new Uint8Array(createNiftiFromData(labels, header, { preserveScaling: true }));
  new DataView(scaled.buffer).setFloat32(112, 0.5, true);
  const file = new File([gzipSync(scaled)], 'labels.nii.gz');
  const converted = await maskToUint8Nifti(file);
  const parsed = parseNiftiHeader(converted.buffer);
  assert.equal(parsed.datatype, 2);
  assert.equal(new DataView(converted.buffer).getFloat32(112, true), 1);
  assert.equal(parsed.sclInter, 0);
  assert.deepEqual([...labelBytes(converted).subarray(0, 4)], [1, 2, 0, 3]);
});

test('distinctLabels lists the sorted non-zero values the editor would paint', async () => {
  assert.deepEqual(await distinctLabels(float32Mask()), [1, 3, 255]);
  const empty = new Uint8Array(createFloat32Nifti(new Float32Array(24), sourceHeader()));
  assert.deepEqual(await distinctLabels(empty), []);
});

test('editedFileName keeps NIfTI names and makes others NIfTI', () => {
  assert.equal(editedFileName('brain_mask.nii.gz'), 'brain_mask.nii.gz');
  assert.equal(editedFileName('aseg.nii'), 'aseg.nii');
  assert.equal(editedFileName('lesions'), 'lesions.nii');
});

function legacyNv() {
  const calls = [];
  const exported = new Uint8Array(352 + 24);
  new DataView(exported.buffer).setFloat32(124, 900, true);
  return {
    calls,
    opts: { drawingEnabled: false, penSize: 1 },
    volumes: [{ opacity: 1 }, { opacity: 0.7 }],
    setDrawingEnabled(on) { calls.push(['setDrawingEnabled', on]); this.opts.drawingEnabled = on; },
    setPenValue(value, filled) { calls.push(['setPenValue', value, filled, this.opts.penSize]); },
    createEmptyDrawing() { calls.push(['createEmptyDrawing']); },
    async loadDrawingFromUrl(url, binarize) {
      const bytes = new Uint8Array(await resolveObjectURL(url).arrayBuffer());
      calls.push(['loadDrawingFromUrl', parseNiftiHeader(bytes.buffer).datatype, binarize]);
      return true;
    },
    drawUndo() { calls.push(['drawUndo']); },
    closeDrawing() { calls.push(['closeDrawing']); },
    setDrawOpacity(value) { calls.push(['setDrawOpacity', value]); },
    setDrawColormap(name) { calls.push(['setDrawColormap', name]); },
    setOpacity(index, value) { calls.push(['setOpacity', index, value]); },
    async saveImage(options) { calls.push(['saveImage', options]); return exported; },
  };
}

function currentNv({ penShape = true } = {}) {
  const nv = {
    loaded: null,
    drawIsEnabled: false,
    drawPenValue: 1,
    drawPenFilled: false,
    drawPenSize: 1,
    volumes: [{ opacity: 1 }, { opacity: 0.6 }],
    calls: [],
    createEmptyDrawing() { this.calls.push(['createEmptyDrawing']); },
    async loadDrawing(file) { this.loaded = file; return true; },
    drawUndo() { this.calls.push(['drawUndo']); },
    closeDrawing() { this.calls.push(['closeDrawing']); this.drawIsEnabled = false; },
    async setVolume(index, options) { this.calls.push(['setVolume', index, options]); },
    async saveDrawing(name) { this.calls.push(['saveDrawing', name]); return new Uint8Array(352 + 24); },
  };
  if (penShape) nv.drawPenShape = 0;
  return nv;
}

test('legacy adapter drives NiiVue 0.x drawing calls', async () => {
  const nv = legacyNv();
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(float32Mask()), true);
  assert.equal(drawing.enabled, true);
  drawing.setTool({ tool: 'draw', label: 3, brushSize: 40 });
  drawing.setTool({ tool: 'erase', label: 3, brushSize: 0 });
  drawing.setTool({ tool: 'fill', label: 2, brushSize: 4.4 });
  drawing.undo();
  drawing.setOpacity(1.5);
  drawing.setColormap('$itksnap');
  await drawing.setVolumeOpacity(1, 0);
  assert.equal(drawing.volumeOpacity(1), 0.7);
  const bytes = await drawing.export();
  assert.equal(new DataView(bytes.buffer).getFloat32(124, true), 0, 'base display range is cleared');
  drawing.close();
  assert.deepEqual(nv.calls, [
    ['loadDrawingFromUrl', 2, false],
    ['setDrawingEnabled', true],
    ['setPenValue', 3, false, 25],
    ['setPenValue', 0, false, 1],
    ['setPenValue', 2, true, 4],
    ['drawUndo'],
    ['setDrawOpacity', 1],
    ['setDrawColormap', '$itksnap'],
    ['setOpacity', 1, 0],
    ['saveImage', { filename: '', isSaveDrawing: true }],
    ['setDrawingEnabled', false],
    ['closeDrawing'],
  ]);
  assert.equal(Object.is(nv.calls[3][1], -0), false, 'erase is 0, not the cluster eraser -0');
});

test('legacy adapter opens an empty drawing and rejects a missing export', async () => {
  const nv = legacyNv();
  nv.saveImage = async () => false;
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(null), true);
  assert.deepEqual(nv.calls, [['createEmptyDrawing'], ['setDrawingEnabled', true]]);
  await assert.rejects(drawing.export(), /no drawing/);
});

test('1.0 adapter sets drawing properties and loads a uint8 File', async () => {
  const nv = currentNv();
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(float32Mask()), true);
  assert.ok(nv.loaded instanceof File);
  assert.equal(parseNiftiHeader(await nv.loaded.arrayBuffer()).datatype, 2);
  assert.equal(drawing.enabled, true);
  drawing.setTool({ tool: 'fill', label: 7, brushSize: 3 });
  assert.deepEqual([nv.drawPenValue, nv.drawPenFilled, nv.drawPenSize, nv.drawPenShape], [7, true, 3, 1]);
  drawing.setTool({ tool: 'erase', label: 7, brushSize: 99 });
  assert.deepEqual([nv.drawPenValue, nv.drawPenFilled, nv.drawPenSize], [0, false, 25]);
  drawing.setOpacity(0.5);
  drawing.setColormap('$slicer3d');
  assert.deepEqual([nv.drawOpacity, nv.drawColormap], [0.5, '$slicer3d']);
  await drawing.setVolumeOpacity(1, 0);
  await drawing.export();
  drawing.close();
  assert.equal(drawing.enabled, false);
  assert.deepEqual(nv.calls, [['setVolume', 1, { opacity: 0 }], ['saveDrawing', ''], ['closeDrawing']]);
});

test('1.0 adapter leaves the pen shape alone before rc.14 and reports a refused load', async () => {
  const nv = currentNv({ penShape: false });
  nv.loadDrawing = async () => false;
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(float32Mask()), false);
  assert.equal(drawing.enabled, false);
  drawing.setTool({ tool: 'draw', label: 1, brushSize: 2 });
  assert.equal('drawPenShape' in nv, false);
  assert.throws(() => drawing.setTool({ tool: 'smudge', label: 1, brushSize: 2 }), /Unknown edit tool/);
});
