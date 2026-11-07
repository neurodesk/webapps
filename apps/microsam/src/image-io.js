// 2D light-microscopy input (TIFF, OME-TIFF, ImageJ TIFF, PNG) and the channels the model sees.
// DOM-free so Node tests can use it.
import { openTiffPlanes, parseImagejDescription, parseOmeDescription } from "@neurodesk/webapp-components/file-io/tiff";
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

/**
 * The channel each IFD holds, from the TiffData elements of a 2D OME image (Z and T are 1, so
 * the planes of one TiffData are consecutive channels). Without TiffData the IFDs are the channels
 * in order. Returns IFD index → channel index; throws on a layout it cannot interpret.
 */
function tiffDataChannels(name, ome, channels) {
  const refuse = (why) => new Error(`${name} maps its channels to TIFF pages in a way the app cannot read (${why}); save the channels as one OME-TIFF with tifffile or Fiji.`);
  const map = new Map();
  if (!ome.tiffData.length) {
    for (let c = 0; c < channels; c++) map.set(c, c);
    return map;
  }
  if (ome.tiffData.some((entry) => entry.uuid && entry.uuid !== ome.uuid)) throw refuse("planes in another file");
  for (const entry of ome.tiffData) {
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
  const ome = parseOmeDescription(description);
  if (ome) {
    if (ome.images > 1) throw new Error(`${name} holds ${ome.images} OME images; save the image to segment on its own.`);
    if (ome.sizeZ > 1 || ome.sizeT > 1) {
      throw new Error(`${name} is a ${ome.sizeZ > 1 ? "Z-stack" : "time series"} (${ome.sizeZ} slices, ${ome.sizeT} time points); save one 2D plane to segment.`);
    }
    const names = Array.from({ length: ome.sizeC }, (_, i) => ome.channels[i]?.name || `Channel ${i + 1}`);
    const onePerPage = names.length === pages && ome.channels.every((channel) => channel.samplesPerPixel === 1);
    if (!onePerPage) return { format: "OME-TIFF", names: null };
    const map = tiffDataChannels(name, ome, names.length);
    const missing = ifds.find((ifd) => !map.has(ifd));
    if (missing !== undefined) throw new Error(`${name} has a TIFF page (IFD ${missing}) its OME-XML assigns to no channel; save the channels as one OME-TIFF with tifffile or Fiji.`);
    return { format: "OME-TIFF", names: ifds.map((ifd) => names[map.get(ifd)]) };
  }
  const imagej = parseImagejDescription(description);
  if (imagej) {
    if (imagej.sizeZ > 1 || imagej.sizeT > 1) {
      throw new Error(`${name} is an ImageJ ${imagej.sizeZ > 1 ? "Z-stack" : "time series"}; save one 2D plane to segment.`);
    }
    return { format: "ImageJ TIFF", names: imagej.sizeC === pages && pages > 1 ? Array.from({ length: pages }, (_, i) => `Channel ${i + 1}`) : null };
  }
  return null;
}

async function readTiff(name, buffer) {
  const tiff = await openTiffPlanes(buffer, { pageLimit: MAX_PLANES + 1 });
  const { pages } = tiff;
  if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; save the 2D image to segment on its own.`);
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const { width, height } = pages[0];
  checkSize(name, width, height);
  const layout = describedLayout(name, tiff.description, pages.map((page) => page.ifd));
  if (pages.some((page) => page.width !== width || page.height !== height)) {
    throw new Error(`${name} has pages of different sizes; save the 2D image to segment on its own.`);
  }
  const bytes = pages.reduce((sum, page) => sum + page.decodedBytes, 0);
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 30).toFixed(1)} GB of pixels in ${pages.length} pages; save the 2D image to segment on its own.`);
  }
  const planes = [];
  for (const [index, samples] of (await tiff.readPlanes()).entries()) {
    for (const { kind, data } of samples) {
      const page = layout?.names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = samples.length > 1 ? kind : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", kind, data });
    }
  }
  return { width, height, format: layout?.format ?? "TIFF", planes };
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
