import { createUint8Nifti, decodeNiftiBuffer, extractNiftiHeader, readNiftiImageData } from '../file-io/NiftiUtils.js';

export const EDIT_TOOLS = Object.freeze(['draw', 'erase', 'fill']);
export const BRUSH_SIZE = Object.freeze({ min: 1, max: 25 });

export function clampBrushSize(size) {
  return Math.min(BRUSH_SIZE.max, Math.max(BRUSH_SIZE.min, Math.round(Number(size)) || BRUSH_SIZE.min));
}

/** Any NIfTI mask or label map as the uint8 image both NiiVue generations accept as a drawing. */
export async function maskToUint8Nifti(source) {
  const buffer = await decodeNiftiBuffer(await toBytes(source));
  const { data } = readNiftiImageData(buffer, Float64Array);
  const labels = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) labels[i] = Math.min(255, Math.max(0, Math.round(data[i]))) || 0;
  return new Uint8Array(createUint8Nifti(labels, extractNiftiHeader(buffer)));
}

/** Sorted non-zero values of the mask once converted to uint8, as the editor paints them. */
export async function distinctLabels(source) {
  const bytes = await maskToUint8Nifti(source);
  const present = new Uint8Array(256);
  for (let i = voxOffset(bytes); i < bytes.length; i++) present[bytes[i]] = 1;
  const labels = [];
  for (let value = 1; value < 256; value++) if (present[value]) labels.push(value);
  return labels;
}

/** The edited result keeps its name; a name that is not NIfTI gains `.nii`. */
export function editedFileName(name) {
  return /\.nii(\.gz)?$/i.test(name) ? name : `${name}.nii`;
}

/**
 * One drawing interface over NiiVue 0.x (`setDrawingEnabled`, `setPenValue`,
 * `saveImage`) and 1.0 (`drawIsEnabled`, `drawPenValue`, `saveDrawing`).
 */
export function createDrawingAdapter(nv) {
  const api = typeof nv.setDrawingEnabled === 'function' ? legacyApi(nv) : currentApi(nv);
  return {
    get enabled() { return api.enabled(); },
    async open(source = null) {
      if (source === null) {
        api.createEmpty();
      } else {
        const nifti = await maskToUint8Nifti(source);
        if (!sameGrid(nifti, nv.volumes?.[0]?.hdr?.dims) || !await api.load(nifti)) return false;
        await placeVerified(api, nifti);
      }
      api.enable(true);
      return true;
    },
    close() {
      api.enable(false);
      api.close();
    },
    setTool({ tool, label, brushSize }) {
      if (!EDIT_TOOLS.includes(tool)) throw new Error(`Unknown edit tool: ${tool}`);
      api.pen(tool === 'erase' ? 0 : label, tool === 'fill', clampBrushSize(brushSize));
    },
    undo() { nv.drawUndo(); },
    setOpacity(opacity) { api.drawOpacity(Math.min(1, Math.max(0, opacity))); },
    setColormap(name) { api.drawColormap(name); },
    volumeOpacity(index) { return nv.volumes?.[index]?.opacity ?? 1; },
    async setVolumeOpacity(index, opacity) { await api.volumeOpacity(index, opacity); },
    async export() {
      const bytes = await savedNifti(api);
      // 0.x copies the base image's display range; an unset range lets every viewer scale the labels.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setFloat32(124, 0, true);
      view.setFloat32(128, 0, true);
      return bytes;
    },
  };
}

// NiiVue 1.0 (rc.11 to rc.14) loads a drawing with the background's RAS extents in
// place of its native ones, so on a background whose axes are permuted and unequal
// (a sagittal acquisition) the drawing lands on the wrong voxels; its save is right.
// Measure what the load and save round trip does to each voxel and load the layout
// that undoes it, so a NiiVue that loads correctly takes the first branch.
async function placeVerified(api, nifti) {
  const offset = voxOffset(nifti);
  const labels = nifti.subarray(offset);
  if (equalBytes(await savedVoxels(api), labels)) return;
  const source = await measureRoundTrip(api, nifti, offset);
  const compensated = nifti.slice();
  for (let i = 0; i < labels.length; i++) compensated[offset + source[i]] = labels[i];
  if (await api.load(compensated) && equalBytes(await savedVoxels(api), labels)) return;
  api.enable(false);
  api.close();
  throw new Error('NiiVue placed the mask on the wrong voxels of the viewed image');
}

