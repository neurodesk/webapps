import { createUint8Nifti, decodeNiftiBuffer, extractNiftiHeader, parseNiftiHeader, readNiftiImageData, sameVoxelGrid } from '../file-io/NiftiUtils.js';
import { orientToRAS, inverseOrient } from '../volume/geometry.js';

export const EDIT_TOOLS = Object.freeze(['draw', 'erase', 'fill']);
export const BRUSH_SIZE = Object.freeze({ min: 1, max: 25 });

/**
 * Give NiiVue's click-to-segment equal absolute tolerance at dark and bright seeds.
 * Keep its native connectivity, physical radius, preview, drawing and Undo logic.
 * The default percent-of-seed interval collapses near zero and inverts below zero.
 * This opt-in adapter sets intensity bounds and optionally blocks growth outside a RAS mask.
 */
export function installContrastRangeWand(nv, { getMask = () => null } = {}) {
  if (typeof nv?.drawFloodFill !== 'function') throw new Error('This viewer does not support contrast-range wand growth.');
  const original = nv.drawFloodFill;
  const ranges = new WeakMap();
  let maskedImage = null;
  function imageRange(volume) {
    if (ranges.has(volume)) return ranges.get(volume);
    let span = 0;
    for (const [low, high] of [[volume.robust_min, volume.robust_max], [volume.global_min, volume.global_max], [volume.cal_min, volume.cal_max]]) {
      if (Number.isFinite(low) && Number.isFinite(high) && high !== low) {
        span = Math.abs(high - low);
        break;
      }
    }
    ranges.set(volume, span);
    return span;
  }
  function fill(...args) {
    const volume = this.back;
    if (this.opts?.clickToSegment && args[1] > 0 && !args[9] && typeof volume?.getValue === 'function') {
      const mask = getMask();
      const image = this.volumes?.[0] || volume;
      const nativeImage = image.img2RAS;
      if (mask) {
        const dims = volume.dimsRAS || volume.dims;
        const [x, y, z] = args[0];
        const count = dims?.[1] * dims?.[2] * dims?.[3];
        const index = x + y * dims?.[1] + z * dims?.[1] * dims?.[2];
        if (mask.length !== count || !mask[index]) {
          // Reject outside seeds and clear a previous hover preview without editing the mask.
          if (args[8] && this.drawBitmap && args[8] !== this.drawBitmap) args[8].set(this.drawBitmap);
          this.refreshDrawing?.(true, this.clickToSegmentIsGrowing);
          return;
        }
        if (typeof nativeImage !== 'function') throw new Error('Brain-limited wand requires a scalar image.');
        if (maskedImage?.image !== image || maskedImage?.mask !== mask) {
          const source = nativeImage.call(image);
          if (source.length !== count) throw new Error('Brain mask and anatomical image voxel counts differ.');
          const Type = source instanceof Float64Array || source instanceof Int32Array || source instanceof Uint32Array ? Float64Array : Float32Array;
          const data = Type.from(source, (value, voxel) => mask[voxel] ? value : NaN);
          maskedImage = { image, mask, data };
        }
      }
      const intensity = volume.getValue(...args[0]);
      if (Number.isFinite(intensity)) {
        const fraction = Math.max(0.01, Math.min(0.5, Number(this.opts.clickToSegmentPercent) || 0.1));
        const margin = imageRange(volume) * fraction;
        // NiiVue samples the seed in calibrated units but flood-fills raw img2RAS values.
        const slope = Number.isFinite(volume.hdr?.scl_slope) && volume.hdr.scl_slope !== 0 ? volume.hdr.scl_slope : 1;
        const intercept = Number.isFinite(volume.hdr?.scl_inter) ? volume.hdr.scl_inter : 0;
        const low = (intensity - margin - intercept) / slope;
        const high = (intensity + margin - intercept) / slope;
        args[3] = Math.min(low, high);
        args[4] = Math.max(low, high);
        this.opts.clickToSegmentIntensityMin = args[3];
        this.opts.clickToSegmentIntensityMax = args[4];
      }
      if (mask) {
        // Outside-brain voxels are barriers before connectivity is evaluated, not clipped afterwards.
        image.img2RAS = () => maskedImage.data;
        try {
          return original.apply(this, args);
        } finally {
          image.img2RAS = nativeImage;
        }
      }
    }
    return original.apply(this, args);
  }
  nv.drawFloodFill = fill;
  return () => {
    if (nv.drawFloodFill === fill) nv.drawFloodFill = original;
  };
}

