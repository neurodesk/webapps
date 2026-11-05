// TIFF input and output. Reading is geotiff's; writing is a small baseline TIFF writer for the
// maps (float32 or RGB 8-bit, one uncompressed strip per page, ImageJ stack description), so
// Fiji opens a map as a stack with its voxel size.
import { GeoTIFF, fromArrayBuffer } from "geotiff";

const RESOLUTION_UNITS = { 2: "inch", 3: "cm" };

function imageJDescription(text) {
  if (!text?.startsWith("ImageJ=")) return null;
  const fields = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

function rational(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value[1] ? value[0] / value[1] : 0;
  return Number(value) || 0;
}

// Lengths in micrometres, for converting OME-XML physical sizes to one unit.
const MICROMETRES = { pm: 1e-6, nm: 1e-3, "µm": 1, "μm": 1, um: 1, micron: 1, mm: 1e3, cm: 1e4, m: 1e6 };

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] !== "#") return XML_ENTITIES[name] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return String.fromCodePoint(code);
  });
}

function xmlAttributes(text) {
  const attributes = {};
  for (const [, name, , value] of text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) attributes[name.replace(/^\w+:/, "")] = xmlText(value);
  return attributes;
}

/**
 * The image layout an OME-XML description declares: { channels, frames, slices, spacing, unit }.
 * Element names may carry any namespace prefix (`<ome:Pixels>`). Returns null for other text.
 */
export function omeDescription(text) {
  if (typeof text !== "string" || !/<(?:\w+:)?OME[\s>]/.test(text)) return null;
  const images = [...text.matchAll(/<(?:\w+:)?Image\b[^>]*>/g)].length;
  if (images > 1) throw new Error(`This OME-TIFF holds ${images} image series. In Fiji, open the series you want, save it as TIFF and load that.`);
  const pixels = text.match(/<(?:\w+:)?Pixels\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?Pixels>)/);
  if (!pixels) return null;
  const attributes = xmlAttributes(pixels[1]);
  const size = (name) => Number(attributes[name]) || 1;
  // A colour image is one Channel element with several samples per pixel.
  const channelElements = [...(pixels[3] ?? "").matchAll(/<(?:\w+:)?Channel\b/g)].length;
  const lengths = ["X", "Y", "Z"].map((axis) => {
    const value = Number(attributes[`PhysicalSize${axis}`]);
    return value > 0 ? { value, unit: attributes[`PhysicalSize${axis}Unit`] ?? "µm" } : null;
  });
  const unit = lengths[0]?.unit ?? null;
  const inUnit = (length) => (length.unit === unit ? length.value : length.value * (MICROMETRES[length.unit] ?? NaN) / (MICROMETRES[unit] ?? NaN));
  const spacing = lengths.map((length) => (length && unit ? inUnit(length) : null));
  return {
    channels: channelElements || size("SizeC"),
    frames: size("SizeT"),
    slices: size("SizeZ"),
    spacing: spacing.map((value) => (value > 0 ? value : null)),
    unit,
  };
}

/**
 * A geotiff source that reads only the byte ranges geotiff asks for, so headers are parsed
 * without reading the file. geotiff's `fromBlob` does the same through FileReader, which Node lacks.
 */
function blobSource(blob) {
  return {
    fileSize: blob.size,
    fetch: (slices) => Promise.all(slices.map(({ offset, length }) => blob.slice(offset, offset + length).arrayBuffer())),
    close() {},
  };
}

/**
 * The layout of a TIFF (a Blob, read range by range, or an ArrayBuffer) from its headers alone,
 * without decoding pixels: { dims, spacing, unit, pages } where `pages` are the geotiff images
 * of the stack. Hyperstacks with several channels or time points (ImageJ or OME-XML) are refused.
 */
