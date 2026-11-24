// 2D and 3D microscopy image input (TIFF, OME-TIFF, PNG) and the label/table files the app writes.
// DOM-free so the Node tests and the worker can use it.
import {
  imagejDescription,
  isOmeDescription,
  omePageChannels,
  openTiffPlanes,
  openTiffStackPages,
  parseImagejDescription,
  parseOmeDescription,
  readTiffDescription,
  writeLabelTiff,
  writeTiffStack,
} from "@neurodesk/webapp-components/file-io/tiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/** The largest 2D image the app segments: at most 64 megapixels. */
export const MAX_PIXELS = 8192 * 8192;
/** The most decoded sample bytes a file may hold across its pages, checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
export const MAX_PLANES = 1024;
const RGB = ["red", "green", "blue"];

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isTiff(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

function checkSize(name, width, height) {
  if (!width || !height) throw new Error(`${name} has no pixels.`);
  if (width < 16 || height < 16) throw new Error(`${name} is ${width} × ${height}; StarDist needs at least 16 × 16 pixels.`);
  if (width * height > MAX_PIXELS) throw new Error(`${name} is ${width} × ${height}; split images over 64 megapixels into tiles first.`);
}

/** Preflight PNG IHDR header dimensions and decoded byte budget before decompressing pixels. */
function preflightPng(name, bytes) {
  if (bytes.byteLength < 33) throw new Error(`${name} is not a complete PNG image.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = view.getUint32(8, false);
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdrLen !== 13 || tag !== "IHDR") throw new Error(`${name} has a malformed PNG header.`);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  checkSize(name, width, height);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 4;
  const bytesPerSample = bitDepth > 8 ? 2 : 1;
  const decoded = width * height * channels * bytesPerSample;
  if (decoded > MAX_DECODED_BYTES) {
    throw new Error(`${name} would decode to ${(decoded / 2 ** 30).toFixed(1)} GB of pixels; crop or downsample it first.`);
  }
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

/** Extract validated physical spacing (`{ x, y, z, unit }`, in µm when calibrated) from TIFF metadata. */
function extractSpacing(metadata) {
  if (!metadata) return null;
  const px = metadata.pixelSize;
  if (px && (px.x || px.y || px.z)) {
    return {
      x: px.x && px.x > 0 ? px.x : null,
      y: px.y && px.y > 0 ? px.y : null,
      z: px.z && px.z > 0 ? px.z : null,
      unit: "micron",
    };
  }
  const decl = metadata.declaredSpacing;
  if (decl && decl.z && decl.z > 0) {
    return {
      x: decl.x && decl.x > 0 ? decl.x : null,
      y: decl.y && decl.y > 0 ? decl.y : null,
      z: decl.z,
      unit: decl.unit || null,
    };
  }
  return null;
}

async function readTiff(name, buffer) {
  // A palette page is its colour indices, as tifffile and Python StarDist read it: Fiji saves an
  // 8-bit channel with a coloured LUT (a blue DAPI channel) as a palette TIFF.
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

  // Always read IFD 0's description directly (even if IFD 0 is reduced-resolution) so OME-XML
  // time-series or BinaryOnly companion-file headers cannot be silently dropped.
  const rawDescription = (await readTiffDescription(buffer)) || tiff.description;
  const ome = parseOmeDescription(rawDescription);
  if (!ome && isOmeDescription(rawDescription)) {
    throw new Error(`${name} references OME-XML metadata in a companion file; open the companion file set in Fiji and save it as one OME-TIFF.`);
  }
  const imagej = ome ? null : parseImagejDescription(rawDescription);
  if (ome && ome.images > 1) {
    throw new Error(`${name} holds ${ome.images} OME image series; save the series you need as its own file.`);
  }
  if (ome && ome.sizeT > 1) {
    throw new Error(`${name} is a time series (${ome.sizeT} time points); save one time point as its own file.`);
  }
  if (imagej && imagej.sizeT > 1) {
    throw new Error(`${name} is a time series (${imagej.sizeT} frames); save one time point as its own file.`);
  }

  const singleSampleAll = pages.every((page) => page.samples.filter((s) => s !== "alpha").length === 1);

  // 3D OME-TIFF stack: delegate plane mapping (including TiffData & DimensionOrder) and sample-type
  // consistency to the shared openTiffStackPages reader.
  if (ome && ome.sizeZ > 1) {
    if (!singleSampleAll) {
      throw new Error(`${name} stores multiple samples per pixel inside a 3D OME-TIFF stack; save separate greyscale channels.`);
    }
    const stackPages = await openTiffStackPages(buffer);
    if (ome.sizeZ * ome.sizeC !== stackPages.pages) {
      throw new Error(`${name} declares ${ome.sizeZ} Z slices × ${ome.sizeC} channels but holds ${stackPages.pages} mapped planes.`);
    }
    const ordered = [];
    for (let i = 0; i < stackPages.pages; i++) ordered.push(await stackPages.readPage(i));
    const order = String(ome.dimensionOrder ?? "XYZCT").slice(2);
    const zFirst = order.indexOf("Z") < order.indexOf("C");
    const channels = [];
    const planes = [];
    for (let c = 0; c < ome.sizeC; c++) {
      const chName = ome.channels[c]?.name || (ome.sizeC > 1 ? `Channel ${c + 1}` : "Intensity");
      const channelSlices = [];
      for (let z = 0; z < ome.sizeZ; z++) {
        const idx = zFirst ? c * ome.sizeZ + z : z * ome.sizeC + c;
        channelSlices.push(ordered[idx]);
      }
      channels.push({ label: chName, data: packStack(channelSlices) });
    }
    for (let z = 0; z < ome.sizeZ; z++) {
      for (let c = 0; c < ome.sizeC; c++) {
        const idx = zFirst ? c * ome.sizeZ + z : z * ome.sizeC + c;
        const chName = ome.channels[c]?.name || `Channel ${c + 1}`;
        planes.push({ label: ome.sizeC > 1 ? `Slice ${z + 1} · ${chName}` : `Slice ${z + 1}`, data: ordered[idx] });
      }
    }
    return {
      width,
      height,
      depth: ome.sizeZ,
      format: "OME-TIFF",
      planes,
      isRgb: false,
      stack: { depth: ome.sizeZ, channels },
      is3dHint: true,
      spacing: extractSpacing(stackPages.metadata),
    };
  }

  // 3D ImageJ stack: honor ImageJ CZT ordering (C fastest, then Z) and validate uniform sample types.
  if (imagej && imagej.sizeZ > 1) {
    if (!singleSampleAll) {
      throw new Error(`${name} stores multiple samples per pixel inside a 3D ImageJ stack; save separate greyscale channels.`);
    }
    const stackPages = await openTiffStackPages(buffer);
    const sizeC = imagej.sizeC;
    const sizeZ = imagej.sizeZ;
    if (sizeC * sizeZ !== stackPages.pages) {
      throw new Error(`${name} declares ${sizeZ} slices × ${sizeC} channels but holds ${stackPages.pages} pages.`);
    }
    const ordered = [];
    for (let i = 0; i < stackPages.pages; i++) ordered.push(await stackPages.readPage(i));
    const channels = [];
    for (let c = 0; c < sizeC; c++) {
      const chName = sizeC > 1 ? `Channel ${c + 1}` : "Intensity";
      const channelSlices = [];
      for (let z = 0; z < sizeZ; z++) channelSlices.push(ordered[z * sizeC + c]);
      channels.push({ label: chName, data: packStack(channelSlices) });
    }
    const planes = [];
    for (let z = 0; z < sizeZ; z++) {
      for (let c = 0; c < sizeC; c++) {
        planes.push({
          label: sizeC > 1 ? `Slice ${z + 1} · Channel ${c + 1}` : `Slice ${z + 1}`,
          data: ordered[z * sizeC + c],
        });
      }
    }
    return {
      width,
      height,
      depth: sizeZ,
      format: "TIFF",
      planes,
      isRgb: false,
      stack: { depth: sizeZ, channels },
      is3dHint: true,
      spacing: extractSpacing(stackPages.metadata),
    };
  }

  // Baseline multi-page single-sample TIFF (no OME/ImageJ metadata): validate uniform sample types
  // through openTiffStackPages so mixed uint8/uint16 pages cannot silently truncate.
  if (!ome && !imagej && pages.length >= 2 && singleSampleAll) {
    const stackPages = await openTiffStackPages(buffer);
    const ordered = [];
    for (let i = 0; i < stackPages.pages; i++) ordered.push(await stackPages.readPage(i));
    const planes = ordered.map((data, index) => ({ label: `Page ${index + 1}`, data }));
    const stack = { depth: stackPages.pages, channels: [{ label: "Intensity", data: packStack(ordered) }] };
    const is3dHint = tifffileShape3d(tiff.description, stackPages.pages) || stackPages.pages >= 5;
    return {
      width,
      height,
      depth: stackPages.pages,
      format: "TIFF",
      planes,
      isRgb: false,
      stack,
      is3dHint,
      spacing: extractSpacing(stackPages.metadata),
    };
  }

  // 2D TIFF (single-page greyscale/RGB/multi-sample, 2D multi-channel OME-TIFF, or channel-only ImageJ).
  const names = ome ? omePageChannels(name, ome, pages.map((page) => page.ifd)) : null;
  const decodedPages = await tiff.readPlanes();
  const planes = [];
  for (const [index, samples] of decodedPages.entries()) {
    for (const { kind, data } of samples) {
      const fallbackPage = imagej && imagej.sizeC > 1 && pages.length === imagej.sizeC
        ? `Channel ${index + 1}`
        : (pages.length > 1 ? `Page ${index + 1}` : "");
      const page = names?.[index] ?? fallbackPage;
      const part = samples.length > 1 ? kind : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", data });
    }
  }
  const isRgb = pages.length === 1 && decodedPages[0].length === 3 && decodedPages[0].every((sample, idx) => sample.kind === RGB[idx]);
  return {
    width,
    height,
    depth: 1,
    format: ome ? "OME-TIFF" : "TIFF",
    planes,
    isRgb,
    stack: null,
    is3dHint: false,
    spacing: extractSpacing(ome ?? imagej),
  };
}

/** PNG samples below 8 bits, packed from the high bit and padded to a byte per row, as bytes. */
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
  const bytes = new Uint8Array(buffer);
  preflightPng(name, bytes);
  const png = decodePng(bytes);
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
  return { width: png.width, height: png.height, depth: 1, format: "PNG", planes, isRgb: colour, stack: null, is3dHint: false, spacing: null };
}

/**
 * Reads a 2D image or 3D TIFF stack into its planes: TIFF pages and samples, OME-TIFF channels
 * or Z-stacks, ImageJ hyperstacks, or PNG channels (alpha left out).
 */
export async function readImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPng(name, buffer);
  if (isTiff(bytes)) return readTiff(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF or PNG image.`);
}

