// 2D microscopy image input (TIFF, OME-TIFF, PNG) and the nucleus table the app writes.
// DOM-free so the Node tests and the worker can use it.
import { omePageChannels, openTiffPlanes, parseOmeDescription } from "@neurodesk/webapp-components/file-io/tiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/** The largest image the app segments: a 2D image of at most 64 megapixels. */
export const MAX_PIXELS = 8192 * 8192;
/** The most decoded sample bytes a file may hold across its pages, checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
const MAX_PLANES = 256;
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

async function readTiff(name, buffer) {
  // A palette page is its colour indices, as tifffile and Python StarDist read it: Fiji saves an
  // 8-bit channel with a coloured LUT (a blue DAPI channel) as a palette TIFF.
  const tiff = await openTiffPlanes(buffer, { pageLimit: MAX_PLANES + 1, palette: "index" });
  const { pages } = tiff;
  if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; save the plane to segment as its own image.`);
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
  const names = ome ? omePageChannels(name, ome, pages.map((page) => page.ifd)) : null;
  const planes = [];
  for (const [index, samples] of (await tiff.readPlanes()).entries()) {
    for (const { kind, data } of samples) {
      const page = names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = samples.length > 1 ? kind : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", data });
    }
  }
  return { width, height, format: ome ? "OME-TIFF" : "TIFF", planes };
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

/** The per-nucleus table: id, centroid (pixels, x right and y down from the top-left pixel's centre), area, mean intensity, probability. */
export function nucleiCsv(nuclei) {
  const lines = ["id,centroid_x,centroid_y,area_px,mean_intensity,probability"];
  for (const row of nuclei) {
    lines.push([row.id, row.x.toFixed(3), row.y.toFixed(3), row.area, row.mean.toPrecision(7), row.probability.toFixed(4)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