export async function tiffLayout(source) {
  const tiff = source instanceof Blob ? await GeoTIFF.fromSource(blobSource(source)) : await fromArrayBuffer(source);
  const first = await tiff.getImage(0);
  const nx = first.getWidth();
  const ny = first.getHeight();
  const tag = (name) => first.fileDirectory.loadValue(name);
  const text = await tag("ImageDescription");
  const imagej = imageJDescription(text);
  const ome = omeDescription(text);
  const channels = ome?.channels ?? Number(imagej?.channels ?? 1);
  const frames = ome?.frames ?? Number(imagej?.frames ?? 1);
  if (channels > 1 || frames > 1) {
    const parts = [channels > 1 ? `${channels} channels` : null, frames > 1 ? `${frames} time points` : null].filter(Boolean).join(" and ");
    throw new Error(`This TIFF is a hyperstack with ${parts}. In Fiji, use Image › Duplicate with one channel and one time point, save it as TIFF and load that.`);
  }
  const count = await tiff.getImageCount();
  const pages = [];
  for (let index = 0; index < count; index++) {
    const image = index === 0 ? first : await tiff.getImage(index);
    // Pyramid levels and thumbnails are smaller pages: the stack is the pages of the first size.
    if (image.getWidth() !== nx || image.getHeight() !== ny) continue;
    pages.push(image);
  }
  if (ome && pages.length < ome.slices) {
    throw new Error(`This OME-TIFF declares ${ome.slices} planes but holds ${pages.length}; its other planes are in other files. Save the stack as one TIFF.`);
  }
  if (ome) pages.length = ome.slices;
  const xResolution = rational(await tag("XResolution"));
  const yResolution = rational(await tag("YResolution"));
  let dx = xResolution > 0 ? 1 / xResolution : 1;
  let dy = yResolution > 0 ? 1 / yResolution : dx;
  let dz = Number(imagej?.spacing) > 0 ? Math.abs(Number(imagej.spacing)) : dx;
  let unit = imagej?.unit ?? (xResolution > 0 ? RESOLUTION_UNITS[await tag("ResolutionUnit")] : null) ?? "pixel";
  if (ome?.unit && ome.spacing[0]) {
    [dx, dy, dz] = [ome.spacing[0], ome.spacing[1] ?? ome.spacing[0], ome.spacing[2] ?? ome.spacing[0]];
    unit = ome.unit;
  }
  return { dims: [nx, ny, pages.length], spacing: [dx, dy, dz], unit, pages };
}

/**
 * One greyscale image or stack from a TIFF layout (`tiffLayout`): { data: Float64Array, dims, spacing, unit }.
 * Colour pages become the mean of their channels (ImageJ's RGB to 8-bit conversion).
 */
export async function readTiffPages({ dims, spacing, unit, pages }) {
  const [nx, ny, nz] = dims;
  const data = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const samples = pages[z].getSamplesPerPixel();
    const channels = Math.min(samples, 3);
    const raster = await pages[z].readRasters({ interleave: true });
    const offset = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += raster[i * samples + c];
      data[offset + i] = sum / channels;
    }
  }
  return { data, dims, spacing, unit };
}

/** One greyscale image or stack from TIFF bytes; see `tiffLayout` and `readTiffPages`. */
export async function readTiff(buffer) {
  return readTiffPages(await tiffLayout(buffer));
}

const TYPE = { SHORT: 3, LONG: 4, RATIONAL: 5, ASCII: 2 };

/** Integer numerator and denominator for a positive resolution, as TIFF RATIONAL. */
function toRational(value) {
  let denominator = 1;
  while (denominator < 1e6 && Math.abs(Math.round(value * denominator) - value * denominator) > 1e-9 * value * denominator) denominator *= 10;
  let numerator = Math.round(value * denominator);
  while (numerator > 0xffffffff) {
    numerator = Math.round(numerator / 10);
    denominator = Math.max(1, Math.round(denominator / 10));
  }
  return [numerator, denominator];
}