// source[i] is the voxel whose loaded value comes back at voxel i, read one byte of the index at a time.
async function measureRoundTrip(api, nifti, offset) {
  const count = nifti.length - offset;
  const source = new Uint32Array(count);
  for (let shift = 0; 2 ** shift < count; shift += 8) {
    const probe = nifti.slice();
    for (let i = 0; i < count; i++) probe[offset + i] = (i >>> shift) & 255;
    if (!await api.load(probe)) throw new Error('NiiVue refused the drawing it had just loaded');
    const saved = await savedVoxels(api);
    for (let i = 0; i < count; i++) source[i] |= saved[i] << shift;
  }
  return source;
}

async function savedNifti(api) {
  const bytes = await api.save();
  if (!(bytes instanceof Uint8Array)) throw new Error('NiiVue returned no drawing to export');
  return bytes;
}

async function savedVoxels(api) {
  const bytes = await savedNifti(api);
  return bytes.subarray(voxOffset(bytes));
}

function voxOffset(nifti) {
  return Math.ceil(new DataView(nifti.buffer, nifti.byteOffset, nifti.byteLength).getFloat32(108, true));
}

function sameGrid(nifti, baseDims) {
  if (!baseDims) return true;
  const view = new DataView(nifti.buffer, nifti.byteOffset, nifti.byteLength);
  return [1, 2, 3].every(axis => view.getInt16(40 + axis * 2, true) === baseDims[axis]);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function legacyApi(nv) {
  return {
    enabled: () => Boolean(nv.opts?.drawingEnabled),
    enable: (on) => nv.setDrawingEnabled(on),
    createEmpty: () => nv.createEmptyDrawing(),
    close: () => nv.closeDrawing(),
    async load(bytes) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      try {
        return await nv.loadDrawingFromUrl(url, false);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    pen(value, filled, size) {
      nv.opts.penSize = size;
      nv.setPenValue(value, filled);
    },
    drawOpacity: (opacity) => nv.setDrawOpacity(opacity),
    drawColormap: (name) => nv.setDrawColormap(name),
    volumeOpacity: (index, opacity) => nv.setOpacity(index, opacity),
    // toUint8Array reorients the RAS bitmap back to the base image's native order.
    save: () => nv.saveImage({ filename: '', isSaveDrawing: true }),
  };
}

const PEN_SHAPE_CIRCLE = 1;
const DRAWING_COLORMAP = 'nd-mask-editor';

function currentApi(nv) {
  return {
    enabled: () => Boolean(nv.drawIsEnabled),
    enable(on) { nv.drawIsEnabled = on; },
    createEmpty: () => nv.createEmptyDrawing(),
    close: () => nv.closeDrawing(),
    load: (bytes) => nv.loadDrawing(new File([bytes], 'drawing.nii', { type: 'application/octet-stream' })),
    pen(value, filled, size) {
      nv.drawPenValue = value;
      nv.drawPenFilled = filled;
      nv.drawPenSize = size;
      if ('drawPenShape' in nv) nv.drawPenShape = PEN_SHAPE_CIRCLE;
    },
    drawOpacity(opacity) { nv.drawOpacity = opacity; },
    drawColormap(colormap) {
      if (typeof colormap === 'string') {
        nv.drawColormap = colormap;
        return;
      }
      nv.addColormap(DRAWING_COLORMAP, colormap);
      nv.drawColormap = DRAWING_COLORMAP;
    },
    volumeOpacity: (index, opacity) => nv.setVolume(index, { opacity }),
    save: () => nv.saveDrawing(''),
  };
}

async function toBytes(source) {
  if (typeof source?.arrayBuffer === 'function') return source.arrayBuffer();
  return source;
}
