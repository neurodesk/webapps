// Multi-page greyscale TIFF stacks (baseline, ImageJ and OME-TIFF): read with geotiff, written
// as uncompressed little-endian baseline TIFF that ImageJ, Fiji, tifffile and geotiff open.
//
// A stack is one plane per page, in page order, all the same size and sample type. The reader
// refuses multi-sample pages (RGB, grey + alpha, extra samples) and palette images rather than
// guessing a channel, and refuses a stack whose decoded size is above `maxBytes` from the page
// directories alone, before any pixel is decoded. `rgb: 'mean'` reads RGB pages as the mean of
// their red, green and blue samples instead, as ImageJ converts RGB to 8-bit.
import { GeoTIFF, fromArrayBuffer } from 'geotiff';
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
function decodeXml(value) {
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

// TIFF 6.0 ResolutionUnit: 2 is the inch, 3 the centimetre (1, no unit, gives no size).
const RESOLUTION_UNIT_MICROMETRES = { 2: 25400, 3: 10000 };

// PhotometricInterpretation values readTiffImage converts to RGB through geotiff's readRGB.
const CONVERTED_TO_RGB = new Set([3, 5, 6, 8]);

// geotiff converts CMYK, YCbCr and CIELab with 8-bit arithmetic (255 − c), so only 8-bit samples
// convert correctly; a palette looks its 8 or 16-bit index up in the colour map.
const EIGHT_BIT_CONVERSIONS = new Set([5, 6, 8]);

function reducedResolution(image) {
  return (Number(image.fileDirectory.getValue('NewSubfileType') ?? 0) & 1) === 1;
}

function imagePixelSize(image, metadata) {
  const ome = metadata?.kind === 'ome' || metadata?.kind === 'imagej' ? metadata.pixelSize : null;
  if (ome?.x && ome?.y) return { x: ome.x, y: ome.y };
  const unit = RESOLUTION_UNIT_MICROMETRES[image.fileDirectory.getValue('ResolutionUnit') ?? 2];
  const x = rational(image.fileDirectory.getValue('XResolution'));
  const y = rational(image.fileDirectory.getValue('YResolution'));
  if (!unit || !(x > 0) || !(y > 0)) return null;
  return { x: unit / x, y: unit / y };
}

/** How a single TIFF image's samples become grey or RGB, or why they cannot. */
function colourLayout(image) {
  const samples = image.getSamplesPerPixel();
  const photometric = image.fileDirectory.getValue('PhotometricInterpretation') ?? 1;
  const extra = Array.from(image.fileDirectory.getValue('ExtraSamples') ?? []);
  // ExtraSamples 1 and 2 are alpha; 0 (unspecified) marks further data channels.
  const alpha = extra.filter((kind) => kind === 1 || kind === 2).length;
  if (photometric === 2) {
    if (samples - extra.length !== 3) throw new Error(`This RGB TIFF has ${samples - extra.length} colour samples per pixel, not 3; save it as 8 or 16-bit RGB.`);
    return { channels: 3, samples: [0, 1, 2], invert: false, convert: false };
  }
  if (photometric === 0 || photometric === 1) {
    if (samples - alpha !== 1) {
      throw new Error(`This TIFF stores ${samples} greyscale samples per pixel, a channel stack rather than a colour image; save one channel or an RGB image.`);
    }
    return { channels: 1, samples: [0], invert: photometric === 0, convert: false };
  }
  if (CONVERTED_TO_RGB.has(photometric)) return { channels: 3, samples: null, invert: false, convert: true, photometric };
  throw new Error(`This TIFF's photometric interpretation (${PHOTOMETRIC[photometric] ?? photometric}) is not greyscale or colour.`);
}

/**
 * Reads one 2-D image from a TIFF as greyscale or RGB: a histology section or a slide overview.
 * The first page is the image; further pages are accepted only when they are reduced-resolution
 * copies of it (pyramids, thumbnails), and a stack of full-size pages or several OME series is
 * refused. PhotometricInterpretation decides the channels: RGB (alpha and other extra samples
 * dropped), black- or white-is-zero greyscale (white-is-zero is inverted), and palette, YCbCr,
 * CMYK or CIELab converted to 8-bit RGB by geotiff (CMYK, YCbCr and CIELab only from 8-bit
 * samples; 16-bit ones are refused before decoding). Several samples on a greyscale image are a
 * channel stack and are refused. Samples are 8 or 16-bit unsigned integers, interleaved
 * (row, column, channel). The decoded size is checked against `maxBytes` from the page directory
 * before any pixel is decoded. `pixelSize` (micrometres) comes from OME-XML, ImageJ or the
 * resolution tags when they give a unit, else it is null.
 * @param {ArrayBuffer} buffer
 * @param {{ signal?: AbortSignal, maxBytes?: number }} [options]
 */
export async function readTiffImage(buffer, { signal, maxBytes = MAX_INPUT_BYTES } = {}) {
  signal?.throwIfAborted();
  const tiff = await fromArrayBuffer(buffer);
  const pages = await tiff.getImageCount();
  const image = await tiff.getImage(0);
  const width = image.getWidth();
  const height = image.getHeight();
  for (let page = 1; page < pages; page++) {
    const other = await tiff.getImage(page);
    if (!reducedResolution(other) && (other.getWidth() >= width || other.getHeight() >= height)) {
      throw new Error(`This TIFF holds ${pages} full-size pages, a stack rather than one image; save the section you need as its own file.`);
    }
  }
  const description = String((await image.fileDirectory.loadValue('ImageDescription')) ?? '').replace(/\0+$/, '');
  const resolution = [rational(image.fileDirectory.getValue('XResolution')), rational(image.fileDirectory.getValue('YResolution'))];
  const metadata = parseOmeDescription(description) ?? parseImagejDescription(description, resolution);
  if (metadata?.images > 1) throw new Error(`This OME-TIFF holds ${metadata.images} image series; save the one you need as its own file.`);
  if (metadata && (metadata.sizeZ > 1 || metadata.sizeT > 1)) throw new Error(`This TIFF is a ${metadata.sizeZ > 1 ? 'z-stack' : 'time series'}, not one image; save the section you need as its own file.`);
  const layout = colourLayout(image);
  const format = image.getSampleFormat();
  const bits = image.getBitsPerSample();
  if (format !== 1 || (bits !== 8 && bits !== 16)) throw new Error(`TIFF sample type (format ${format}, ${bits} bits) is not 8 or 16-bit unsigned; save the image as 8 or 16-bit.`);
  if (layout.convert && EIGHT_BIT_CONVERSIONS.has(layout.photometric) && bits !== 8) {
    throw new Error(`This ${bits}-bit ${PHOTOMETRIC[layout.photometric]} TIFF cannot be converted to RGB (only 8-bit ${PHOTOMETRIC[layout.photometric]} can); save it as 8 or 16-bit RGB.`);
  }
  const outputBits = layout.convert ? 8 : bits;
  const bytes = width * height * layout.channels * (outputBits / 8);
  if (bytes > maxBytes) throw new InputTooLargeError(bytes, maxBytes, { subject: 'Decoded TIFF image' });
  let data;
  if (layout.convert) {
    data = await image.readRGB({ interleave: true, enableAlpha: false, signal });
  } else {
    data = await image.readRasters({ interleave: true, samples: layout.samples, signal });
    if (layout.invert) {
      const max = 2 ** bits - 1;
      for (let i = 0; i < data.length; i++) data[i] = max - data[i];
    }
  }
  const Output = outputBits === 8 ? Uint8Array : Uint16Array;
  return {
    width,
    height,
    channels: layout.channels,
    bitsPerSample: outputBits,
    maxValue: 2 ** outputBits - 1,
    data: data instanceof Output ? data : Output.from(data),
    pixelSize: imagePixelSize(image, metadata),
    metadata: { kind: metadata?.kind ?? 'baseline', description },
  };
}
