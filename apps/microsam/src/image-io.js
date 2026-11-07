// 2D light-microscopy input (TIFF, OME-TIFF, ImageJ TIFF, PNG) and the label TIFF the app writes.
// DOM-free so Node tests can use it. The TIFF part should move to the shared
// @neurodesk/webapp-components/file-io/tiff module once it can read 2D multi-sample pages.
import { fromArrayBuffer } from "geotiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/**
 * The largest image the app segments: 4096 × 4096 pixels (16 megapixels) per plane. The display
 * keeps two canvases of that size, inside Safari's canvas area limit, and the planes, labels and
 * overlays stay within a tab's memory.
 */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
/** The most decoded sample bytes a file may hold across the planes it keeps, checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
const MIN_SIZE = 8;
const MAX_PLANES = 64;
const RGB = ["red", "green", "blue"];
const PHOTOMETRIC_RGB = 2;
const PHOTOMETRIC_PALETTE = 3;
// ExtraSamples 1 and 2 are associated and unassociated alpha; 0 is unspecified data.
const ALPHA = new Set([1, 2]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isTiff(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

function checkSize(name, width, height) {
  if (!width || !height) throw new Error(`${name} has no pixels.`);
  if (width < MIN_SIZE || height < MIN_SIZE) throw new Error(`${name} is ${width} × ${height}; segment images of at least ${MIN_SIZE} × ${MIN_SIZE} pixels.`);
  if (width * height > MAX_PIXELS) throw new Error(`${name} is ${width} × ${height}; split images over ${MAX_PIXELS / 2 ** 20} megapixels (${MAX_SIDE} × ${MAX_SIDE}) into tiles first.`);
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** The attributes of every `<prefix:Name …>` tag, either quote form, entities decoded. */
function tags(xml, name) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, "g");
  return [...xml.matchAll(pattern)].map((match) => {
    const attributes = {};
    for (const [, key, double, single] of match[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[key.replace(/^[\w.-]+:/, "")] = decodeEntities(double ?? single);
    }
    return attributes;
  });
}

