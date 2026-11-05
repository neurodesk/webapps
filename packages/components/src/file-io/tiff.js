// Multi-page greyscale TIFF stacks (baseline, ImageJ and OME-TIFF): read with geotiff, written
// as uncompressed little-endian baseline TIFF that ImageJ, Fiji, tifffile and geotiff open.
//
// A stack is one plane per page, in page order, all the same size and sample type. The reader
// refuses multi-sample pages (RGB, grey + alpha, extra samples) and palette images rather than
// guessing a channel, and refuses a stack whose decoded size is above `maxBytes` from the page
// directories alone, before any pixel is decoded.
import { fromArrayBuffer } from 'geotiff';
import { InputTooLargeError, MAX_INPUT_BYTES } from './input-limits.js';

const TYPES = {
  '1:8': Uint8Array,
  '1:16': Uint16Array,
  '1:32': Uint32Array,
  '2:8': Int8Array,
  '2:16': Int16Array,
  '2:32': Int32Array,
  '3:32': Float32Array,
  '3:64': Float64Array,
};

const MICROMETRES = {
  pm: 1e-6,
  nm: 1e-3,
  nanometer: 1e-3,
  nanometre: 1e-3,
  'µm': 1,
  um: 1,
  micron: 1,
  microns: 1,
  micrometer: 1,
  micrometre: 1,
  mm: 1e3,
  millimeter: 1e3,
  millimetre: 1e3,
  cm: 1e4,
  m: 1e6,
};

const SECONDS = { ns: 1e-9, 'µs': 1e-6, us: 1e-6, ms: 1e-3, s: 1, sec: 1, second: 1, seconds: 1, min: 60, h: 3600 };

const PHOTOMETRIC = { 2: 'RGB', 3: 'palette', 4: 'transparency mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab' };

function normaliseUnit(unit) {
  return String(unit ?? '').trim().replace(/\\u00b5/gi, 'µ').replace(/μ/g, 'µ').toLowerCase();
}

/** A length unit's size in micrometres, or null when the unit is unknown or absent. */
export function micrometresPerUnit(unit) {
  return MICROMETRES[normaliseUnit(unit)] ?? null;
}

function secondsPerUnit(unit) {
  return SECONDS[normaliseUnit(unit)] ?? null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rational(value) {
  if (value == null) return null;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value[1] ? value[0] / value[1] : null;
  return Number(value);
}

/** OME-XML `Pixels` attributes, whatever the namespace prefix (`<Pixels>`, `<ome:Pixels>`). */
export function parseOmeDescription(description) {
  const text = String(description ?? '');
  if (!/<(?:[\w.-]+:)?OME\b/.test(text)) return null;
  const images = text.match(/<(?:[\w.-]+:)?Image\b[^>]*>/g) ?? [];
  const pixels = text.match(/<(?:[\w.-]+:)?Pixels\b[^>]*>/)?.[0];
  if (!pixels) return null;
  const attribute = (name) => pixels.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1];
  const size = (axis) => {
    const value = finite(attribute(`PhysicalSize${axis}`));
    const scale = micrometresPerUnit(attribute(`PhysicalSize${axis}Unit`) ?? 'µm');
    return value && scale ? value * scale : null;
  };
  const increment = finite(attribute('TimeIncrement'));
  const timeScale = secondsPerUnit(attribute('TimeIncrementUnit') ?? 's');
  return {
    kind: 'ome',
    images: images.length,
    dimensionOrder: attribute('DimensionOrder') ?? null,
    sizeC: Number(attribute('SizeC') ?? 1),
    sizeZ: Number(attribute('SizeZ') ?? 1),
    sizeT: Number(attribute('SizeT') ?? 1),
    pixelSize: { x: size('X'), y: size('Y'), z: size('Z') },
    frameInterval: increment && timeScale ? increment * timeScale : null,
  };
}

