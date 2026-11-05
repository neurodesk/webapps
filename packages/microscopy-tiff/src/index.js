// Single-channel microscopy stacks from TIFF, OME-TIFF and ImageJ TIFF, and float32 ImageJ
// TIFF output. geotiff decodes the pixels (every compression it supports); this module decides
// what the pages mean: which samples are intensity, how the pages form a z stack, and the voxel
// size in micrometres from OME-XML, ImageJ metadata or the resolution tags.
import { fromArrayBuffer } from "geotiff";

/** Decoded bytes a stack may need before the reader refuses it (1 GiB). */
export const DEFAULT_MAX_BYTES = 2 ** 30;

const PHOTOMETRIC = Object.freeze({ 0: "WhiteIsZero", 1: "BlackIsZero", 2: "RGB", 3: "Palette", 4: "TransparencyMask", 5: "CMYK", 6: "YCbCr", 8: "CIELab" });
const TYPES = Object.freeze({
  "1:8": ["uint8", Uint8Array],
  "2:8": ["int8", Int8Array],
  "1:16": ["uint16", Uint16Array],
  "2:16": ["int16", Int16Array],
  "1:32": ["uint32", Uint32Array],
  "2:32": ["int32", Int32Array],
  "3:32": ["float32", Float32Array],
  "3:64": ["float64", Float64Array],
});
/** Length units of OME `PhysicalSize*Unit` and ImageJ `unit=`, in micrometres. */
const UNIT_UM = Object.freeze({
  m: 1e6,
  cm: 1e4,
  mm: 1e3,
  "µm": 1,
  "μm": 1,
  um: 1,
  micron: 1,
  microns: 1,
  "\\u00B5m": 1,
  nm: 1e-3,
  "Å": 1e-4,
  angstrom: 1e-4,
});

export class TiffRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "TiffRefusal";
  }
}

function unitToUm(unit) {
  if (unit === undefined || unit === null || unit === "") return 1;
  const factor = UNIT_UM[String(unit).trim()] ?? UNIT_UM[String(unit).trim().toLowerCase()];
  return factor ?? null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The attributes of the first `<Pixels>` element of OME-XML, with or without a namespace prefix. */
export function parseOmeXml(text) {
  if (typeof text !== "string" || !/<(?:[\w.-]+:)?OME[\s>]/.test(text)) return null;
  const images = text.match(/<(?:[\w.-]+:)?Image[\s>]/g) ?? [];
  const pixels = text.match(/<(?:[\w.-]+:)?Pixels\b([^>]*)>/);
  if (!pixels) return null;
  const attributes = {};
  for (const match of pixels[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].replace(/^[\w.-]+:/, "")] = match[2] ?? match[3];
  }
  return { images: images.length, attributes };
}

/** `key=value` lines of an ImageJ ImageDescription, or null. */
export function parseImageJDescription(text) {
  if (typeof text !== "string" || !text.startsWith("ImageJ=")) return null;
  const fields = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}

function rational(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const [numerator, denominator] = value;
    return denominator ? Number(numerator) / Number(denominator) : null;
  }
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function tag(image, name) {
  return image.fileDirectory.hasTag(name) ? image.fileDirectory.loadValue(name) : undefined;
}

/**
 * The intensity sample of one page, or a refusal naming what the page holds instead. ImageJ
 * saves a stack shown with a colour lookup table as Palette; its indices are the intensities,
 * so Palette is read as intensity in ImageJ files and refused elsewhere.
 */
async function pageLayout(image, index, imagej) {
  const samples = image.getSamplesPerPixel();
  const photometric = Number(await tag(image, "PhotometricInterpretation") ?? 1);
  const extraTag = await tag(image, "ExtraSamples");
  const extra = extraTag === undefined ? [] : Array.from(Array.isArray(extraTag) || ArrayBuffer.isView(extraTag) ? extraTag : [extraTag], Number);
  const name = PHOTOMETRIC[photometric] ?? `PhotometricInterpretation ${photometric}`;
  if (photometric !== 0 && photometric !== 1 && !(photometric === 3 && imagej)) {
    throw new TiffRefusal(`Page ${index + 1} is ${name} colour, not a single-channel intensity image. Export one channel as grayscale.`);
  }
  // ExtraSamples 1 and 2 are alpha, which carries no intensity; 0 (unspecified) is how
  // multichannel grayscale is stored, so those samples are further channels.
  const alpha = extra.filter((kind) => kind === 1 || kind === 2).length;
  if (samples - alpha !== 1) {
    throw new TiffRefusal(`Page ${index + 1} has ${samples - alpha} channels per pixel; export one channel per page.`);
  }
  const format = image.getSampleFormat(0);
  const bits = image.getBitsPerSample(0);
  const type = TYPES[`${format}:${bits}`];
  if (!type) throw new TiffRefusal(`Page ${index + 1} has ${bits}-bit samples of format ${format}; use 8, 16 or 32-bit integers or 32/64-bit floats.`);
  return { samples, whiteIsZero: photometric === 0, dtype: type[0], ArrayType: type[1], bytesPerSample: bits / 8 };
}

