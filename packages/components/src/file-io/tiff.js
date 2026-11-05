// Multi-page greyscale TIFF stacks (baseline, ImageJ and OME-TIFF): read with geotiff, written
// as uncompressed little-endian baseline TIFF that ImageJ, Fiji, tifffile and geotiff open.
// `openTiffPages` (at the end) reads page by page and keeps RGB samples apart instead.
//
// A stack is one plane per page, in page order, all the same size and sample type. The reader
// refuses multi-sample pages (RGB, grey + alpha, extra samples) and palette images rather than
// guessing a channel, and refuses a stack whose decoded size is above `maxBytes` from the page
// directories alone, before any pixel is decoded. `rgb: 'mean'` reads RGB pages as the mean of
// their red, green and blue samples instead, as ImageJ converts RGB to 8-bit.
import { GeoTIFF, fromArrayBuffer, fromBlob } from 'geotiff';
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

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML character and predefined entity references decoded (`&#181;m` is `µm`). */
export function decodeXml(value) {
  return value.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (reference, hex, decimal, name) => {
    if (hex || decimal) return String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10));
    return ENTITIES[name] ?? reference;
  });
}

/** An XML start tag's attribute, in either quote form, with entities decoded. */
function xmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? decodeXml(match[1] ?? match[2]) : undefined;
}

/** OME-XML `Pixels` attributes, whatever the namespace prefix (`<Pixels>`, `<ome:Pixels>`). */
export function parseOmeDescription(description) {
  const text = String(description ?? '');
  if (!/<(?:[\w.-]+:)?OME\b/.test(text)) return null;
  const images = text.match(/<(?:[\w.-]+:)?Image\b[^>]*>/g) ?? [];
  const pixels = text.match(/<(?:[\w.-]+:)?Pixels\b[^>]*>/)?.[0];
  if (!pixels) return null;
  const attribute = (name) => xmlAttribute(pixels, name);
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
    declaredSpacing: { x: finite(attribute('PhysicalSizeX')), y: finite(attribute('PhysicalSizeY')), z: finite(attribute('PhysicalSizeZ')), unit: attribute('PhysicalSizeXUnit') ?? 'µm' },
    frameInterval: increment && timeScale ? increment * timeScale : null,
    stagePosition: omeStagePosition(text),
  };
}

/**
 * The stage position of the first image's first plane (TheZ, TheC and TheT 0, the OME
 * default when absent), in micrometres (z is null when absent), or null when that plane does
 * not record x and y. Positions of other planes or other images are never used: a position
 * recorded only at a later z plane is not the stack's origin. A position without a unit is
 * taken as micrometres.
 */
function omeStagePosition(text) {
  const image = text.match(/<(?:[\w.-]+:)?Image\b[\s\S]*?<\/(?:[\w.-]+:)?Image\s*>/)?.[0];
  const pixels = image?.match(/<(?:[\w.-]+:)?Pixels\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?Pixels\s*>)/)?.[0];
  if (!pixels) return null;
  const index = (plane, name) => Number(xmlAttribute(plane, name) ?? 0);
  const first = (pixels.match(/<(?:[\w.-]+:)?Plane\b[^>]*>/g) ?? [])
    .find((plane) => index(plane, 'TheZ') === 0 && index(plane, 'TheC') === 0 && index(plane, 'TheT') === 0);
  if (!first) return null;
  const axis = (name) => {
    const raw = xmlAttribute(first, `Position${name}`);
    if (raw === undefined || raw.trim() === '') return null;
    const value = Number(raw);
    const scale = micrometresPerUnit(xmlAttribute(first, `Position${name}Unit`) ?? 'µm');
    return Number.isFinite(value) && scale ? value * scale : null;
  };
  const x = axis('X');
  const y = axis('Y');
  return x !== null && y !== null ? { x, y, z: axis('Z') } : null;
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
  const hyperstack = /^hyperstack=true\s*$/m.test(text);
  return {
    kind: 'imagej',
    // ImageJ writes `slices=N` for any stack it has not labelled; only a hyperstack or an
    // explicit `frames=` says which axis the pages are on.
    unlabelledStack: !hyperstack && field('frames') === undefined,
    images: 1,
    sizeC: Number(field('channels') ?? 1),
    sizeZ: Number(field('slices') ?? 1),
    sizeT: Number(field('frames') ?? 1),
    pixelSize: scale ? { x: x ? x * scale : null, y: y ? y * scale : null, z: spacing ? spacing * scale : null } : { x: null, y: null, z: null },
    declaredSpacing: { x, y, z: spacing, unit: field('unit') ?? null },
    frameInterval: interval && timeScale ? interval * timeScale : fps ? 1 / fps : null,
    stagePosition: null,
  };
}

