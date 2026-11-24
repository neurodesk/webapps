// 2D and 3D microscopy image input (TIFF, OME-TIFF, PNG) and label/table outputs for Cellpose.
// DOM-free so the Node unit tests and browser page both use it directly.
import {
  imagejDescription,
  omePageChannels,
  openTiffPlanes,
  parseImagejDescription,
  parseOmeDescription,
  writeLabelTiff,
  writeTiffStack,
} from "@neurodesk/webapp-components/file-io/tiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/** Largest 2D image supported: 64 megapixels. */
export const MAX_PIXELS = 8192 * 8192;
/** Maximum decoded pixel bytes checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
const MAX_PLANES = 1024;
const RGB = ["red", "green", "blue"];

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isTiff(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

function checkSize(name, width, height) {
  if (!width || !height) throw new Error(`${name} has no pixels.`);
  if (width < 16 || height < 16) throw new Error(`${name} is ${width} × ${height}; Cellpose needs at least 16 × 16 pixels.`);
  if (width * height > MAX_PIXELS) throw new Error(`${name} is ${width} × ${height}; split images over 64 megapixels into tiles first.`);
}

function tifffileShape3d(description, pageCount) {
  if (!description || !description.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(description);
    return Array.isArray(parsed.shape) && parsed.shape.length === 3 && parsed.shape[0] === pageCount;
  } catch {
    return false;
  }
}

function packStack(sliceArrays) {
  const planeLen = sliceArrays[0].length;
  const Type = sliceArrays[0].constructor;
  const out = new Type(sliceArrays.length * planeLen);
  for (let z = 0; z < sliceArrays.length; z++) out.set(sliceArrays[z], z * planeLen);
  return out;
}

function buildStack(pages, decodedPages, ome, imagej, description) {
  if (pages.length < 2) return { stack: null, is3dHint: false };
  if (decodedPages.some((samples) => samples.length !== 1)) return { stack: null, is3dHint: false };
  if (ome && ome.sizeZ <= 1 && ome.sizeC > 1) return { stack: null, is3dHint: false };
  const slices = decodedPages.map((samples) => samples[0].data);
  if (ome && ome.sizeZ > 1 && ome.sizeC > 1 && ome.sizeT === 1 && ome.sizeZ * ome.sizeC === pages.length) {
    const order = String(ome.dimensionOrder ?? "XYZCT").slice(2);
    const zFirst = order.indexOf("Z") < order.indexOf("C");
    const channels = [];
    for (let c = 0; c < ome.sizeC; c++) {
      const channelSlices = [];
      for (let z = 0; z < ome.sizeZ; z++) {
        const idx = zFirst ? c * ome.sizeZ + z : z * ome.sizeC + c;
        channelSlices.push(slices[idx]);
      }
      channels.push({ label: ome.channels[c]?.name || `Channel ${c + 1}`, data: packStack(channelSlices) });
    }
    return { stack: { depth: ome.sizeZ, channels }, is3dHint: true };
  }
  if (imagej && imagej.sizeZ > 1 && imagej.sizeC > 1 && imagej.sizeZ * imagej.sizeC === pages.length) {
    const channels = [];
    for (let c = 0; c < imagej.sizeC; c++) {
      const channelSlices = [];
      for (let z = 0; z < imagej.sizeZ; z++) channelSlices.push(slices[z * imagej.sizeC + c]);
      channels.push({ label: `Channel ${c + 1}`, data: packStack(channelSlices) });
    }
    return { stack: { depth: imagej.sizeZ, channels }, is3dHint: true };
  }
  const label = ome?.channels?.[0]?.name || "Intensity";
  const stack = { depth: pages.length, channels: [{ label, data: packStack(slices) }] };
  const is3dHint = Boolean(
    (ome && ome.sizeZ > 1) ||
    (imagej && imagej.sizeZ > 1) ||
    tifffileShape3d(description, pages.length) ||
    pages.length >= 5,
  );
  return { stack, is3dHint };
}

async function readTiff(name, buffer) {
  const tiff = await openTiffPlanes(buffer, { pageLimit: MAX_PLANES + 1, palette: "index" });
  const { pages } = tiff;
  if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; save the plane or sub-stack to segment as its own image.`);
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const { width, height } = pages[0];
  checkSize(name, width, height);
  if (pages.some((page) => page.width !== width || page.height !== height)) {
    throw new Error(`${name} has pages of different sizes; save the plane to segment as its own image.`);
  }
  const bytes = tiff.decodedBytes();
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 30).toFixed(1)} GB of pixels in ${pages.length} pages; save the plane to segment as its own image.`);
  }
  const ome = parseOmeDescription(tiff.description);
  const imagej = ome ? null : parseImagejDescription(tiff.description);
  const names = ome ? omePageChannels(name, ome, pages.map((page) => page.ifd)) : null;
  const decodedPages = await tiff.readPlanes();
  const planes = [];
  for (const [index, samples] of decodedPages.entries()) {
    for (const { kind, data } of samples) {
      const page = names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = samples.length > 1 ? kind : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", data });
    }
  }
  const isRgb = pages.length === 1 && decodedPages[0].length === 3 && decodedPages[0].every((sample, idx) => sample.kind === RGB[idx]);
  const { stack, is3dHint } = buildStack(pages, decodedPages, ome, imagej, tiff.description);
  return { width, height, depth: stack ? stack.depth : 1, format: ome ? "OME-TIFF" : "TIFF", planes, isRgb, stack, is3dHint };
}

function unpackBits(png) {
  const { width, height, depth, data } = png;
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth;
      out[y * width + x] = (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

function readPng(name, buffer) {
  const png = decodePng(new Uint8Array(buffer));
  checkSize(name, png.width, png.height);
  let { data, channels } = png;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0].length;
  } else if (png.depth < 8) {
    data = unpackBits(png);
  }
  const colour = channels >= 3;
  const kept = colour ? 3 : 1;
  const planes = [];
  for (let c = 0; c < kept; c++) {
    const plane = new data.constructor(png.width * png.height);
    for (let i = 0; i < plane.length; i++) plane[i] = data[i * channels + c];
    planes.push({ label: colour ? RGB[c] : "Intensity", data: plane });
  }
  return { width: png.width, height: png.height, depth: 1, format: "PNG", planes, isRgb: colour, stack: null, is3dHint: false };
}

/** Reads a 2D image or 3D TIFF/OME-TIFF stack into its planes and optional 3D channel volumes. */
export async function readImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPng(name, buffer);
  if (isTiff(bytes)) return readTiff(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF or PNG image.`);
}

/** Writes a 2D or 3D label array as an uncompressed 16-bit (or 32-bit) TIFF. */
export function writeLabelsTiff(labels, width, height, depth = 1) {
  if (depth <= 1) return writeLabelTiff(labels, width, height);
  let max = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
  const data = max <= 0xffff ? Uint16Array.from(labels) : Uint32Array.from(labels);
  return writeTiffStack({ width, height, data, description: imagejDescription({ slices: depth }) });
}

/** 2D per-cell CSV table: id, centroid (x, y), area in pixels, mean intensity. */
export function cellsCsv(cells) {
  const lines = ["id,centroid_x,centroid_y,area_px,mean_intensity"];
  for (const row of cells) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.area, row.mean.toPrecision(7)].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** 3D per-cell CSV table: id, centroid (x, y, z), volume in voxels, mean intensity. */
export function cellsCsv3D(cells) {
  const lines = ["id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity"];
  for (const row of cells) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.z.toFixed(3), row.volume, row.mean.toPrecision(7)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
