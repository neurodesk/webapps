// DOM-free TIFF layout/read/write and NIfTI grid helpers shared by the webapp and CLI.
import { createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";
import { inspectTiffStack, readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";

/**
 * A NIfTI header for a TIFF-ordered grid: row 0 is the top of the image, so world y runs
 * downwards with the row index and NiiVue shows the image the right way up.
 */
export function rasterHeader(dims, spacing) {
  const [dx, dy, dz] = spacing;
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, ...dims, 1, 1, 1, 1],
      pixDims: [1, dx, dy, dz, 1, 1, 1, 1],
      affine: [[dx, 0, 0, 0], [0, -dy, 0, (dims[1] - 1) * dy], [0, 0, dz, 0], [0, 0, 0, 1]],
    },
  });
}

function relativeSpacing(declared) {
  const dx = declared?.x ?? declared?.y ?? declared?.z;
  if (!dx) return [1, 1, 1];
  return [declared.x ?? dx, declared.y ?? dx, declared.z ?? dx].map((size) => size / dx);
}

/**
 * The layout of a TIFF (a File, read range by range, or an ArrayBuffer) from its headers alone:
 * { dims, spacing, unit }.
 */
export async function tiffLayout(source) {
  const { width, height, pages, samplesPerPixel, metadata } = await inspectTiffStack(source, { rgb: "mean" });
  const { kind, sizeZ, pixelSize } = metadata;
  const channels = kind === "ome" && metadata.sizeC === samplesPerPixel ? 1 : metadata.sizeC;
  const sizeT = kind === "baseline" ? 1 : metadata.sizeT;
  if (channels > 1 || sizeT > 1) {
    const parts = [channels > 1 ? `${channels} channels` : null, sizeT > 1 ? `${sizeT} time points` : null].filter(Boolean).join(" and ");
    throw new Error(`This TIFF is a hyperstack with ${parts}. In Fiji, use Image › Duplicate with one channel and one time point, save it as TIFF and load that.`);
  }
  if (kind === "ome" && pages < sizeZ) {
    throw new Error(`This OME-TIFF declares ${sizeZ} planes but holds ${pages}; its other planes are in other files. Save the stack as one TIFF.`);
  }
  if (pixelSize.x !== null) {
    const dx = pixelSize.x;
    return { dims: [width, height, pages], spacing: [dx, pixelSize.y ?? dx, pixelSize.z ?? dx], unit: kind === "imagej" ? "micron" : "\u00b5m" };
  }
  return { dims: [width, height, pages], spacing: relativeSpacing(metadata.declaredSpacing), unit: "pixel" };
}

/**
 * One greyscale image or stack from TIFF bytes: { data: Float64Array, dims, spacing, unit }.
 * Colour pages become the mean of their channels (ImageJ's RGB to 8-bit conversion).
 */
export async function readTiff(buffer) {
  const layout = await tiffLayout(buffer);
  const { data } = await readTiffStack(buffer, { rgb: "mean", Type: Float64Array, maxBytes: Infinity });
  return { data, ...layout };
}

/**
 * A little-endian TIFF ArrayBuffer of float32 voxels, or of RGB triplets from a Uint8Array
 * (`rgb: true`), one page per z, with an ImageJ stack description and the voxel size.
 */
export function writeTiff({ data, dims, spacing = [1, 1, 1], unit = "pixel", rgb = false }) {
  const [nx, ny, nz] = dims;
  const description = [
    "ImageJ=1.54f",
    `images=${nz}`,
    ...(nz > 1 ? [`slices=${nz}`, `spacing=${spacing[2]}`] : []),
    `unit=${unit === "pixel" ? "pixel" : "micron"}`,
    "",
  ].join("\n");
  const samples = rgb || data instanceof Float32Array ? data : Float32Array.from(data);
  return writeTiffStack({ width: nx, height: ny, data: samples, description, pixelSize: { x: spacing[0], y: spacing[1] }, rgb }).buffer;
}

/** Interleaved x, y, z per voxel to three frames, the NIfTI vector layout. */
export function frameMajor(vectors) {
  const n = vectors.length / 3;
  const frames = new Float32Array(vectors.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) frames[k * n + i] = vectors[3 * i + k];
  return frames;
}