function isRgb(image) {
  return image.fileDirectory.getValue('PhotometricInterpretation') === 2 && image.getSamplesPerPixel() >= 3;
}

function describeRefusal(image, rgb) {
  const samples = image.getSamplesPerPixel();
  const photometric = image.fileDirectory.getValue('PhotometricInterpretation');
  if (rgb === 'mean' && isRgb(image)) return null;
  if (photometric === 3) return 'This TIFF is a palette (indexed colour) image; save it as greyscale.';
  if (samples > 1) {
    const kind = PHOTOMETRIC[photometric] ?? 'multi-sample';
    return `This TIFF stores ${samples} samples per pixel (${kind}); save one greyscale channel as its own stack.`;
  }
  if (photometric === 0) return 'This TIFF is stored white-is-zero; save it as a black-is-zero greyscale stack.';
  if (photometric !== undefined && photometric !== 1) return `This TIFF's photometric interpretation (${PHOTOMETRIC[photometric] ?? photometric}) is not greyscale.`;
  return null;
}

/**
 * A geotiff source that reads only the byte ranges geotiff asks for, so the page directories
 * of a File are parsed without reading its pixels. geotiff's `fromBlob` needs FileReader.
 */
function blobSource(blob) {
  return {
    fileSize: blob.size,
    fetch: (slices) => Promise.all(slices.map(({ offset, length }) => blob.slice(offset, offset + length).arrayBuffer())),
    close() {},
  };
}

const RESOLUTION_UNITS = { 2: 'inch', 3: 'centimeter' };

/**
 * A plain TIFF's pixel size from XResolution/YResolution, in the ResolutionUnit it names (null
 * for none). Many writers put a nominal 72 dpi here, so it is a ratio, never a calibration.
 */
function baselineSpacing(image, resolution) {
  const [x, y] = resolution.map((value) => (finite(value) ? 1 / value : null));
  return { x, y, z: null, unit: RESOLUTION_UNITS[image.fileDirectory.getValue('ResolutionUnit') ?? 2] ?? null };
}

async function openStack(source, rgb) {
  const tiff = source instanceof Blob ? await GeoTIFF.fromSource(blobSource(source)) : await fromArrayBuffer(source);
  const pages = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const refusal = describeRefusal(first, rgb);
  if (refusal) throw new Error(refusal);
  const format = first.getSampleFormat();
  const bits = first.getBitsPerSample();
  const Type = TYPES[`${format}:${bits}`];
  if (!Type) throw new Error(`TIFF sample type (format ${format}, ${bits} bits) is not 8, 16 or 32-bit integer or 32/64-bit float.`);
  // geotiff keeps the NUL terminator of a value stored inline in its entry.
  const description = String((await first.fileDirectory.loadValue('ImageDescription')) ?? '').replace(/\0+$/, '');
  // A File is read range by range, so values stored past the directory load on demand.
  const resolution = [rational(await first.fileDirectory.loadValue('XResolution')), rational(await first.fileDirectory.loadValue('YResolution'))];
  const metadata = parseOmeDescription(description)
    ?? parseImagejDescription(description, resolution)
    ?? { kind: 'baseline', images: 1, sizeC: 1, sizeZ: 1, sizeT: pages, pixelSize: { x: null, y: null, z: null }, declaredSpacing: baselineSpacing(first, resolution), frameInterval: null, stagePosition: null };
  if (metadata.images > 1) throw new Error(`This OME-TIFF holds ${metadata.images} image series; save the one you need as its own file.`);
  const declared = metadata.kind === 'imagej' ? Number(description.match(/^images=(\d+)\s*$/m)?.[1]) : NaN;
  if (declared && declared !== pages) throw new Error(`This ImageJ TIFF declares ${declared} images but holds ${pages} pages; save it again from ImageJ or Fiji.`);
  const info = { width: first.getWidth(), height: first.getHeight(), pages, dtype: dtypeName(Type), bytesPerSample: Type.BYTES_PER_ELEMENT, samplesPerPixel: first.getSamplesPerPixel(), metadata: { ...metadata, description } };
  return { tiff, first, format, bits, Type, info };
}

/**
 * The size, sample type and metadata of a greyscale TIFF stack, from its page directories
 * alone (no pixel is decoded). A Blob or File is read range by range, only as far as its
 * page directories and description.
 * @param {ArrayBuffer | Blob} source
 * @param {{ rgb?: 'refuse' | 'mean' }} [options]
 */