/** Pack three planar channels `[R, G, B]` into an interleaved HWC Float32Array for `2D_versatile_he`. */
export function interleaveRgb(planes) {
  if (planes.length !== 3) throw new Error(`Expected 3 RGB channels, got ${planes.length}.`);
  const n = planes[0].data.length;
  const out = new Float32Array(n * 3);
  const r = planes[0].data;
  const g = planes[1].data;
  const b = planes[2].data;
  for (let i = 0; i < n; i++) {
    out[3 * i] = r[i];
    out[3 * i + 1] = g[i];
    out[3 * i + 2] = b[i];
  }
  return out;
}

/** Writes a 2D or 3D label array as an uncompressed 16-bit (or 32-bit) TIFF, preserving physical spacing when known. */
export function writeLabelsTiff(labels, width, height, depth = 1, spacing = null) {
  let max = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
  const data = max <= 0xffff ? Uint16Array.from(labels) : Uint32Array.from(labels);
  const pixelSize = spacing?.x && spacing?.y ? { x: spacing.x, y: spacing.y } : null;
  if (depth <= 1 && !pixelSize) return writeLabelTiff(labels, width, height);
  const description = depth > 1
    ? imagejDescription({ slices: depth, spacing: spacing?.z ?? null, unit: spacing?.unit ?? (pixelSize ? "micron" : null) })
    : (pixelSize ? imagejDescription({ slices: 1, unit: spacing?.unit ?? "micron" }) : "");
  return writeTiffStack({ width, height, data, description, pixelSize });
}

/** The 2D per-nucleus table: id, centroid (pixels, x right and y down), area, mean intensity, probability. */
export function nucleiCsv(nuclei) {
  const lines = ["id,centroid_x,centroid_y,area_px,mean_intensity,probability"];
  for (const row of nuclei) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.area, row.mean.toPrecision(7), row.probability.toFixed(4)].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** The 3D per-nucleus table: id, centroid (x, y, z in voxels), volume in voxels, mean intensity, probability. */
export function nucleiCsv3D(nuclei) {
  const lines = ["id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity,probability"];
  for (const row of nuclei) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.z.toFixed(3), row.volume, row.mean.toPrecision(7), row.probability.toFixed(4)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