/** ImageJ's `ImageJ=…` description: hyperstack sizes, z spacing, frame interval and unit. */
export function parseImagejDescription(description, resolution = [null, null]) {
  const text = String(description ?? '');
  if (!text.startsWith('ImageJ=')) return null;
  const field = (name) => text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
  const scale = micrometresPerUnit(field('unit'));
  const [x, y] = resolution.map((value) => (value ? 1 / value : null));
  const spacing = finite(field('spacing'));
  const fps = finite(field('fps'));
  const timeScale = secondsPerUnit(field('tunit') ?? 's');
  const interval = finite(field('finterval'));
  return {
    kind: 'imagej',
    images: 1,
    sizeC: Number(field('channels') ?? 1),
    sizeZ: Number(field('slices') ?? 1),
    sizeT: Number(field('frames') ?? 1),
    pixelSize: scale ? { x: x ? x * scale : null, y: y ? y * scale : null, z: spacing ? spacing * scale : null } : { x: null, y: null, z: null },
    frameInterval: interval && timeScale ? interval * timeScale : fps ? 1 / fps : null,
  };
}

function describeRefusal(image) {
  const samples = image.getSamplesPerPixel();
  const photometric = image.fileDirectory.getValue('PhotometricInterpretation');
  if (photometric === 3) return 'This TIFF is a palette (indexed colour) image; save it as greyscale.';
  if (samples > 1) {
    const kind = PHOTOMETRIC[photometric] ?? 'multi-sample';
    return `This TIFF stores ${samples} samples per pixel (${kind}); save one greyscale channel as its own stack.`;
  }
  if (photometric === 0) return 'This TIFF is stored white-is-zero; save it as a black-is-zero greyscale stack.';
  if (photometric !== undefined && photometric !== 1) return `This TIFF's photometric interpretation (${PHOTOMETRIC[photometric] ?? photometric}) is not greyscale.`;
  return null;
}

async function openStack(buffer) {
  const tiff = await fromArrayBuffer(buffer);
  const pages = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const refusal = describeRefusal(first);
  if (refusal) throw new Error(refusal);
  const format = first.getSampleFormat();
  const bits = first.getBitsPerSample();
  const Type = TYPES[`${format}:${bits}`];
  if (!Type) throw new Error(`TIFF sample type (format ${format}, ${bits} bits) is not 8, 16 or 32-bit integer or 32/64-bit float.`);
  const description = String((await first.fileDirectory.loadValue('ImageDescription')) ?? '');
  const resolution = [rational(first.fileDirectory.getValue('XResolution')), rational(first.fileDirectory.getValue('YResolution'))];
  const metadata = parseOmeDescription(description)
    ?? parseImagejDescription(description, resolution)
    ?? { kind: 'baseline', images: 1, sizeC: 1, sizeZ: 1, sizeT: pages, pixelSize: { x: null, y: null, z: null }, frameInterval: null };
  const info = { width: first.getWidth(), height: first.getHeight(), pages, dtype: dtypeName(Type), bytesPerSample: Type.BYTES_PER_ELEMENT, metadata: { ...metadata, description } };
  return { tiff, first, format, bits, Type, info };
}

/**
 * The size, sample type and metadata of a greyscale TIFF stack, from its page directories
 * alone (no pixel is decoded).
 * @param {ArrayBuffer} buffer
 */
export async function inspectTiffStack(buffer) {
  return (await openStack(buffer)).info;
}

/**
 * Reads every page of a greyscale TIFF into one typed array (page, row, column order).
 * @param {ArrayBuffer} buffer
 * @param {{ signal?: AbortSignal, maxBytes?: number, onProgress?: (done: number, total: number) => void }} [options]
 */
export async function readTiffStack(buffer, { signal, maxBytes = MAX_INPUT_BYTES, onProgress } = {}) {
  signal?.throwIfAborted();
  const { tiff, first, format, bits, Type, info } = await openStack(buffer);
  const { width, height, pages } = info;
  const bytes = pages * width * height * Type.BYTES_PER_ELEMENT;
  if (bytes > maxBytes) throw new InputTooLargeError(bytes, maxBytes, { subject: 'Decoded TIFF stack' });
  const data = new Type(pages * width * height);
  const plane = width * height;
  for (let page = 0; page < pages; page++) {
    signal?.throwIfAborted();
    const image = page === 0 ? first : await tiff.getImage(page);
    if (image.getWidth() !== width || image.getHeight() !== height) throw new Error(`TIFF page ${page + 1} is ${image.getWidth()} × ${image.getHeight()}, not ${width} × ${height} like page 1.`);
    if (image.getSampleFormat() !== format || image.getBitsPerSample() !== bits) throw new Error(`TIFF page ${page + 1} has a different sample type from page 1.`);
    const pageRefusal = describeRefusal(image);
    if (pageRefusal) throw new Error(`TIFF page ${page + 1}: ${pageRefusal}`);
    const [raster] = await image.readRasters({ interleave: false, signal });
    data.set(raster, page * plane);
    onProgress?.(page + 1, pages);
  }
  return { ...info, data };
}