export async function inspectTiffStack(source, { rgb = 'refuse' } = {}) {
  return (await openStack(source, rgb)).info;
}

/**
 * Reads every page of a greyscale TIFF into one typed array (page, row, column order).
 * By default the array has the file's sample type. `Type` (e.g. Float32Array) converts each
 * page straight into an array of that type, and `shared` backs it with a SharedArrayBuffer,
 * so no second whole-stack copy is made. `maxBytes` limits the size of that output array.
 * Conversion follows TypedArray assignment: an integer `Type` truncates and wraps values it
 * cannot hold (a negative float becomes a large uint16), so convert floats only to a float Type.
 * @param {ArrayBuffer} buffer
 * @param {{ signal?: AbortSignal, maxBytes?: number, Type?: Function, shared?: boolean, rgb?: 'refuse' | 'mean', onProgress?: (done: number, total: number) => void }} [options]
 */
export async function readTiffStack(buffer, { signal, maxBytes = MAX_INPUT_BYTES, Type: OutputType, shared = false, rgb = 'refuse', onProgress } = {}) {
  signal?.throwIfAborted();
  const { tiff, first, format, bits, Type, info } = await openStack(buffer, rgb);
  const { width, height, pages } = info;
  const Output = OutputType ?? Type;
  if (!SAMPLE[Output.name]) throw new Error(`Cannot read a TIFF stack into ${Output.name}.`);
  const bytes = pages * width * height * Output.BYTES_PER_ELEMENT;
  if (bytes > maxBytes) throw new InputTooLargeError(bytes, maxBytes, { subject: 'Decoded TIFF stack' });
  const data = new Output(shared ? new SharedArrayBuffer(bytes) : bytes / Output.BYTES_PER_ELEMENT);
  const plane = width * height;
  for (let page = 0; page < pages; page++) {
    signal?.throwIfAborted();
    const image = page === 0 ? first : await tiff.getImage(page);
    if (image.getWidth() !== width || image.getHeight() !== height) throw new Error(`TIFF page ${page + 1} is ${image.getWidth()} × ${image.getHeight()}, not ${width} × ${height} like page 1.`);
    if (image.getSampleFormat() !== format || image.getBitsPerSample() !== bits) throw new Error(`TIFF page ${page + 1} has a different sample type from page 1.`);
    const pageRefusal = describeRefusal(image, rgb);
    if (pageRefusal) throw new Error(`TIFF page ${page + 1}: ${pageRefusal}`);
    if (isRgb(image)) {
      const [red, green, blue] = await image.readRasters({ interleave: false, samples: [0, 1, 2], signal });
      for (let i = 0; i < plane; i++) data[page * plane + i] = (red[i] + green[i] + blue[i]) / 3;
    } else {
      const [raster] = await image.readRasters({ interleave: false, signal });
      data.set(raster, page * plane);
    }
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
 * `rgb` writes a Uint8Array of red, green, blue triplets as RGB pages.
 * @param {{ width: number, height: number, data: ArrayBufferView, description?: string, pixelSize?: { x: number, y: number } | null, rgb?: boolean }} stack
 * @returns {Uint8Array}
 */
export function writeTiffStack({ width, height, data, description = '', pixelSize = null, rgb = false }) {
  const sample = SAMPLE[data.constructor.name];
  if (!sample) throw new Error(`Cannot write ${data.constructor.name} to TIFF.`);
  if (rgb && !(data instanceof Uint8Array)) throw new Error('RGB TIFF data must be a Uint8Array.');
  const samples = rgb ? 3 : 1;
  const plane = width * height * samples;
  if (!plane || data.length % plane) throw new Error(`TIFF data length ${data.length} is not a whole number of ${width} × ${height} pages.`);
  const pages = data.length / plane;
  const planeBytes = plane * data.BYTES_PER_ELEMENT;
  const text = new TextEncoder().encode(`${description}\0`);
  const hasText = description.length > 0;
  // TIFF 6.0: a value of 4 bytes or fewer sits in the entry itself, not at an offset.
  const inlineText = text.length <= 4;
  const hasResolution = Boolean(pixelSize?.x && pixelSize?.y);
  const entries = (rgb ? 10 : 11) + (hasText ? 1 : 0) + (hasResolution ? 3 : 0);
  const ifdBytes = 2 + entries * 12 + 4;
  // Resolution rationals, then the three RGB BitsPerSample values, after each IFD.
  const bitsAt = hasResolution ? 16 : 0;
  const extraBytes = bitsAt + (rgb ? 6 : 0);
  // Every IFD starts on a word boundary, so an odd plane is padded by one byte.
  const pageBytes = ifdBytes + extraBytes + planeBytes + (planeBytes % 2);
  const headerBytes = 8 + (hasText && !inlineText ? text.length + (text.length % 2) : 0);
  const total = headerBytes + pages * pageBytes;
  if (total >= 2 ** 32) throw new Error('This stack is larger than 4 GB, the classic TIFF limit.');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  if (hasText && !inlineText) out.set(text, 8);
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
      [258, 3, samples, rgb ? extra + bitsAt : sample[1]],
      [259, 3, 1, 1],
      [262, 3, 1, rgb ? 2 : 1],
      ...(hasText ? [[270, 2, text.length, 8]] : []),
      [273, 4, 1, strip],
      [277, 3, 1, samples],
      [278, 4, 1, height],
      [279, 4, 1, planeBytes],
      ...(hasResolution ? [[282, 5, 1, extra], [283, 5, 1, extra + 8], [296, 3, 1, 1]] : []),
      // Unsigned integer is the default SampleFormat, which RGB pages leave out.
      ...(rgb ? [] : [[339, 3, 1, sample[0]]]),
    ];
    view.setUint16(ifd, tags.length, true);
    tags.forEach(([tag, type, count, value], index) => {
      const at = ifd + 2 + index * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (tag === 270 && inlineText) out.set(text, at + 8);
      else if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    view.setUint32(ifd + 2 + tags.length * 12, page + 1 < pages ? ifd + pageBytes : 0, true);
    if (resolution) {
      for (const [index, value] of resolution.entries()) {
        view.setUint32(extra + index * 8, Math.round(value * 1e6), true);
        view.setUint32(extra + index * 8 + 4, 1e6, true);
      }
    }
    if (rgb) for (let k = 0; k < 3; k++) view.setUint16(extra + bitsAt + 2 * k, 8, true);
    out.set(source.subarray(page * planeBytes, (page + 1) * planeBytes), strip);
  }
  return out;
}

// Page-wise reading, for readers that keep samples apart (RGB as channels) or stream page by
// page rather than holding the whole stack, and for OME readers (fiff) that map planes
// themselves from the geotiff instance.

const OME_NAMESPACE = 'http://www.openmicroscopy.org/Schemas/OME/';
const PHOTOMETRIC_NAMES = { 0: 'min-is-white', 1: 'min-is-black', 2: 'rgb', 3: 'palette', 4: 'mask', 5: 'separated', 6: 'ycbcr', 8: 'cielab' };

/**
 * The OME-XML in an ImageDescription as regex-based OME readers such as fiff expect it: a
 * namespace prefix (`<ome:OME xmlns:ome=…>`) moved to the default namespace and single-quoted
 * attributes double-quoted. Null when the description is not OME-XML.
 */
export function omeXml(description) {
  if (typeof description !== 'string') return null;
  let text = description.replace(/\0+$/, '');
  const root = text.match(/<([A-Za-z_][\w.-]*:)?OME[\s>]/);
  if (!root || !text.includes(OME_NAMESPACE)) return null;
  const prefix = root[1]?.slice(0, -1);
  if (prefix) {
    text = text
      .replace(new RegExp(`<(/?)${prefix}:`, 'g'), '<$1')
      .replace(new RegExp(`xmlns:${prefix}=`, 'g'), 'xmlns=');
  }
  // Inside start tags only: single-quoted values become double-quoted, their quotes escaped.
  return text.replace(/<[^!?/][^>]*>/g, (tag) => tag.replace(/(\s[\w:.-]+\s*=\s*)'([^']*)'/g, (_, name, value) => `${name}"${value.replace(/"/g, '&quot;')}"`));
}

/**
 * The role of each sample in a pixel: 'red', 'green', 'blue' for the first three samples of
 * an RGB image, 'alpha' for an ExtraSamples entry of 1 or 2, otherwise 'value' (one channel
 * each). Palette, YCbCr, CMYK and CIELab images return null: their samples are not intensities.
 */
export function sampleRoles(photometric, samplesPerPixel, extraSamples = []) {
  if (![0, 1, 2].includes(photometric)) return null;
  // The base samples (three for RGB, one for greyscale) come first; ExtraSamples describes the rest.
  const base = photometric === 2 ? 3 : 1;
  if (samplesPerPixel < base) return null;
  const roles = [];
  for (let sample = 0; sample < samplesPerPixel; sample += 1) {
    if (photometric === 2 && sample < base) roles.push(['red', 'green', 'blue'][sample]);
    else if (sample < base) roles.push('value');
    else roles.push([1, 2].includes(extraSamples[sample - base]) ? 'alpha' : 'value');
  }
  return roles;
}

const tagValue = async (image, name) => (image.fileDirectory.hasTag(name) ? image.fileDirectory.loadValue(name) : undefined);

async function describePage(image) {
  const format = image.getSampleFormat() ?? 1;
  const bits = image.getBitsPerSample();
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    samplesPerPixel: image.getSamplesPerPixel(),
    bitsPerSample: bits,
    Type: TYPES[`${format}:${bits}`] ?? null,
    photometric: Number(await tagValue(image, 'PhotometricInterpretation') ?? 1),
    extraSamples: Array.from(await tagValue(image, 'ExtraSamples') ?? []).map(Number),
    reduced: Boolean(Number(await tagValue(image, 'NewSubfileType') ?? 0) & 1),
  };
}

/**
 * Open a TIFF (Blob or ArrayBuffer) as its full-resolution pages, without decoding pixels.
 * Reduced-resolution pages (thumbnails, flat pyramids) are skipped; the others must share size,
 * samples and sample type. `maxBytes` refuses a stack whose decoded pages would exceed it.
 * `metadata` is the OME or ImageJ calibration (parseOmeDescription, parseImagejDescription),
 * null for a baseline TIFF; `resolution` is X/YResolution in pixels per ResolutionUnit.
 */
export async function openTiffPages(source, { signal, maxBytes = Infinity } = {}) {
  signal?.throwIfAborted();
  // A Blob is read in slices where the browser's FileReader exists, whole elsewhere (Node).
  const tiff = source instanceof Blob && typeof FileReader === 'function'
    ? await fromBlob(source, signal)
    : await fromArrayBuffer(source instanceof Blob ? await source.arrayBuffer() : source, signal);
  const count = await tiff.getImageCount();
  const pages = [];
  let first = null;
  for (let index = 0; index < count; index += 1) {
    signal?.throwIfAborted();
    const image = await tiff.getImage(index);
    const page = await describePage(image);
    if (page.reduced) continue;
    first ??= { ...page, image };
    for (const key of ['width', 'height', 'samplesPerPixel', 'bitsPerSample', 'Type', 'photometric']) {
      if (page[key] !== first[key]) throw new Error(`TIFF page ${index + 1} differs from page 1 in ${key === 'Type' ? 'sample type' : key}; only stacks of equal pages can be read.`);
    }
    pages.push(image);
  }
  if (!first) throw new Error('The TIFF has no full-resolution page.');
  if (!first.Type) throw new Error(`TIFF samples of ${first.bitsPerSample} bits are not supported; use 8, 16 or 32-bit integer or 32/64-bit float samples.`);
  const roles = sampleRoles(first.photometric, first.samplesPerPixel, first.extraSamples);
  if (!roles) throw new Error(`TIFF ${PHOTOMETRIC_NAMES[first.photometric] ?? `photometric ${first.photometric}`} images are not supported; save them as greyscale or RGB.`);
  const bytes = pages.length * first.samplesPerPixel * first.width * first.height * first.Type.BYTES_PER_ELEMENT;
  if (bytes > maxBytes) throw new InputTooLargeError(bytes, maxBytes, { subject: 'The decoded TIFF stack' });
  const description = await tagValue(first.image, 'ImageDescription');
  const text = typeof description === 'string' ? description : null;
  const resolutionUnit = Number(await tagValue(first.image, 'ResolutionUnit') ?? 2);
  const x = rational(await tagValue(first.image, 'XResolution'));
  const y = rational(await tagValue(first.image, 'YResolution'));
  const resolution = Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0
    ? { x, y, unit: { 1: null, 2: 'inch', 3: 'centimeter' }[resolutionUnit] ?? null }
    : null;
  const ome = omeXml(text) !== null;
  return {
    /** The geotiff instance the pages come from. */
    tiff,
    pageCount: pages.length,
    width: first.width,
    height: first.height,
    samplesPerPixel: first.samplesPerPixel,
    dtype: dtypeName(first.Type),
    photometric: PHOTOMETRIC_NAMES[first.photometric],
    sampleRoles: roles,
    description: text,
    ome,
    metadata: ome ? parseOmeDescription(text) : parseImagejDescription(text, resolution ? [resolution.x, resolution.y] : [null, null]),
    resolution,
    /** The samples of one page as separate row-major planes. */
    async readPage(index, { signal: pageSignal } = {}) {
      return Array.from(await pages[index].readRasters({ interleave: false, signal: pageSignal }));
    },
  };
}