/** The text of every `<prefix:Name …>text</prefix:Name>` element. */
function texts(xml, name) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*?(?:/>|>([^<]*)<)`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeEntities(match[1] ?? "").trim());
}

/**
 * The channel each IFD holds, from the TiffData elements of a 2D OME image (Z and T are 1, so
 * the planes of one TiffData are consecutive channels). Without TiffData the IFDs are the channels
 * in order. Returns IFD index → channel index; throws on a layout it cannot interpret.
 */
function tiffDataChannels(name, description, channels) {
  const refuse = (why) => new Error(`${name} maps its channels to TIFF pages in a way the app cannot read (${why}); save the channels as one OME-TIFF with tifffile or Fiji.`);
  const entries = tags(description, "TiffData");
  const map = new Map();
  if (!entries.length) {
    for (let c = 0; c < channels; c++) map.set(c, c);
    return map;
  }
  const own = tags(description, "OME")[0]?.UUID;
  if (texts(description, "UUID").some((uuid) => uuid && uuid !== own)) throw refuse("planes in another file");
  for (const entry of entries) {
    const integer = (key, fallback) => {
      if (entry[key] === undefined) return fallback;
      if (!/^\d+$/.test(entry[key])) throw refuse(`${key}="${entry[key]}"`);
      return Number(entry[key]);
    };
    if (integer("FirstZ", 0) || integer("FirstT", 0)) throw refuse("a plane beyond Z 0, T 0");
    const ifd = integer("IFD", 0);
    const first = integer("FirstC", 0);
    const count = integer("PlaneCount", entry.IFD === undefined ? channels : 1);
    for (let k = 0; k < count; k++) {
      if (first + k >= channels) throw refuse(`channel ${first + k + 1} of ${channels}`);
      if (map.has(ifd + k)) throw refuse(`IFD ${ifd + k} named twice`);
      map.set(ifd + k, first + k);
    }
  }
  if (new Set(map.values()).size !== map.size) throw refuse("a channel in two IFDs");
  return map;
}

/**
 * The plane layout OME-XML or an ImageJ description declares: channel names, in the order of the
 * kept pages (`ifds`, their IFD indices), when the pages are the channels of one 2D image. Z-stacks,
 * time series, several OME images and TiffData layouts it cannot follow are refused.
 */
export function describedLayout(name, description, ifds) {
  const pages = ifds.length;
  if (!description) return null;
  if (/<(?:[\w.-]+:)?OME\b/.test(description)) {
    const images = tags(description, "Image");
    if (images.length > 1) throw new Error(`${name} holds ${images.length} OME images; save the image to segment on its own.`);
    const pixels = tags(description, "Pixels")[0] ?? {};
    const size = (axis) => Number(pixels[`Size${axis}`] ?? 1);
    if (size("Z") > 1 || size("T") > 1) {
      throw new Error(`${name} is a ${size("Z") > 1 ? "Z-stack" : "time series"} (${size("Z")} slices, ${size("T")} time points); save one 2D plane to segment.`);
    }
    const channels = tags(description, "Channel");
    const names = Array.from({ length: size("C") }, (_, i) => channels[i]?.Name || `Channel ${i + 1}`);
    const onePerPage = names.length === pages && channels.every((channel) => Number(channel.SamplesPerPixel ?? 1) === 1);
    if (!onePerPage) return { format: "OME-TIFF", names: null };
    const map = tiffDataChannels(name, description, names.length);
    const missing = ifds.find((ifd) => !map.has(ifd));
    if (missing !== undefined) throw new Error(`${name} has a TIFF page (IFD ${missing}) its OME-XML assigns to no channel; save the channels as one OME-TIFF with tifffile or Fiji.`);
    return { format: "OME-TIFF", names: ifds.map((ifd) => names[map.get(ifd)]) };
  }
  if (description.startsWith("ImageJ=")) {
    const field = (key) => Number(new RegExp(`^${key}=(\\d+)`, "m").exec(description)?.[1] ?? 1);
    if (field("slices") > 1 || field("frames") > 1) {
      throw new Error(`${name} is an ImageJ ${field("slices") > 1 ? "Z-stack" : "time series"}; save one 2D plane to segment.`);
    }
    return { format: "ImageJ TIFF", names: field("channels") === pages && pages > 1 ? Array.from({ length: pages }, (_, i) => `Channel ${i + 1}`) : null };
  }
  return null;
}

async function tagValue(directory, tag, fallback) {
  return directory.hasTag(tag) ? directory.loadValue(tag) : fallback;
}

/**
 * What each sample of a TIFF page is: red, green and blue for the first three samples of an RGB
 * page, "alpha" for an ExtraSamples alpha, and its own channel otherwise (a MinIsBlack page with
 * four fluorescence samples has four channels).
 */
async function sampleKinds(image) {
  const directory = image.fileDirectory;
  const count = image.getSamplesPerPixel();
  const photometric = Number(await tagValue(directory, "PhotometricInterpretation", 1));
  if (photometric === PHOTOMETRIC_PALETTE) return RGB;
  const base = photometric === PHOTOMETRIC_RGB && count >= 3 ? 3 : Math.min(1, count);
  const extra = extraSamples(await tagValue(directory, "ExtraSamples", null));
  return Array.from({ length: count }, (_, sample) => {
    if (sample < base) return base === 3 ? RGB[sample] : "sample 1";
    return ALPHA.has(extra[sample - base]) ? "alpha" : `sample ${sample + 1}`;
  });
}

/** ExtraSamples as numbers: geotiff gives one value as a number and several as a typed array. */
export function extraSamples(value) {
  if (value == null) return [];
  if (typeof value === "number") return [value];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, Number);
  throw new Error(`Unexpected ExtraSamples value ${String(value)}.`);
}

async function readTiff(name, buffer) {
  const tiff = await fromArrayBuffer(buffer);
  const count = await tiff.getImageCount();
  const pages = [];
  const ifds = [];
  for (let index = 0; index < count; index++) {
    const image = await tiff.getImage(index);
    // Reduced-resolution pages (NewSubfileType bit 0) are pyramid levels, not planes.
    if (Number(await tagValue(image.fileDirectory, "NewSubfileType", 0)) & 1) continue;
    pages.push(image);
    ifds.push(index);
    if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; save the 2D image to segment on its own.`);
  }
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const width = pages[0].getWidth();
  const height = pages[0].getHeight();
  checkSize(name, width, height);
  const description = await tagValue(pages[0].fileDirectory, "ImageDescription", null);
  const layout = describedLayout(name, description == null ? null : String(description), ifds);
  const kinds = [];
  let bytes = 0;
  for (const image of pages) {
    if (image.getWidth() !== width || image.getHeight() !== height) {
      throw new Error(`${name} has pages of different sizes; save the 2D image to segment on its own.`);
    }
    const pageKinds = await sampleKinds(image);
    kinds.push(pageKinds);
    const palette = Number(await tagValue(image.fileDirectory, "PhotometricInterpretation", 1)) === PHOTOMETRIC_PALETTE;
    // Decoded size, not stored size: geotiff widens some samples (float16 to Float32Array).
    for (let sample = 0; sample < image.getSamplesPerPixel(); sample++) {
      bytes += width * height * (palette ? 3 * 2 : image.getArrayForSample(sample, 1).BYTES_PER_ELEMENT);
    }
  }
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 30).toFixed(1)} GB of pixels in ${pages.length} pages; save the 2D image to segment on its own.`);
  }
  const planes = [];
  for (const [index, image] of pages.entries()) {
    const palette = kinds[index] === RGB && image.getSamplesPerPixel() === 1;
    const samples = palette ? splitRgb(await image.readRGB({ interleave: true }), width * height) : await image.readRasters({ interleave: false });
    const kept = kinds[index].filter((kind) => kind !== "alpha").length;
    samples.forEach((data, sample) => {
      if (kinds[index][sample] === "alpha") return;
      const page = layout?.names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = kept > 1 ? kinds[index][sample] : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", kind: kinds[index][sample], data });
    });
  }
  return { width, height, format: layout?.format ?? "TIFF", planes };
}

function splitRgb(data, count) {
  return [0, 1, 2].map((c) => {
    const plane = new data.constructor(count);
    for (let i = 0; i < count; i++) plane[i] = data[i * 3 + c];
    return plane;
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
    planes.push({ label: colour ? RGB[c] : "Intensity", kind: colour ? RGB[c] : "sample 1", data: plane });
  }
  return { width: png.width, height: png.height, format: "PNG", planes };
}

/**
 * Reads a 2D image into its planes: TIFF pages and samples, OME-TIFF or ImageJ channels, or PNG
 * channels (alpha left out). Every plane is width × height values of the file's type.
 */
export async function readImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPng(name, buffer);
  if (isTiff(bytes)) return readTiff(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF or PNG image.`);
}

/**
 * What the model sees for a choice of channel: one plane (replicated to three channels, as
 * micro-sam does for greyscale), or the image's red, green and blue planes together.
 */
export function channelChoices(image) {
  const choices = image.planes.map((plane, index) => ({ id: String(index), label: plane.label, planes: [plane] }));
  const rgb = RGB.map((kind) => image.planes.find((plane) => plane.kind === kind));
  if (rgb.every(Boolean)) choices.unshift({ id: "rgb", label: "Colour (RGB)", planes: rgb });
  return choices;
}

/**
 * An uncompressed single-strip little-endian TIFF of the label image: unsigned 16-bit when the
 * labels fit, 32-bit otherwise. Values are the object ids of the CSV table, 0 is background.
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
