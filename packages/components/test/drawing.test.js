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

// A stand-in for NiiVue's drawing layer: a save returns what was loaded, read
// through `scramble` (voxel i comes from voxel scramble(i)) to mimic a bad load.
function drawingLayer(scramble = (i) => i) {
  return {
    loads: 0,
    stored: null,
    put(bytes) {
      this.loads++;
      const offset = parseNiftiHeader(bytes.buffer).voxOffset;
      this.stored = bytes.slice();
      for (let i = 0; i < bytes.length - offset; i++) this.stored[offset + i] = bytes[offset + scramble(i)];
    },
  };
}

function legacyNv(layer = drawingLayer()) {
  const calls = [];
  return {
    calls,
    layer,
    opts: { drawingEnabled: false, penSize: 1 },
    volumes: [{ opacity: 1, hdr: parseNiftiHeader(sourceHeader()) }, { opacity: 0.7 }],
    setDrawingEnabled(on) { calls.push(['setDrawingEnabled', on]); this.opts.drawingEnabled = on; },
    setPenValue(value, filled) { calls.push(['setPenValue', value, filled, this.opts.penSize]); },
    createEmptyDrawing() { calls.push(['createEmptyDrawing']); },
    async loadDrawingFromUrl(url, binarize) {
      const bytes = new Uint8Array(await resolveObjectURL(url).arrayBuffer());
      calls.push(['loadDrawingFromUrl', parseNiftiHeader(bytes.buffer).datatype, binarize]);
      layer.put(bytes);
      return true;
    },
    drawUndo() { calls.push(['drawUndo']); },
    closeDrawing() { calls.push(['closeDrawing']); },
    setDrawOpacity(value) { calls.push(['setDrawOpacity', value]); },
    setDrawColormap(name) { calls.push(['setDrawColormap', name]); },
    setOpacity(index, value) { calls.push(['setOpacity', index, value]); },
    async saveImage(options) {
      calls.push(['saveImage', options]);
      const bytes = layer.stored.slice();
      new DataView(bytes.buffer).setFloat32(124, 900, true);
      return bytes;
    },
  };
}

function currentNv({ penShape = true, layer = drawingLayer() } = {}) {
  const nv = {
    layer,
    loaded: null,
    drawIsEnabled: false,
    drawPenValue: 1,
    drawPenFilled: false,
    drawPenSize: 1,
    volumes: [{ opacity: 1, hdr: parseNiftiHeader(sourceHeader()) }, { opacity: 0.6 }],
    calls: [],
    accept: true,
    createEmptyDrawing() { this.calls.push(['createEmptyDrawing']); },
    async loadDrawing(file) {
      if (!this.accept) return false;
      this.loaded = file;
      layer.put(new Uint8Array(await file.arrayBuffer()));
      this.drawIsEnabled = true;
      return true;
    },
    drawUndo() { this.calls.push(['drawUndo']); },
    closeDrawing() { this.calls.push(['closeDrawing']); this.drawIsEnabled = false; },
    async setVolume(index, options) { this.calls.push(['setVolume', index, options]); },
    async saveDrawing(name) { this.calls.push(['saveDrawing', name]); return layer.stored.slice(); },
  };
  if (penShape) nv.drawPenShape = 0;
  return nv;
}

async function expectedLabels() {
  return labelBytes(await maskToUint8Nifti(float32Mask()));
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
  assert.deepEqual(labelBytes(bytes), await expectedLabels());
  drawing.close();
  const save = ['saveImage', { filename: '', isSaveDrawing: true }];
  assert.deepEqual(nv.calls, [
    ['loadDrawingFromUrl', 2, false],
    save,
    ['setDrawingEnabled', true],
    ['setPenValue', 3, false, 25],
    ['setPenValue', 0, false, 1],
    ['setPenValue', 2, true, 4],
    ['drawUndo'],
    ['setDrawOpacity', 1],
    ['setDrawColormap', '$itksnap'],
    ['setOpacity', 1, 0],
    save,
    ['setDrawingEnabled', false],
    ['closeDrawing'],
  ]);
  assert.equal(Object.is(nv.calls[4][1], -0), false, 'erase is 0, not the cluster eraser -0');
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
  const custom = { R: [0, 255], G: [0, 0], B: [0, 0], A: [0, 255], I: [0, 1] };
  nv.addColormap = (name, map) => { nv.colormaps = { ...nv.colormaps, [name]: map }; };
  drawing.setColormap(custom);
  assert.equal(nv.colormaps[nv.drawColormap], custom);
  await drawing.setVolumeOpacity(1, 0);
  assert.deepEqual(labelBytes(await drawing.export()), await expectedLabels());
  drawing.close();
  assert.equal(drawing.enabled, false);
  assert.deepEqual(nv.calls, [['saveDrawing', ''], ['setVolume', 1, { opacity: 0 }], ['saveDrawing', ''], ['closeDrawing']]);
  assert.equal(nv.layer.loads, 1, 'a load that round-trips is not measured');
});

test('a load that misplaces voxels is measured and undone', async () => {
  // 1.0 rc.11 to rc.14 reorder a drawing on a permuted background; any bijection stands in for it.
  const layer = drawingLayer((i) => (i * 5) % 24);
  const nv = currentNv({ layer });
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(float32Mask()), true);
  assert.deepEqual(labelBytes(await drawing.export()), await expectedLabels());
  assert.equal(layer.loads, 3, 'the first load, one probe for 24 voxels, and the compensated load');
});

