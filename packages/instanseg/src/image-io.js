// 2D RGB brightfield microscopy image I/O (TIFF, OME-TIFF, PNG) and 16/32-bit label TIFF export.
// DOM-free so Node tests and Web Workers can both use it.
import {
  imagejDescription,
  inspectTiffStack,
  isOmeDescription,
  openTiffPlanes,
  parseImagejDescription,
  parseOmeDescription,
  readTiffDescription,
  writeLabelTiff,
  writeTiffStack,
} from '@neurodesk/webapp-components/file-io/tiff';
import { convertIndexedToRgb, decode as decodePng } from 'fast-png';

/** Maximum supported 2D image area in browser memory (16 megapixels = 4096 x 4096). */
export const MAX_PIXELS = 4096 * 4096;
/** Maximum decoded sample bytes across all pages before refusal (512 MiB). */
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const RGB = ['red', 'green', 'blue'];

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isTiff(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

function checkSize(name, width, height) {
  if (!width || !height) throw new Error(`${name} has no pixels.`);
  if (width < 16 || height < 16) throw new Error(`${name} is ${width} × ${height}; InstanSeg needs at least 16 × 16 pixels.`);
  if (width * height > MAX_PIXELS) {
    throw new Error(`${name} is ${width} × ${height} (${(width * height / 1e6).toFixed(1)} MP); crop images above 16 MP or run the Standalone container for whole-slide images.`);
  }
}

function preflightPng(name, bytes) {
  if (bytes.byteLength < 33) throw new Error(`${name} is not a complete PNG image.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = view.getUint32(8, false);
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdrLen !== 13 || tag !== 'IHDR') throw new Error(`${name} has a malformed PNG header.`);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  checkSize(name, width, height);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 3 : colorType === 4 ? 2 : 4;
  const decoded = width * height * channels * (bitDepth > 8 ? 2 : 1);
  if (decoded > MAX_DECODED_BYTES) {
    throw new Error(`${name} would decode to ${(decoded / 2 ** 20).toFixed(0)} MiB; crop or downsample it first.`);
  }
}

function extractPixelSizeUm(metadata) {
  if (!metadata) return null;
  const px = metadata.pixelSize;
  if (px && (px.x > 0 || px.y > 0)) {
    const val = px.x > 0 ? px.x : px.y;
    // Match upstream instanseg.utils.utils.read_image: ignore pixel_size <= 0 or > 2 µm/px.
    if (val > 0 && val <= 2) return val;
  }
  return null;
}

async function readTiffRgb(name, buffer) {
  const tiff = await openTiffPlanes(buffer, { pageLimit: 8, palette: 'rgb' });
  const { pages } = tiff;
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const { width, height } = pages[0];
  checkSize(name, width, height);
  const bytes = tiff.decodedBytes();
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 20).toFixed(0)} MiB of pixels; crop it or use the Standalone container.`);
  }

  const rawDescription = (await readTiffDescription(buffer)) || tiff.description;
  const ome = parseOmeDescription(rawDescription);
  if (!ome && isOmeDescription(rawDescription)) {
    throw new Error(`${name} references companion OME-XML metadata; save it as a single self-contained OME-TIFF.`);
  }
  const imagej = ome ? null : parseImagejDescription(rawDescription);
  if (ome && ome.images > 1) {
    throw new Error(`${name} holds ${ome.images} OME series; save one 2D RGB plane as its own file.`);
  }
  if ((ome && ome.sizeZ > 1) || (imagej && imagej.sizeZ > 1)) {
    throw new Error(`${name} is a 3D stack; brightfield_nuclei segments a single 2D RGB brightfield plane.`);
  }
  if ((ome && ome.sizeT > 1) || (imagej && imagej.sizeT > 1)) {
    throw new Error(`${name} is a time series; save one 2D RGB frame as its own file.`);
  }

  const decodedPages = await tiff.readPlanes();
  let rgbPlanes = null;
  if (pages.length === 1 && decodedPages[0].length >= 3) {
    const rgbSamples = decodedPages[0].filter((s) => RGB.includes(s.kind));
    if (rgbSamples.length === 3) {
      rgbPlanes = RGB.map((kind) => rgbSamples.find((s) => s.kind === kind).data);
    }
  } else if (pages.length === 3 && decodedPages.every((p) => p.length === 1)) {
    rgbPlanes = decodedPages.map((p) => p[0].data);
  }
  if (!rgbPlanes) {
    throw new Error(`${name} is not a 3-channel 2D RGB brightfield image. InstanSeg brightfield_nuclei requires 2D RGB TIFF, OME-TIFF, or PNG.`);
  }

  let spacingMeta = ome ?? imagej;
  if (!spacingMeta) {
    try {
      spacingMeta = (await inspectTiffStack(buffer, { rgb: 'mean' })).metadata;
    } catch {
      // Uncalibrated baseline TIFF.
    }
  }

  const plane = width * height;
  const rgbChw = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) {
    const src = rgbPlanes[c];
    const off = c * plane;
    for (let i = 0; i < plane; i++) rgbChw[off + i] = src[i];
  }

  return {
    width,
    height,
    format: ome ? 'OME-TIFF' : 'TIFF',
    rgbChw,
    planes: RGB.map((label, c) => ({ label, data: rgbPlanes[c] })),
    pixelSize: extractPixelSizeUm(spacingMeta),
  };
}

function readPngRgb(name, buffer) {
  const bytes = new Uint8Array(buffer);
  preflightPng(name, bytes);
  const png = decodePng(bytes);
  checkSize(name, png.width, png.height);
  let { data, channels } = png;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0].length;
  }
  if (channels < 3) {
    throw new Error(`${name} is greyscale (${channels} channel); InstanSeg brightfield_nuclei requires a 2D RGB brightfield image.`);
  }
  const plane = png.width * png.height;
  const rgbChw = new Float32Array(3 * plane);
  const planes = [];
  for (let c = 0; c < 3; c++) {
    const p = new data.constructor(plane);
    const off = c * plane;
    for (let i = 0; i < plane; i++) {
      const v = data[i * channels + c];
      p[i] = v;
      rgbChw[off + i] = v;
    }
    planes.push({ label: RGB[c], data: p });
  }
  return {
    width: png.width,
    height: png.height,
    format: 'PNG',
    rgbChw,
    planes,
    pixelSize: null,
  };
}

/** Read a bounded 2D RGB brightfield microscopy image (TIFF, OME-TIFF, or PNG). */
export async function readBrightfieldImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPngRgb(name, buffer);
  if (isTiff(bytes)) return readTiffRgb(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF, or PNG image.`);
}

/** Write a 16-bit (or 32-bit when > 65535 nuclei) label TIFF, preserving physical pixel size when known. */
export function writeLabelsTiff(labels, width, height, pixelSize = null) {
  let max = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
  const data = max <= 0xffff ? Uint16Array.from(labels) : Uint32Array.from(labels);
  if (!pixelSize || !Number.isFinite(pixelSize) || pixelSize <= 0) {
    return writeLabelTiff(data, width, height);
  }
  const description = imagejDescription({ slices: 1, unit: 'micron' });
  return writeTiffStack({ width, height, data, description, pixelSize: { x: pixelSize, y: pixelSize } });
}

export function stemName(fileName) {
  return String(fileName || 'instanseg').replace(/\.(ome\.tiff?|tiff?|png)$/i, '');
}
