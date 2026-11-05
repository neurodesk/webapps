// TIFF input and output. Reading is geotiff's; writing is a small baseline TIFF writer for the
// maps (float32 or RGB 8-bit, one uncompressed strip per page, ImageJ stack description), so
// Fiji opens a map as a stack with its voxel size.
import { fromArrayBuffer } from "geotiff";

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

/**
 * One greyscale image or stack from a TIFF: { data: Float64Array, dims, spacing, unit }.
 * Colour pages become the mean of their channels (ImageJ's RGB to 8-bit conversion);
 * ImageJ hyperstacks with several channels or frames are refused.
 */
export async function readTiff(buffer) {
  const tiff = await fromArrayBuffer(buffer);
  const first = await tiff.getImage(0);
  const nx = first.getWidth();
  const ny = first.getHeight();
  const tag = (name) => first.fileDirectory.loadValue(name);
  const description = imageJDescription(await tag("ImageDescription"));
  if (description && (Number(description.channels) > 1 || Number(description.frames) > 1)) {
    throw new Error("This TIFF is a hyperstack with several channels or time points. Save one channel and one time point as a stack.");
  }
  const count = await tiff.getImageCount();
  const pages = [];
  for (let index = 0; index < count; index++) {
    const image = index === 0 ? first : await tiff.getImage(index);
    // Pyramid levels and thumbnails are smaller pages: the stack is the pages of the first size.
    if (image.getWidth() !== nx || image.getHeight() !== ny) continue;
    pages.push(image);
  }
  const nz = pages.length;
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
  const xResolution = rational(await tag("XResolution"));
  const yResolution = rational(await tag("YResolution"));
  const dx = xResolution > 0 ? 1 / xResolution : 1;
  const dy = yResolution > 0 ? 1 / yResolution : dx;
  const dz = Number(description?.spacing) > 0 ? Math.abs(Number(description.spacing)) : dx;
  const unit = description?.unit ?? (xResolution > 0 ? RESOLUTION_UNITS[await tag("ResolutionUnit")] : null) ?? "pixel";
  return { data, dims: [nx, ny, nz], spacing: [dx, dy, dz], unit };
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