test('a load that cannot be undone closes the drawing and says why', async () => {
  const nv = currentNv({ layer: drawingLayer(() => 0) });
  const drawing = createDrawingAdapter(nv);
  await assert.rejects(drawing.open(float32Mask()), /wrong voxels/);
  assert.equal(drawing.enabled, false);
  assert.deepEqual(nv.calls.at(-1), ['closeDrawing']);
});

test('a mask on another grid or one NiiVue refuses is not opened', async () => {
  const nv = currentNv({ penShape: false });
  nv.volumes[0].hdr.dims = [3, 3, 4, 2, 1];
  const drawing = createDrawingAdapter(nv);
  assert.equal(await drawing.open(float32Mask()), false);
  assert.equal(nv.layer.loads, 0);
  nv.volumes[0].hdr.dims = [3, ...DIMS, 1];
  nv.accept = false;
  assert.equal(await drawing.open(float32Mask()), false);
  assert.equal(drawing.enabled, false);
});

test('1.0 adapter leaves the pen shape alone before rc.14 and rejects unknown tools', () => {
  const nv = currentNv({ penShape: false });
  const drawing = createDrawingAdapter(nv);
  drawing.setTool({ tool: 'draw', label: 1, brushSize: 2 });
  assert.equal('drawPenShape' in nv, false);
  assert.throws(() => drawing.setTool({ tool: 'smudge', label: 1, brushSize: 2 }), /Unknown edit tool/);
});

for (const makeNv of [legacyNv, currentNv]) {
  for (const [name, change] of [
    ['translation', hdr => { hdr.affine[0][3] += 20; }],
    ['spacing', hdr => { hdr.affine[1][1] *= 2; }],
    ['rotation', hdr => { hdr.affine[0][1] = 2; }],
    ['nonfinite affine', hdr => { hdr.affine[0][3] = NaN; }],
    ['unknown affine', hdr => { delete hdr.affine; }],
  ]) {
    test(`${makeNv.name} refuses ${name} before loading a drawing`, async () => {
      const nv = makeNv();
      change(nv.volumes[0].hdr);
      assert.equal(await createDrawingAdapter(nv).open(float32Mask()), false);
      assert.equal(nv.layer.loads, 0);
    });
  }

  test(`${makeNv.name} preserves the mask header and extensions when NiiVue saves the base header`, async () => {
    const maskHeader = new Uint8Array(384);
    maskHeader.set(new Uint8Array(sourceHeader()));
    const view = new DataView(maskHeader.buffer);
    view.setFloat32(108, 384, true);
    maskHeader.set(new TextEncoder().encode('mask provenance'), 148);
    maskHeader[348] = 1;
    view.setInt32(352, 32, true);
    view.setInt32(356, 6, true);
    maskHeader.set(new TextEncoder().encode('mask extension'), 360);
    const source = createNiftiFromData(new Uint8Array(24).fill(3), maskHeader);
    const nv = makeNv();
    const save = async () => new Uint8Array(createNiftiFromData(labelBytes(nv.layer.stored), sourceHeader()));
    if (nv.saveImage) nv.saveImage = save;
    else nv.saveDrawing = save;
    const drawing = createDrawingAdapter(nv);
    assert.equal(await drawing.open(source), true);
    const result = await drawing.export();
    assert.deepEqual(result.subarray(148, 384), new Uint8Array(source).subarray(148, 384));
    assert.deepEqual([...labelBytes(result)], new Array(24).fill(3));
  });

  test(`${makeNv.name} rejects a saved drawing with the wrong voxel count`, async () => {
    const nv = makeNv();
    const drawing = createDrawingAdapter(nv);
    assert.equal(await drawing.open(float32Mask()), true);
    const save = async () => nv.layer.stored.slice(0, -1);
    if (nv.saveImage) nv.saveImage = save;
    else nv.saveDrawing = save;
    await assert.rejects(drawing.export(), /voxel count/);
  });
}

for (const makeNv of [legacyNv, currentNv]) {
  test(`${makeNv.name} accepts qform-only geometry and retains its original transform`, async () => {
    const header = sourceHeader();
    const view = new DataView(header);
    view.setInt16(254, 0, true);
    view.setFloat32(76, -1, true);
    view.setFloat32(264, Math.SQRT1_2, true);
    view.setFloat32(268, 42, true);
    view.setFloat32(272, -30, true);
    view.setFloat32(276, 7, true);
    const source = createNiftiFromData(new Uint8Array(24).fill(2), header);
    const nv = makeNv();
    nv.volumes[0].hdr = parseNiftiHeader(header);
    nv.volumes[0].hdr.affine[0][3] += 1e-6;
    const drawing = createDrawingAdapter(nv);
    assert.equal(await drawing.open(source), true);
    const saved = await drawing.export();
    assert.deepEqual(saved.subarray(252, 328), new Uint8Array(source).subarray(252, 328));
    drawing.close();
    nv.volumes[0].hdr.affine[0][3] += 1;
    const loads = nv.layer.loads;
    assert.equal(await drawing.open(source), false);
    assert.equal(nv.layer.loads, loads);
  });
}
