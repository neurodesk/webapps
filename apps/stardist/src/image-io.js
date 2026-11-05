// 2D microscopy image input (TIFF, OME-TIFF, PNG) and the label TIFF the app writes.
// DOM-free so the Node tests and the worker can use it.
import { fromArrayBuffer } from "geotiff";
import { decode as decodePng } from "fast-png";

/** The largest image the app segments: a 2D image of at most 64 megapixels. */
export const MAX_PIXELS = 8192 * 8192;
const MAX_PLANES = 256;
const RGB = ["red", "green", "blue", "alpha"];

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
  const planes = [];
  for (const [index, image] of pages.entries()) {
    if (image.getWidth() !== width || image.getHeight() !== height) {
      throw new Error(`${name} has pages of different sizes; save the plane to segment as its own image.`);
    }
    const samples = await image.readRasters({ interleave: false });
    const rgb = samples.length >= 3;
    samples.forEach((data, sample) => {
      if (rgb && sample === 3) return;
      const page = names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = samples.length > 1 ? (rgb ? RGB[sample] : `sample ${sample + 1}`) : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", data });
    });
  }
  return { width, height, format: xml?.includes("<OME") ? "OME-TIFF" : "TIFF", planes };
}

function readPng(name, buffer) {
  const png = decodePng(new Uint8Array(buffer));
  checkSize(name, png.width, png.height);
  let { data, channels } = png;
  if (png.palette) {
    const rgb = new Uint8Array(png.width * png.height * 3);
    for (let i = 0; i < png.width * png.height; i++) rgb.set(png.palette[data[i]].slice(0, 3), 3 * i);
    data = rgb;
    channels = 3;
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