/**
 * Writes a little-endian TIFF. `data` is Float32Array (one sample per voxel) or Uint8Array of
 * RGB triplets (`rgb: true`), x fastest, then y, then z, one page per z.
 */
export function writeTiff({ data, dims, spacing = [1, 1, 1], unit = "pixel", rgb = false }) {
  const [nx, ny, nz] = dims;
  const samples = rgb ? 3 : 1;
  const bytesPerSample = rgb ? 1 : 4;
  if (data.length !== nx * ny * nz * samples) throw new Error("TIFF data do not match the dimensions.");
  const pageBytes = nx * ny * samples * bytesPerSample;
  const description = [
    "ImageJ=1.54f",
    `images=${nz}`,
    ...(nz > 1 ? [`slices=${nz}`, `spacing=${spacing[2]}`] : []),
    `unit=${unit === "pixel" ? "pixel" : unit}`,
    "",
  ].join("\n") + "\0";
  const entries = rgb ? 13 : 14;
  const ifdBytes = 2 + entries * 12 + 4;
  // Word-aligned offsets: the description is padded to an even length.
  const descriptionBytes = description.length + (description.length % 2);
  const extraBytes = descriptionBytes + 16 + 6;
  const stride = ifdBytes + extraBytes;
  const headerBytes = 8;
  const dataStart = headerBytes + nz * stride;
  const buffer = new ArrayBuffer(dataStart + nz * pageBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, headerBytes, true);
  const xResolution = toRational(1 / spacing[0]);
  const yResolution = toRational(1 / spacing[1]);
  for (let z = 0; z < nz; z++) {
    const ifd = headerBytes + z * stride;
    const extra = ifd + ifdBytes;
    const descriptionAt = extra;
    const xAt = extra + descriptionBytes;
    const yAt = xAt + 8;
    const bitsAt = yAt + 8;
    const stripAt = dataStart + z * pageBytes;
    const tags = [
      [254, TYPE.LONG, 1, 0],
      [256, TYPE.LONG, 1, nx],
      [257, TYPE.LONG, 1, ny],
      [258, TYPE.SHORT, samples, rgb ? bitsAt : 32],
      [259, TYPE.SHORT, 1, 1],
      [262, TYPE.SHORT, 1, rgb ? 2 : 1],
      [270, TYPE.ASCII, description.length, descriptionAt],
      [273, TYPE.LONG, 1, stripAt],
      [277, TYPE.SHORT, 1, samples],
      [278, TYPE.LONG, 1, ny],
      [279, TYPE.LONG, 1, pageBytes],
      [282, TYPE.RATIONAL, 1, xAt],
      [283, TYPE.RATIONAL, 1, yAt],
      // SampleFormat IEEE float; unsigned integers (RGB) are the default and need no tag.
      ...(rgb ? [] : [[339, TYPE.SHORT, 1, 3]]),
    ];
    view.setUint16(ifd, tags.length, true);
    tags.forEach(([code, type, count, value], k) => {
      const at = ifd + 2 + k * 12;
      view.setUint16(at, code, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === TYPE.SHORT && count === 1) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    view.setUint32(ifd + 2 + tags.length * 12, z + 1 < nz ? headerBytes + (z + 1) * stride : 0, true);
    for (let i = 0; i < description.length; i++) bytes[descriptionAt + i] = description.charCodeAt(i);
    view.setUint32(xAt, xResolution[0], true);
    view.setUint32(xAt + 4, xResolution[1], true);
    view.setUint32(yAt, yResolution[0], true);
    view.setUint32(yAt + 4, yResolution[1], true);
    for (let c = 0; c < 3; c++) view.setUint16(bitsAt + 2 * c, 8, true);
    if (rgb) bytes.set(data.subarray(z * pageBytes, (z + 1) * pageBytes), stripAt);
    else for (let i = 0; i < nx * ny; i++) view.setFloat32(stripAt + 4 * i, data[z * nx * ny + i], true);
  }
  return buffer;
}
