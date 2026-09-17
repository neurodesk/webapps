// FreeSurfer .annot writer (and a reader for round-trip tests).
//
// The format, from FreeSurfer's MRISwriteAnnotation / CTABwriteIntoBinaryV2,
// every integer big-endian int32:
//
//   nVertices
//   nVertices × (vertexIndex, annotation)
//   tag = 1                        TAG_OLD_COLORTABLE
//   -2                             colour table version 2
//   nEntries                       size of the table (largest index + 1)
//   len, bytes                     the "original file" name, null-terminated
//   nEntries                       number of entries that follow
//   nEntries × (index, len, bytes, r, g, b, flag)
//
// The annotation stored per vertex is not a label index. It is the label's
// colour packed as r + (g << 8) + (b << 16), and readers recover the label by
// matching that against the table. Two consequences shape this writer: every
// label needs a colour no other label has, or the two become one; and 0 is the
// annotation of an unlabelled vertex, so no label may be pure black.

const TAG_OLD_COLORTABLE = 1;
const CTAB_VERSION = -2;
const ORIGINAL_FILE = 'SurfAnnotate';

/** The colour a reader will match a vertex against. */
export function packAnnotation([r, g, b]) {
  return r + (g << 8) + (b << 16);
}

/**
 * Make every colour distinct and none of them black, changing as little as
 * possible. The palette has sixteen colours and a parcellation may have more, so
 * two labels routinely share one; a collision is resolved by stepping the
 * blue channel, then green, then red, one unit at a time — invisible on
 * screen, but a different annotation value.
 *
 * @param {number[][]} colors RGB bytes, one per label
 * @returns {number[][]} same length, all distinct, none [0, 0, 0]
 */
export function uniqueAnnotColors(colors) {
  const taken = new Set([0]);
  return colors.map((rgb) => {
    let [r, g, b] = rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))));
    while (taken.has(packAnnotation([r, g, b]))) {
      if (b < 255) b++;
      else if (g < 255) { g++; b = 0; }
      else if (r < 255) { r++; g = 0; b = 0; }
      else { r = 0; g = 0; b = 1; }
    }
    taken.add(packAnnotation([r, g, b]));
    return [r, g, b];
  });
}

/**
 * @typedef {object} AnnotEntry
 * @property {string} name
 * @property {number[]} rgb  three bytes; must be unique across entries and not black
 */

/**
 * Write a .annot.
 *
 * @param {Int32Array|Uint8Array|number[]} labelPerVertex one value per vertex:
 *   0 for unlabelled, otherwise 1-based index into `entries`
 * @param {AnnotEntry[]} entries
 * @returns {Uint8Array}
 */
export function writeFreeSurferAnnot(labelPerVertex, entries) {
  const colors = entries.map((entry) => entry.rgb);
  const distinct = new Set(colors.map(packAnnotation));
  if (distinct.size !== colors.length || distinct.has(0)) {
    throw new Error('annot labels need distinct, non-black colours; use uniqueAnnotColors');
  }
  const names = entries.map((entry) => new TextEncoder().encode(`${entry.name}\0`));
  const original = new TextEncoder().encode(`${ORIGINAL_FILE}\0`);

  const n = labelPerVertex.length;
  let size = 4 + n * 8 + 4 + 4 + 4 + 4 + original.length + 4;
  for (const name of names) size += 4 + 4 + name.length + 16;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const int = (value) => { view.setInt32(at, value); at += 4; };
  const blob = (data) => { bytes.set(data, at); at += data.length; };

  int(n);
  for (let v = 0; v < n; v++) {
    const label = labelPerVertex[v];
    int(v);
    int(label > 0 ? packAnnotation(colors[label - 1]) : 0);
  }
  int(TAG_OLD_COLORTABLE);
  int(CTAB_VERSION);
  int(entries.length);
  int(original.length);
  blob(original);
  int(entries.length);
  entries.forEach((entry, index) => {
    int(index);
    int(names[index].length);
    blob(names[index]);
    const [r, g, b] = entry.rgb;
    int(r); int(g); int(b); int(0);
  });
  return bytes;
}

/**
 * Read a .annot back: what the writer produced, checked by a second pair of
 * eyes. Returns 0 for a vertex whose annotation matches no entry.
 *
 * @param {Uint8Array|ArrayBuffer} data
 * @returns {{labels: Int32Array, entries: AnnotEntry[]}}
 */
export function readFreeSurferAnnot(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const int = () => { const value = view.getInt32(at); at += 4; return value; };
  const text = (length) => {
    const raw = bytes.subarray(at, at + length); at += length;
    return new TextDecoder().decode(raw).replace(/\0+$/, '');
  };

  const n = int();
  const annotations = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const vertex = int();
    annotations[vertex] = int();
  }
  if (int() !== TAG_OLD_COLORTABLE) throw new Error('annot has no colour table');
  const version = int();
  if (version !== CTAB_VERSION) throw new Error(`unsupported colour table version ${version}`);
  int();               // table size
  text(int());         // original file name
  const count = int();
  const entries = [];
  const byAnnotation = new Map();
  for (let i = 0; i < count; i++) {
    const index = int();
    const name = text(int());
    const rgb = [int(), int(), int()];
    int();             // flag
    entries[index] = { name, rgb };
    byAnnotation.set(packAnnotation(rgb), index + 1);
  }
  const labels = new Int32Array(n);
  for (let v = 0; v < n; v++) labels[v] = byAnnotation.get(annotations[v]) || 0;
  return { labels, entries };
}
