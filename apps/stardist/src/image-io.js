// 2D microscopy image input (TIFF, OME-TIFF, PNG) and the label TIFF the app writes.
// DOM-free so the Node tests and the worker can use it.
import { fromArrayBuffer } from "geotiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/** The largest image the app segments: a 2D image of at most 64 megapixels. */
export const MAX_PIXELS = 8192 * 8192;
/** The most decoded sample bytes a file may hold across its pages, checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
const MAX_PLANES = 256;
const RGB = ["red", "green", "blue"];
const PHOTOMETRIC_RGB = 2;
// ExtraSamples values 1 and 2 are associated and unassociated alpha; 0 is unspecified data.
const ALPHA = new Set([1, 2]);

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

/** Channel names from OME-XML when every page is one channel of a single plane. */
function omeChannelNames(xml, pages) {
  if (!xml?.includes("<OME")) return null;
  const pixels = /<Pixels\b[^>]*>/.exec(xml)?.[0] ?? "";
  const size = (axis) => Number(new RegExp(`Size${axis}="(\\d+)"`).exec(pixels)?.[1] ?? 1);
  if (size("Z") * size("T") !== 1 || size("C") !== pages) return null;
  const names = [...xml.matchAll(/<Channel\b[^>]*>/g)].map((tag, index) => /\bName="([^"]*)"/.exec(tag[0])?.[1] || `Channel ${index + 1}`);
  return names.length === pages ? names : null;
}

async function readTiff(name, buffer) {
  const tiff = await fromArrayBuffer(buffer);
  const count = await tiff.getImageCount();
  const pages = [];
  for (let index = 0; index < count; index++) {
    const image = await tiff.getImage(index);
    const directory = image.fileDirectory;
    // Reduced-resolution pages (NewSubfileType bit 0) are pyramid levels, not planes.
    if (directory.hasTag("NewSubfileType") && Number(await directory.loadValue("NewSubfileType")) & 1) continue;
    pages.push(image);
    if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; save the plane to segment as its own image.`);
  }
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const width = pages[0].getWidth();
  const height = pages[0].getHeight();
  checkSize(name, width, height);
  const first = pages[0].fileDirectory;
  const xml = first.hasTag("ImageDescription") ? String(await first.loadValue("ImageDescription")) : null;
  const names = omeChannelNames(xml, pages.length);
  let bytes = 0;
  for (const image of pages) {
    if (image.getWidth() !== width || image.getHeight() !== height) {
      throw new Error(`${name} has pages of different sizes; save the plane to segment as its own image.`);
    }
    // Decoded size, not stored size: geotiff widens some samples (float16 to Float32Array).
    for (let sample = 0; sample < image.getSamplesPerPixel(); sample++) {
      bytes += width * height * image.getArrayForSample(sample, 1).BYTES_PER_ELEMENT;
    }
  }
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 30).toFixed(1)} GB of pixels in ${pages.length} pages; save the plane to segment as its own image.`);
  }
  const planes = [];
  for (const [index, image] of pages.entries()) {
    const kinds = await sampleKinds(image);
    const samples = await image.readRasters({ interleave: false });
    const kept = kinds.filter((kind) => kind !== "alpha").length;
    samples.forEach((data, sample) => {
      if (kinds[sample] === "alpha") return;
      const page = names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = kept > 1 ? kinds[sample] : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", data });
    });
  }
  return { width, height, format: xml?.includes("<OME") ? "OME-TIFF" : "TIFF", planes };
}

/**
 * What each sample of a TIFF page is: red, green and blue for the first three samples of an RGB
 * page, "alpha" for an ExtraSamples alpha, and "sample N" for every other sample, which is a
 * channel of its own (a MinIsBlack page with four fluorescence samples has four channels).
 */
async function sampleKinds(image) {
  const directory = image.fileDirectory;
  const count = image.getSamplesPerPixel();
  const photometric = directory.hasTag("PhotometricInterpretation") ? Number(await directory.loadValue("PhotometricInterpretation")) : 1;
  const base = photometric === PHOTOMETRIC_RGB && count >= 3 ? 3 : Math.min(1, count);
  const extra = directory.hasTag("ExtraSamples") ? Array.from([await directory.loadValue("ExtraSamples")].flat(), Number) : [];
  return Array.from({ length: count }, (_, sample) => {
    if (sample < base) return base === 3 ? RGB[sample] : "sample 1";
    return ALPHA.has(extra[sample - base]) ? "alpha" : `sample ${sample + 1}`;
  });
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
  return { width: png.width, height: png.height, format: "PNG", planes };
}

/**
 * Reads a 2D image into its planes: TIFF pages and samples, OME-TIFF channels, or PNG
 * channels (alpha left out). Every plane is width × height values of the file's type.
 */
export async function readImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPng(name, buffer);
  if (isTiff(bytes)) return readTiff(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF or PNG image.`);
}

/**
 * An uncompressed single-strip little-endian TIFF of the label image: unsigned 16-bit when
 * the labels fit, 32-bit otherwise. Values are the nucleus ids of the CSV table.
 */
export function writeLabelTiff(labels, width, height) {
  let max = 0;
  for (const label of labels) if (label > max) max = label;
  const bits = max <= 0xffff ? 16 : 32;
  const pixels = bits === 16 ? Uint16Array.from(labels) : Uint32Array.from(labels);
  const entries = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, bits],
    [259, 3, 1],
    [262, 3, 1],
    [273, 4, 0],
    [277, 3, 1],
    [278, 4, height],
    [279, 4, pixels.byteLength],
    [284, 3, 1],
    [339, 3, 1],
  ];
  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = ifdOffset + ifdSize;
  const out = new Uint8Array(dataOffset + pixels.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, value], index) => {
    const at = ifdOffset + 2 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, 1, true);
    if (tag === 273) value = dataOffset;
    if (type === 3) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  out.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), dataOffset);
  return out;
}

/** The per-nucleus table: id, centroid (pixels, x right and y down from the top-left pixel's centre), area, mean intensity, probability. */
export function nucleiCsv(nuclei) {
  const lines = ["id,centroid_x,centroid_y,area_px,mean_intensity,probability"];
  for (const row of nuclei) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.area, row.mean.toPrecision(7), row.probability.toFixed(4)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