/**
 * Read a single-channel 2D or 3D stack. Returns `{ width, height, depth, dtype, data, spacingUm,
 * spacingSource, description }`: `data` is a typed array of the file's sample type, `[z][y][x]`
 * with x fastest; `spacingUm` is `{ x, y, z }` with `null` for axes the file does not calibrate.
 * WhiteIsZero pages are inverted to BlackIsZero. Throws `TiffRefusal` for files that are not one
 * channel and one time point, and before decoding when the samples would need more than
 * `maxBytes`.
 */
export async function readTiffStack(buffer, { maxBytes = DEFAULT_MAX_BYTES, signal } = {}) {
  const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  let tiff;
  try {
    tiff = await fromArrayBuffer(arrayBuffer, signal);
  } catch (error) {
    throw new TiffRefusal(`Not a readable TIFF file (${error.message}).`);
  }
  const count = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const description = (await tag(first, "ImageDescription")) ?? "";
  const ome = parseOmeXml(description);
  const imagej = parseImageJDescription(description);

  // Full-resolution pages only: NewSubfileType bit 0 marks reduced-resolution copies.
  const pages = [];
  for (let index = 0; index < count; index += 1) {
    const image = index === 0 ? first : await tiff.getImage(index);
    if (Number(await tag(image, "NewSubfileType") ?? 0) & 1) continue;
    pages.push(image);
  }
  const width = first.getWidth();
  const height = first.getHeight();
  const layouts = [];
  for (const [index, image] of pages.entries()) {
    if (image.getWidth() !== width || image.getHeight() !== height) {
      throw new TiffRefusal(`Page ${index + 1} is ${image.getWidth()} × ${image.getHeight()}, the first ${width} × ${height}; a stack needs equal pages.`);
    }
    layouts.push(await pageLayout(image, index, Boolean(imagej)));
  }
  if (layouts.some((layout) => layout.dtype !== layouts[0].dtype || layout.samples !== layouts[0].samples)) {
    throw new TiffRefusal("The pages have different sample types; a stack needs one type.");
  }

  let depth = pages.length;
  if (ome) {
    if (ome.images > 1) throw new TiffRefusal(`The OME-TIFF holds ${ome.images} images (series); export one.`);
    const sizes = Object.fromEntries(["X", "Y", "Z", "C", "T"].map((axis) => [axis, Number(ome.attributes[`Size${axis}`] ?? 1)]));
    if (sizes.C > 1 || sizes.T > 1) throw new TiffRefusal(`The OME-TIFF has ${sizes.C} channels and ${sizes.T} time points; export one channel at one time point.`);
    if (sizes.X !== width || sizes.Y !== height || sizes.Z !== pages.length) {
      throw new TiffRefusal(`The OME-XML describes ${sizes.X} × ${sizes.Y} × ${sizes.Z} but the file has ${pages.length} pages of ${width} × ${height}.`);
    }
  } else if (imagej) {
    const channels = Number(imagej.channels ?? 1);
    const frames = Number(imagej.frames ?? 1);
    if (channels > 1 || frames > 1) throw new TiffRefusal(`The ImageJ stack has ${channels} channels and ${frames} frames; save one channel at one time point.`);
    const images = Number(imagej.images ?? pages.length);
    if (images !== pages.length) throw new TiffRefusal(`The ImageJ header lists ${images} images but the file has ${pages.length} pages.`);
  }

  const layout = layouts[0];
  const total = width * height * depth * layout.samples * layout.bytesPerSample;
  if (total > maxBytes) {
    throw new TiffRefusal(`The stack needs ${(total / 2 ** 20).toFixed(0)} MB decoded, above this app's ${(maxBytes / 2 ** 20).toFixed(0)} MB limit. Crop it first.`);
  }

  const plane = width * height;
  const data = new layout.ArrayType(plane * depth);
  for (const [z, image] of pages.entries()) {
    signal?.throwIfAborted();
    const [samples] = await image.readRasters({ samples: [0], signal });
    data.set(samples, z * plane);
  }
  if (layout.whiteIsZero) {
    const top = layout.dtype.startsWith("float") ? data.reduce((max, v) => Math.max(max, v), -Infinity) : 2 ** (layout.bytesPerSample * 8) - 1;
    for (let i = 0; i < data.length; i += 1) data[i] = top - data[i];
  }

  const spacing = { spacingUm: { x: null, y: null, z: null }, spacingSource: null };
  if (ome) {
    for (const axis of ["X", "Y", "Z"]) {
      const value = positive(ome.attributes[`PhysicalSize${axis}`]);
      const factor = unitToUm(ome.attributes[`PhysicalSize${axis}Unit`]);
      if (value && factor) spacing.spacingUm[axis.toLowerCase()] = value * factor;
    }
    spacing.spacingSource = "OME-XML";
  } else {
    const factor = imagej ? unitToUm(imagej.unit) : null;
    const resolutionUnit = Number(await tag(first, "ResolutionUnit") ?? 2);
    // Pixels per unit: ImageJ's own unit, else inch (2) or centimetre (3).
    const perUnit = imagej && factor ? factor : resolutionUnit === 2 ? 25400 : resolutionUnit === 3 ? 1e4 : null;
    if (perUnit) {
      for (const [axis, name] of [["x", "XResolution"], ["y", "YResolution"]]) {
        const pixelsPerUnit = rational(await tag(first, name));
        // A resolution of 1 pixel per unit is the TIFF writer's placeholder, not a calibration.
        if (pixelsPerUnit && pixelsPerUnit > 0 && !(pixelsPerUnit === 1 && !imagej)) spacing.spacingUm[axis] = perUnit / pixelsPerUnit;
      }
    }
    if (imagej && factor && positive(imagej.spacing)) spacing.spacingUm.z = Number(imagej.spacing) * factor;
    spacing.spacingSource = imagej ? "ImageJ" : spacing.spacingUm.x ? "TIFF resolution" : null;
  }
  return { width, height, depth, dtype: layout.dtype, data, ...spacing, description };
}

