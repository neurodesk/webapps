// FreeSurfer's "new" curv format, read honestly.
//
// NiiVue reads this format too, but `readCURV` min-max normalises the values
// AND inverts them (`f32[i] = 1 - (f32[i] - mn) * scale`), which is fine for
// shading a surface and ruinous for anything whose numbers mean something. A
// binary mask comes back with every 1 as 0 and every 0 as 1 — masking exactly
// the wrong half of the cortex, and looking entirely plausible while it does.
//
// Worse, that reader is not chosen by filename: `readLayer` falls through to a
// magic-byte sniff, so `lh.V1.mask` gets it as surely as `lh.curv` does. Any
// value we intend to compare against a threshold has to be parsed here instead.
//
// Layout: 3 magic bytes, then big-endian uint32 vertex count, face count and
// values-per-vertex, then big-endian float32 data.

const MAGIC = [255, 255, 255];
const HEADER_BYTES = 15;

/**
 * @param {ArrayBuffer} buffer
 * @returns {boolean} true when this is a FreeSurfer curv-format file
 */
export function isCurvFormat(buffer) {
  if (!buffer || buffer.byteLength < HEADER_BYTES) return false;
  const bytes = new Uint8Array(buffer, 0, MAGIC.length);
  return MAGIC.every((byte, at) => bytes[at] === byte);
}

/**
 * The file's own values, in the file's own units.
 *
 * @param {ArrayBuffer} buffer
 * @param {number} vertexCount the surface's vertex count, checked against the file
 * @returns {Float32Array} one value per vertex — the first frame of a multi-frame file
 */
export function readCurvValues(buffer, vertexCount) {
  if (!isCurvFormat(buffer)) throw new Error('not a FreeSurfer curv-format file');

  const view = new DataView(buffer);
  const fileVertices = view.getUint32(3, false);
  if (fileVertices !== vertexCount) {
    throw new Error(
      `it has ${fileVertices} values but the surface has ${vertexCount} vertices — ` +
      'it belongs to a different mesh'
    );
  }

  const frames = Math.max(1, view.getUint32(11, false));
  if (buffer.byteLength < HEADER_BYTES + 4 * fileVertices * frames) {
    throw new Error('the file is shorter than its header says');
  }

  const values = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    values[v] = view.getFloat32(HEADER_BYTES + v * 4, false);
  }
  return values;
}
