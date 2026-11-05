// The viewer shows the written OME-Zarr, read back: one NIfTI per channel of the largest level
// that fits the preview, at t = 0. NIfTI is in millimetres, so the NGFF units are converted;
// an axis without a unit is drawn as if its scale were millimetres. Row 0 is placed at the
// top (the y axis is negated), as microscopy viewers show it.
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io/nifti";
import { isSpaceUnit, millimetresPer } from "@neurodesk/omezarr-convert/units";

export const PREVIEW_MAX_PIXELS = 1024;

/** Bytes above which an image is not read for a preview, before or after conversion. */
export const SOURCE_PREVIEW_BYTES = 1024 ** 3;

/**
 * The level the output preview reads: the largest whose Y and X fit in `max` pixels (else the
 * smallest) and whose volume at t = 0 (C × Z × Y × X samples) fits in SOURCE_PREVIEW_BYTES.
 * -1 when even the smallest level is too large, as a deep Z stack can be.
 */
export function previewLevel(shapes, bytesPerSample, { max = PREVIEW_MAX_PIXELS, maxBytes = SOURCE_PREVIEW_BYTES } = {}) {
  const fits = (shape) => shape.slice(-4).reduce((product, size) => product * size, bytesPerSample) <= maxBytes;
  const index = shapes.findIndex((shape) => Math.max(shape.at(-1), shape.at(-2)) <= max);
  const first = index < 0 ? shapes.length - 1 : index;
  for (let level = first; level < shapes.length; level += 1) if (fits(shapes[level])) return level;
  return -1;
}

/** Millimetres per voxel along z, y, x of one level, from its NGFF axes and scale. */
export function voxelMillimetres(axes, scale) {
  return ["z", "y", "x"].map((name) => {
    const index = axes.findIndex((axis) => axis.name === name);
    const unit = axes[index]?.unit;
    return scale[index] * (isSpaceUnit(unit ?? "") ? millimetresPer(unit) : 1);
  });
}

/** A NIfTI-1 file of one channel's z, y, x stack with the given millimetre spacing. */
export function channelNifti(data, [depth, height, width], [dz, dy, dx], name) {
  const header = createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, width, height, depth, 1, 1, 1, 1],
      pixDims: [1, dx, dy, dz, 1, 1, 1, 1],
      affine: [
        [dx, 0, 0, 0],
        [0, -dy, 0, (height - 1) * dy],
        [0, 0, dz, 0],
        [0, 0, 0, 1],
      ],
    },
  });
  return new File([createNiftiFromData(data, header, { dims: [width, height, depth] })], name, { type: "application/octet-stream" });
}

const COLORMAPS = { FF0000: "red", "00FF00": "green", "0000FF": "blue" };

/** NiiVue's colormap for an omero colour: red, green or blue when it is one, else grey. */
export function channelColormap(color) {
  return COLORMAPS[String(color).toUpperCase()] ?? "gray";
}

/**
 * The input at t = 0 for the viewer before conversion: every Z plane of each channel, Y and X
 * subsampled by the power of two that fits `max` pixels, with each channel's range. Returns
 * null when the image is above `SOURCE_PREVIEW_BYTES`.
 */
export async function readSourcePreview(source, { signal, max = PREVIEW_MAX_PIXELS, onPlane } = {}) {
  const { c: channels, z: depth, y, x } = source.shape;
  const bytesPer = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 }[source.dtype];
  if (channels * depth * y * x * bytesPer > SOURCE_PREVIEW_BYTES) return null;
  let stride = 1;
  while (Math.max(y, x) / stride > max) stride *= 2;
  const height = Math.ceil(y / stride);
  const width = Math.ceil(x / stride);
  const volumes = [];
  for (let c = 0; c < channels; c += 1) volumes.push({ data: null, range: [Infinity, -Infinity] });
  for (let z = 0; z < depth; z += 1) {
    for (let c = 0; c < channels; c += 1) {
      signal?.throwIfAborted();
      const plane = await source.readPlane(0, c, z, { signal });
      const volume = volumes[c];
      volume.data ??= new plane.constructor(depth * height * width);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const value = plane[row * stride * x + column * stride];
          volume.data[(z * height + row) * width + column] = value;
          // The display range covers finite values; NaN and ±Infinity would break the window.
          if (!Number.isFinite(value)) continue;
          if (value < volume.range[0]) volume.range[0] = value;
          if (value > volume.range[1]) volume.range[1] = value;
        }
      }
      onPlane?.((z * channels + c + 1) / (depth * channels));
    }
  }
  for (const volume of volumes) if (volume.range[0] > volume.range[1]) volume.range = [0, 0];
  const unit = (axis) => (isSpaceUnit(source.units[axis] ?? "") ? millimetresPer(source.units[axis]) : 1);
  const spacing = [(source.scale.z ?? 1) * unit("z"), (source.scale.y ?? 1) * unit("y") * stride, (source.scale.x ?? 1) * unit("x") * stride];
  return { shape: [depth, height, width], spacing, stride, volumes };
}

/** The largest extent, in NiiVue millimetres, the preview is drawn at. */
export const DISPLAY_EXTENT_MM = 100;

/**
 * NiiVue's defaults are set for millimetre-scale images, so the preview is drawn with its
 * largest extent at DISPLAY_EXTENT_MM, the aspect ratio kept, and the location readout converts
 * back to true micrometres (trueMicrometres). `factor`
 * is display millimetres per true millimetre; `top` is the display y of row 0.
 */
export function displayGeometry([depth, height, width], [dz, dy, dx]) {
  const factor = DISPLAY_EXTENT_MM / Math.max(depth * dz, height * dy, width * dx);
  return { factor, spacing: [dz * factor, dy * factor, dx * factor], top: (height - 1) * dy * factor };
}

/** The true position in micrometres of a NiiVue location in display millimetres. */
export function trueMicrometres(mm, { factor, top }) {
  return [mm[0] / factor, (top - mm[1]) / factor, mm[2] / factor].map((value) => value * 1000);
}
