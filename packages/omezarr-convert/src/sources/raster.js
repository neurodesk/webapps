// PNG and JPEG sequences: one file per Z plane, in natural name order (slice2 before slice10).
// PNG keeps its 1-16 bit greyscale or RGB values (fast-png); JPEG decodes to 8-bit RGB
// (jpeg-js). RGB whose three samples are equal in the first image is one greyscale channel.
import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { ARRAY_TYPES } from "../pyramid.js";
import { CHANNEL_COLOURS, imageStem, note } from "./source.js";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const naturalOrder = (a, b) => collator.compare(a.name, b.name);

const isJpeg = (name) => /\.jpe?g$/i.test(name);

/** 1, 2 and 4-bit PNG rows are packed, each starting on a byte; unpack one value per byte. */
export function unpackBits(data, width, height, depth) {
  if (depth >= 8) return data;
  const out = new Uint8Array(width * height);
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      out[y * width + x] = (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

/** One decoded image: { width, height, samples (per pixel, alpha removed), dtype, data, alpha, ppm }. */
export function decodeRaster(name, bytes) {
  if (isJpeg(name)) {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 2048 });
    return { width: image.width, height: image.height, samples: 3, dtype: "uint8", data: image.data, alpha: false, ppm: null };
  }
  const image = decodePng(bytes);
  if (image.palette) throw new Error(`${name} is a palette PNG; save it as greyscale or RGB.`);
  const alpha = image.channels === 2 || image.channels === 4;
  const samples = alpha ? image.channels - 1 : image.channels;
  let data = image.channels === 1 ? unpackBits(image.data, image.width, image.height, image.depth) : image.data;
  if (alpha) {
    const kept = new ARRAY_TYPES[image.depth === 16 ? "uint16" : "uint8"](image.width * image.height * samples);
    for (let i = 0, o = 0; i < data.length; i += image.channels) {
      for (let s = 0; s < samples; s += 1) kept[o++] = data[i + s];
    }
    data = kept;
  }
  // pHYs unit 1 is the metre.
  const ppm = image.resolution?.unit === 1 && image.resolution.x > 0 && image.resolution.y > 0 ? image.resolution : null;
  return { width: image.width, height: image.height, samples, dtype: image.depth === 16 ? "uint16" : "uint8", data, alpha, ppm };
}

function isGrey(image) {
  if (image.samples !== 3) return image.samples === 1;
  for (let i = 0; i < image.data.length; i += 3) {
    if (image.data[i] !== image.data[i + 1] || image.data[i] !== image.data[i + 2]) return false;
  }
  return true;
}

/** PNG or JPEG files (one per Z plane) as a source. */
export async function openRasterSequence(files, { signal } = {}) {
  if (!files.length) throw new Error("Choose at least one PNG or JPEG image.");
  const ordered = [...files].sort(naturalOrder);
  if (new Set(ordered.map((file) => isJpeg(file.name))).size > 1) throw new Error("A sequence is all PNG or all JPEG, not both.");
  const read = async (file) => decodeRaster(file.name, new Uint8Array(await file.arrayBuffer()));
  const first = await read(ordered[0]);
  signal?.throwIfAborted();
  const grey = isGrey(first);
  const channels = grey ? 1 : 3;
  const notes = [];
  if (first.alpha) notes.push(note("Alpha dropped", "The alpha channel is transparency, not intensity, and is left out."));
  if (grey && first.samples === 3) notes.push(note("Grey RGB read as one channel", "Red, green and blue are equal in the first image, so the sequence is one greyscale channel."));
  if (isJpeg(ordered[0].name)) notes.push(note("JPEG is lossy", "JPEG is lossy: the values are those of the decoded JPEG, not of the original acquisition."));
  const micrometres = first.ppm ? { y: 1e6 / first.ppm.y, x: 1e6 / first.ppm.x } : null;
  let cached = { index: 0, image: first };
  const name = imageStem(ordered[0].name).replace(/[_\-. ]*\d+$/, "") || imageStem(ordered[0].name);
  return {
    name,
    stem: name,
    format: isJpeg(ordered[0].name) ? "JPEG sequence" : "PNG sequence",
    dtype: first.dtype,
    shape: { t: 1, c: channels, z: ordered.length, y: first.height, x: first.width },
    scale: { t: null, z: null, y: micrometres?.y ?? null, x: micrometres?.x ?? null },
    units: { t: null, z: null, y: micrometres ? "micrometer" : null, x: micrometres ? "micrometer" : null },
    channels: grey ? [{ label: null, color: null }] : ["red", "green", "blue"].map((role) => ({ label: role[0].toUpperCase() + role.slice(1), color: CHANNEL_COLOURS[role] })),
    notes,
    files: ordered.map((file) => file.name),
    async readPlane(_t, c, z, { signal: planeSignal } = {}) {
      if (cached.index !== z) cached = { index: z, image: await read(ordered[z]) };
      planeSignal?.throwIfAborted();
      const image = cached.image;
      const name = ordered[z].name;
      if (image.width !== first.width || image.height !== first.height || image.dtype !== first.dtype) {
        throw new Error(`${name} is ${image.width} × ${image.height} ${image.dtype}; the sequence is ${first.width} × ${first.height} ${first.dtype}.`);
      }
      if (grey && !isGrey(image)) throw new Error(`${name} is in colour but the first image is greyscale; convert the sequence to one kind.`);
      if (!grey && image.samples !== 3) throw new Error(`${name} is greyscale but the first image is RGB; convert the sequence to one kind.`);
      const plane = new ARRAY_TYPES[image.dtype](image.width * image.height);
      const stride = image.samples;
      for (let i = 0; i < plane.length; i += 1) plane[i] = image.data[i * stride + (grey ? 0 : c)];
      return plane;
    },
  };
}
