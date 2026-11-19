// The lossless export: a merged result (`job.merge`) in one file, every value with its float64 bits,
// NaN payloads and signed zeros included. README.md "Lossless export" documents the layout; the
// command line and the web app write it with writeLossless, so both give the same bytes.

const MAGIC = 'SAMSRFLX';
const PREAMBLE = 16;
export const LOSSLESS_FORMAT = 'samsrf-lossless-maps';
export const LOSSLESS_VERSION = 1;
const PRECISIONS = ['double', 'single'];

// Typed arrays are copied as bytes, never through a Number, which may not keep a NaN's bits.
if (new Uint8Array(Uint16Array.of(1).buffer)[0] !== 1) throw new Error('The lossless export needs a little-endian platform');

/** The lossless file of the map set `prefix` (`lh_pRF_Gaussian` → `lh_pRF_Gaussian_lossless.bin`). */
export function losslessName(prefix) {
  return `${prefix}_lossless.bin`;
}

function fail(message) {
  throw new Error(`lossless export: ${message}`);
}

function bytesOf(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function checkRows(name, rows, vertices) {
  if (!Array.isArray(rows?.values) || !rows.values.every((value) => typeof value === 'string')) fail(`${name}.values must be an array of row names`);
  if (rows.vertices !== vertices) fail(`${name}.vertices must be ${vertices}`);
  if (!(rows.data instanceof Float64Array) || rows.data.length !== rows.values.length * vertices) fail(`${name}.data must be a Float64Array of values.length x vertices values`);
}

/**
 * Writes a merged result, `{ maps, raw, analysed, imaginary, arithmeticReference }` as `job.merge`
 * returns it, with the model's data precision ('double' or 'single'). Returns the file's bytes.
 */
export function writeLossless({ maps, raw = null, analysed = null, imaginary = null, arithmeticReference }, { precision } = {}) {
  if (!PRECISIONS.includes(precision)) fail(`precision must be 'double' or 'single', not ${JSON.stringify(precision)}`);
  if (typeof arithmeticReference !== 'string' || !arithmeticReference) fail('arithmeticReference must name the reference');
  const vertices = maps?.vertices;
  if (!Number.isInteger(vertices) || vertices < 1) fail('maps.vertices must be a positive integer');
  checkRows('maps', maps, vertices);
  if (raw !== null) checkRows('raw', raw, vertices);
  if (imaginary !== null && (!(imaginary instanceof Float64Array) || imaginary.length !== maps.data.length)) fail('imaginary must be null or a Float64Array as long as maps.data');
  if (analysed !== null && !(analysed instanceof Uint32Array)) fail('analysed must be null or a Uint32Array');
  const header = {
    format: LOSSLESS_FORMAT,
    version: LOSSLESS_VERSION,
    precision,
    arithmeticReference,
    vertices,
    values: maps.values,
    imaginary: imaginary !== null,
    raw: raw?.values ?? [],
    analysed: analysed === null ? null : analysed.length,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  // Space padding puts the first value on an 8-byte boundary.
  const headerLength = json.length + ((8 - ((PREAMBLE + json.length) % 8)) % 8);
  const sections = [maps.data, imaginary, raw?.data, analysed].filter((section) => section != null);
  const out = new Uint8Array(PREAMBLE + headerLength + sections.reduce((sum, section) => sum + section.byteLength, 0));
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC));
  view.setUint32(8, LOSSLESS_VERSION, true);
  view.setUint32(12, headerLength, true);
  out.fill(0x20, PREAMBLE, PREAMBLE + headerLength);
  out.set(json, PREAMBLE);
  let offset = PREAMBLE + headerLength;
  for (const section of sections) {
    out.set(bytesOf(section), offset);
    offset += section.byteLength;
  }
  return out;
}

/**
 * Reads a lossless file back into `{ maps, raw, analysed, imaginary, arithmeticReference, precision }`,
 * the shape `job.merge` returns plus the precision. Throws on any other layout.
 */
export function readLossless(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('read needs a Uint8Array');
  if (bytes.length < PREAMBLE || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) fail('not a SamSrf lossless file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  if (version !== LOSSLESS_VERSION) fail(`unsupported version ${version}`);
  const headerLength = view.getUint32(12, true);
  if ((PREAMBLE + headerLength) % 8 !== 0 || PREAMBLE + headerLength > bytes.length) fail('the header length is invalid');
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREAMBLE, PREAMBLE + headerLength)));
  } catch (error) {
    fail(`the header is not JSON (${error.message})`);
  }
  const { format, version: named, precision, arithmeticReference, vertices, values, imaginary, raw, analysed } = header ?? {};
  const names = (list) => Array.isArray(list) && list.every((value) => typeof value === 'string');
  if (format !== LOSSLESS_FORMAT || named !== version) fail('the header names another format or version');
  if (!PRECISIONS.includes(precision) || typeof arithmeticReference !== 'string') fail('the header has no precision or arithmetic reference');
  if (!Number.isInteger(vertices) || vertices < 1 || !names(values) || typeof imaginary !== 'boolean' || !names(raw)) fail('the header does not describe the maps');
  if (analysed !== null && (!Number.isInteger(analysed) || analysed < 0)) fail('the header analysed count is invalid');
  const lengths = [values.length * vertices * 8, imaginary ? values.length * vertices * 8 : 0, raw.length * vertices * 8, (analysed ?? 0) * 4];
  if (PREAMBLE + headerLength + lengths.reduce((sum, length) => sum + length, 0) !== bytes.length) fail('the file length does not match its header');
  let offset = PREAMBLE + headerLength;
  // slice copies the bytes into a buffer of their own, aligned for the typed array.
  const take = (length, Type) => {
    const section = new Type(bytes.slice(offset, offset + length).buffer);
    offset += length;
    return section;
  };
  const data = take(lengths[0], Float64Array);
  const parts = imaginary ? take(lengths[1], Float64Array) : null;
  const rawData = take(lengths[2], Float64Array);
  return {
    maps: { values, vertices, data },
    raw: raw.length ? { values: raw, vertices, data: rawData } : null,
    analysed: analysed === null ? null : take(lengths[3], Uint32Array),
    imaginary: parts,
    arithmeticReference,
    precision,
  };
}