function dtypeName(Type) {
  return Type.name.replace('Array', '').toLowerCase();
}

const SAMPLE = {
  Uint8Array: [1, 8],
  Uint16Array: [1, 16],
  Uint32Array: [1, 32],
  Int8Array: [2, 8],
  Int16Array: [2, 16],
  Int32Array: [2, 32],
  Float32Array: [3, 32],
  Float64Array: [3, 64],
};

/** The ImageJ description that makes ImageJ and Fiji open a stack as a time series. */
export function imagejDescription({ frames, frameInterval = null, unit = null, min = null, max = null }) {
  const lines = ['ImageJ=1.11a', `images=${frames}`];
  if (frames > 1) lines.push(`frames=${frames}`);
  if (frameInterval) lines.push(`finterval=${frameInterval}`);
  if (unit) lines.push(`unit=${unit}`);
  if (min != null && max != null) lines.push(`min=${min}`, `max=${max}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Writes a stack as an uncompressed little-endian baseline TIFF, one strip per page.
 * `pixelSize` (micrometres) becomes X/YResolution with ImageJ's `unit=micron` convention.
 * @param {{ width: number, height: number, data: ArrayBufferView, description?: string, pixelSize?: { x: number, y: number } | null }} stack
 * @returns {Uint8Array}
 */
export function writeTiffStack({ width, height, data, description = '', pixelSize = null }) {
  const sample = SAMPLE[data.constructor.name];
  if (!sample) throw new Error(`Cannot write ${data.constructor.name} to TIFF.`);
  const plane = width * height;
  if (!plane || data.length % plane) throw new Error(`TIFF data length ${data.length} is not a whole number of ${width} × ${height} pages.`);
  const pages = data.length / plane;
  const planeBytes = plane * data.BYTES_PER_ELEMENT;
  const text = new TextEncoder().encode(`${description}\0`);
  const hasText = description.length > 0;
  const hasResolution = Boolean(pixelSize?.x && pixelSize?.y);
  const entries = 11 + (hasText ? 1 : 0) + (hasResolution ? 3 : 0);
  const ifdBytes = 2 + entries * 12 + 4;
  const extraBytes = hasResolution ? 16 : 0;
  // Every IFD starts on a word boundary, so an odd plane is padded by one byte.
  const pageBytes = ifdBytes + extraBytes + planeBytes + (planeBytes % 2);
  const headerBytes = 8 + (hasText ? text.length + (text.length % 2) : 0);
  const total = headerBytes + pages * pageBytes;
  if (total >= 2 ** 32) throw new Error('This stack is larger than 4 GB, the classic TIFF limit.');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  if (hasText) out.set(text, 8);
  view.setUint32(4, headerBytes, true);
  const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const resolution = hasResolution ? [1 / pixelSize.x, 1 / pixelSize.y] : null;
  for (let page = 0; page < pages; page++) {
    const ifd = headerBytes + page * pageBytes;
    const extra = ifd + ifdBytes;
    const strip = extra + extraBytes;
    const tags = [
      [254, 4, 1, 0],
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, sample[1]],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      ...(hasText ? [[270, 2, text.length, 8]] : []),
      [273, 4, 1, strip],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, planeBytes],
      ...(hasResolution ? [[282, 5, 1, extra], [283, 5, 1, extra + 8], [296, 3, 1, 1]] : []),
      [339, 3, 1, sample[0]],
    ];
    view.setUint16(ifd, tags.length, true);
    tags.forEach(([tag, type, count, value], index) => {
      const at = ifd + 2 + index * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    view.setUint32(ifd + 2 + tags.length * 12, page + 1 < pages ? ifd + pageBytes : 0, true);
    if (resolution) {
      for (const [index, value] of resolution.entries()) {
        view.setUint32(extra + index * 8, Math.round(value * 1e6), true);
        view.setUint32(extra + index * 8 + 4, 1e6, true);
      }
    }
    out.set(source.subarray(page * planeBytes, (page + 1) * planeBytes), strip);
  }
  return out;
}
