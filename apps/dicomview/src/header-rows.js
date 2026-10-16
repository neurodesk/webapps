// A parsed DICOM header as the rows of the header explorer, named from a DICOM
// dictionary. Pure: runs under Node.
//
// HeaderRow = { tag: '(0018,0080)', keyword, vr, value, depth, varies }

const VALUE_CHARS = 1024;
const LIST_VALUES = 64;
const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const NUMBER_READERS = {
  US: [2, (view, at) => view.getUint16(at, true)],
  SS: [2, (view, at) => view.getInt16(at, true)],
  UL: [4, (view, at) => view.getUint32(at, true)],
  SL: [4, (view, at) => view.getInt32(at, true)],
  FL: [4, (view, at) => view.getFloat32(at, true)],
  FD: [8, (view, at) => view.getFloat64(at, true)],
};

const hex = (value, digits) => value.toString(16).toUpperCase().padStart(digits, '0');

export function formatTag(tag) {
  return `(${hex(tag >>> 16, 4)},${hex(tag & 0xffff, 4)})`;
}

// dcmjs writes a VR that depends on other elements in lower case ("xs" is US or SS).
const CONTEXT_VRS = { xs: 'US', ox: 'OB', lt: 'OW', up: 'UL' };
const firstVr = (vr) => CONTEXT_VRS[vr] ?? /^[A-Z]{2}$/.exec(vr ?? '')?.[0];
const isPrivateCreator = (tag) => (tag >>> 16) % 2 === 1 && (tag & 0xffff) >= 0x10 && (tag & 0xffff) <= 0xff;

// dictionary: dcmjs's data dictionary, keyed '(0008,103E)' for public tags and
// '(0029,"SIEMENS CSA HEADER",10)' for private ones.
export function createDictionary(dictionary) {
  const byTag = new Map();
  for (const [key, entry] of Object.entries(dictionary)) {
    const match = /^\(([0-9A-F]{4}),([0-9A-F]{4})\)$/.exec(key);
    if (match) byTag.set(Number.parseInt(match[1] + match[2], 16), entry);
  }
  return {
    entry: (tag) => byTag.get(tag),
    privateEntry: (group, creator, element) => dictionary[`(${hex(group, 4).toLowerCase()},"${creator}",${hex(element & 0xff, 2).toLowerCase()})`],
    vrOf: (tag) => (isPrivateCreator(tag) ? 'LO' : firstVr(byTag.get(tag)?.vr)),
  };
}

function clip(text) {
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text;
}

function list(values, format = String) {
  const shown = values.slice(0, LIST_VALUES).map(format).join('\\');
  return values.length > LIST_VALUES ? `${shown}\\… (${values.length} values)` : shown;
}

function latin1(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
  let text = '';
  for (let i = 0; i < Math.min(end, VALUE_CHARS + 1); i++) text += String.fromCharCode(bytes[i]);
  return text;
}

// Bytes are read as the dictionary's VR when the file did not say (Implicit VR, UN).
function bytesText(bytes, vr) {
  if (STRING_VRS.has(vr)) return clip(latin1(bytes));
  const reader = NUMBER_READERS[vr];
  if (reader) {
    const [size, read] = reader;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for (let at = 0; at + size <= bytes.length; at += size) values.push(read(view, at));
    return list(values);
  }
  const preview = [...bytes.subarray(0, 16)].map(byte => hex(byte, 2)).join(' ');
  return `${bytes.length} bytes${bytes.length ? `: ${preview}${bytes.length > 16 ? ' …' : ''}` : ''}`;
}

function valueText(element, vr) {
  if (element.items) return `${element.items.length} item${element.items.length === 1 ? '' : 's'}`;
  if (element.encapsulated) return 'Encapsulated pixel data';
  if (element.str !== undefined) return clip(element.str);
  if (element.numbers) return list(element.numbers, vr === 'AT' ? formatTag : String);
  return bytesText(element.bytes, vr);
}

function keyword(tag, map, dictionary) {
  const group = tag >>> 16;
  const element = tag & 0xffff;
  if (element === 0) return { name: dictionary.entry(tag)?.name ?? 'GroupLength' };
  if (group % 2 === 0) return dictionary.entry(tag) ?? { name: 'Unknown' };
  if (isPrivateCreator(tag)) return { name: 'PrivateCreator', vr: 'LO' };
  const creator = map.get(((group << 16) | (element >> 8)) >>> 0)?.str?.trim();
  if (!creator) return { name: 'Private' };
  const entry = dictionary.privateEntry(group, creator, element);
  const name = entry && entry.name !== 'Unknown' ? entry.name : 'Private';
  return { name: `${name} (${creator})`, vr: entry?.vr };
}

function datasetRows(map, dictionary, depth, varies, rows) {
  for (const [tag, element] of map) {
    const entry = keyword(tag, map, dictionary);
    const vr = element.vr === 'UN' ? firstVr(entry.vr) ?? 'UN' : element.vr;
    const flag = typeof varies === 'boolean' ? varies : varies.has(tag);
    rows.push({ tag: formatTag(tag), keyword: entry.name, vr, value: valueText(element, vr), depth, varies: flag });
    element.items?.forEach((item, index) => {
      rows.push({ tag: '(FFFE,E000)', keyword: `Item ${index + 1}`, vr: '', value: '', depth: depth + 1, varies: flag });
      datasetRows(item, dictionary, depth + 2, flag, rows);
    });
  }
  return rows;
}

// header: parseDicomHeader's result; varyingTags: the series' Set of top-level tags whose
// value differs between its instances. Nested rows share their sequence's flag.
export function headerRows(header, dictionary, varyingTags = new Set()) {
  const rows = datasetRows(header.meta, dictionary, 0, varyingTags, []);
  return datasetRows(header.map, dictionary, 0, varyingTags, rows);
}

// A BIDS sidecar as rows: keys are the keywords, nested values are JSON.
export function sidecarRows(sidecar) {
  return Object.entries(sidecar ?? {}).map(([key, value]) => ({
    tag: '',
    keyword: key,
    vr: '',
    value: clip(typeof value === 'string' ? value : JSON.stringify(value)),
    depth: 0,
    varies: false,
  }));
}

// query matches the tag (with or without punctuation), keyword or value, case-insensitively.
export function filterRows(rows, { query = '', varyingOnly = false } = {}) {
  const needle = query.trim().toLowerCase();
  const bare = needle.replace(/[(),\s]/g, '');
  return rows.filter(row => (!varyingOnly || row.varies) && (!needle
    || row.keyword.toLowerCase().includes(needle)
    || row.value.toLowerCase().includes(needle)
    || (bare && row.tag.replace(/[(),]/g, '').toLowerCase().includes(bare))));
}

const csvCell = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function rowsToCsv(rows) {
  const lines = [['tag', 'keyword', 'vr', 'value', 'depth', 'varies'].join(',')];
  for (const row of rows) {
    lines.push([row.tag, row.keyword, row.vr, row.value, String(row.depth), String(row.varies)].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