/** Convert NiiVue's RAS drawing back to the base image's native voxel order. */
export function drawingToNativeBitmap(nv, expectedGrid) {
  const image = nv.volumes?.[0];
  if (!image?.hdr || !nv.drawBitmap) throw new Error('No anatomical image and drawing are available.');
  if (expectedGrid && !sameVoxelGrid(image.hdr, expectedGrid)) {
    throw new Error('The drawing base does not match the intended native mask geometry.');
  }
  const axes = drawingAxes(image);
  const dims = Array.from(image.hdr.dims.slice(1, 4));
  if (nv.drawBitmap.length !== dims[0] * dims[1] * dims[2]) {
    throw new Error('Drawing and anatomical image voxel counts differ.');
  }
  const perm = axes.map(axis => Math.abs(axis) - 1);
  return inverseOrient(nv.drawBitmap, perm.map(axis => dims[axis]), perm, axes.map(axis => axis < 0), dims, Uint8Array);
}

function drawingAxes(image) {
  const axes = Array.from(image.permRAS || []);
  if (axes.length !== 3 || new Set(axes.map(Math.abs)).size !== 3 || axes.some(axis => ![1, 2, 3].includes(Math.abs(axis)))) {
    throw new Error('The anatomical image drawing orientation is unavailable.');
  }
  return axes;
}

/** Binary native-space NIfTI mask on exactly the viewer's drawing (RAS) grid. */
export async function maskToDrawingBitmap(nv, source) {
  const image = nv.volumes?.[0];
  const bytes = await maskToUint8Nifti(source);
  const header = parseNiftiHeader(bytes);
  if (!sameVoxelGrid(header, image?.hdr)) throw new Error('Brain mask must match the displayed anatomical image grid.');
  const axes = drawingAxes(image);
  const { data } = readNiftiImageData(bytes, Uint8Array);
  return orientToRAS(
    Uint8Array.from(data, value => value > 0 ? 1 : 0), Array.from(header.dims.slice(1, 4)),
    axes.map(axis => Math.abs(axis) - 1), axes.map(axis => axis < 0)
  ).data;
}

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
  let sourceHeader = null;
  return {
    get enabled() { return api.enabled(); },
    async open(source = null) {
      sourceHeader = null;
      if (source === null) {
        api.createEmpty();
      } else {
        const nifti = await maskToUint8Nifti(source);
        if (!sameVoxelGrid(parseNiftiHeader(nifti), nv.volumes?.[0]?.hdr) || !await api.load(nifti)) return false;
        sourceHeader = extractNiftiHeader(nifti);
      }
      api.enable(true);
      return true;
    },
    close() {
      api.enable(false);
      api.close();
      sourceHeader = null;
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
      const saved = await savedNifti(api);
      const bytes = sourceHeader
        ? new Uint8Array(createUint8Nifti(nativeVoxels(saved, parseNiftiHeader(sourceHeader)), sourceHeader))
        : saved;
      // 0.x copies the base image's display range; an unset range lets every viewer scale the labels.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setFloat32(124, 0, true);
      view.setFloat32(128, 0, true);
      return bytes;
    },
  };
}

async function savedNifti(api) {
  const bytes = await api.save();
  if (!(bytes instanceof Uint8Array)) throw new Error('NiiVue returned no drawing to export');
  return bytes;
}

function voxOffset(nifti) {
  return Math.ceil(new DataView(nifti.buffer, nifti.byteOffset, nifti.byteLength).getFloat32(108, true));
}

function nativeVoxels(nifti, header = parseNiftiHeader(nifti)) {
  const labels = nifti.subarray(voxOffset(nifti));
  if (labels.length !== header.nx * header.ny * header.nz) {
    throw new Error('NiiVue drawing voxel count does not match the mask');
  }
  return labels;
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