function rationalParts(value) {
  // value as numerator / 1e6, within 32 bits.
  let denominator = 1000000;
  let numerator = Math.round(value * denominator);
  while (numerator > 0xffffffff) {
    denominator = Math.round(denominator / 10);
    numerator = Math.round(value * denominator);
  }
  return [numerator, denominator];
}

/**
 * An uncompressed little-endian float32 TIFF that ImageJ and Fiji open as a calibrated stack
 * (`unit=micron`, `spacing=`, X/YResolution in pixels per micrometre), one page per z plane.
 */
export function writeImageJTiff({ data, width, height, depth, spacingUm }) {
  if (!(data instanceof Float32Array) || data.length !== width * height * depth) throw new Error("writeImageJTiff needs a Float32Array of width × height × depth values.");
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const lines = ["ImageJ=1.11a", `images=${depth}`];
  if (depth > 1) lines.push(`slices=${depth}`);
  lines.push("unit=micron");
  if (spacingUm?.z) lines.push(`spacing=${spacingUm.z}`);
  lines.push("loop=false", `min=${Number.isFinite(min) ? min : 0}`, `max=${Number.isFinite(max) ? max : 0}`, "");
  const description = new TextEncoder().encode(`${lines.join("\n")}\0`);
  const planeBytes = width * height * 4;
  const entries = 15;
  const ifdBytes = 2 + entries * 12 + 4;
  const header = 8;
  const descriptionOffset = header;
  const resolutionOffset = descriptionOffset + description.length + (description.length % 2);
  const ifdStart = resolutionOffset + 16;
  const dataStart = Math.ceil((ifdStart + depth * ifdBytes) / 4) * 4;
  const total = dataStart + depth * planeBytes;
  if (total > 0xffffffff) throw new Error("The stack is too large for a classic TIFF (4 GB).");
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdStart, true);
  bytes.set(description, descriptionOffset);
  const [xNumerator, xDenominator] = rationalParts(spacingUm?.x ? 1 / spacingUm.x : 1);
  const [yNumerator, yDenominator] = rationalParts(spacingUm?.y ? 1 / spacingUm.y : 1);
  view.setUint32(resolutionOffset, xNumerator, true);
  view.setUint32(resolutionOffset + 4, xDenominator, true);
  view.setUint32(resolutionOffset + 8, yNumerator, true);
  view.setUint32(resolutionOffset + 12, yDenominator, true);
  for (let z = 0; z < depth; z += 1) {
    const offset = ifdStart + z * ifdBytes;
    const pixels = dataStart + z * planeBytes;
    // [tag, type (3 short, 4 long, 2 ascii, 5 rational), count, value or offset]
    const fields = [
      [254, 4, 1, 0],
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 32],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      [270, 2, z === 0 ? description.length : 1, z === 0 ? descriptionOffset : 0],
      [273, 4, 1, pixels],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, planeBytes],
      [282, 5, 1, resolutionOffset],
      [283, 5, 1, resolutionOffset + 8],
      [296, 3, 1, 1],
      [339, 3, 1, 3],
    ];
    view.setUint16(offset, fields.length, true);
    fields.forEach(([id, type, count, value], index) => {
      const at = offset + 2 + index * 12;
      view.setUint16(at, id, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    view.setUint32(offset + 2 + fields.length * 12, z + 1 < depth ? ifdStart + (z + 1) * ifdBytes : 0, true);
    new Float32Array(buffer, pixels, width * height).set(data.subarray(z * width * height, (z + 1) * width * height));
  }
  return buffer;
}
