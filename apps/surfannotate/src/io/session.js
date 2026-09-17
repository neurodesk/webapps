// The editable form of the work: ROI definitions and landmarks, as a file.
//
// Every export the app writes (.label, .annot, .label.gii) is a *mask* — one
// value per vertex — and a mask cannot be edited here, because editing works
// on the border points the mask was derived from. This file carries those
// points instead: the clicks, how they were closed, which side was filled, and
// the anchor, for every ROI in list order, plus the landmarks. Loading it onto
// the same surface restores the list exactly as it was saved.
//
// It also travels inside the .label.gii exports as a MetaData entry, so the
// file handed to Workbench is the file that can be reopened here. FreeSurfer's
// .label header is one line and .annot has only a colour-table filename
// string, so neither carries it.

export const SESSION_FORMAT = 'surfannotate-session/1';

/** The GIfTI MetaData name the session is stored under. */
export const SESSION_METADATA_KEY = 'SurfAnnotateSession';

/**
 * @typedef {object} SessionRoi
 * @property {string} name
 * @property {number[]} clicks
 * @property {string} closure           'loop' or 'edge'
 * @property {number} [regionIndex]
 * @property {boolean} [includeBoundary]
 * @property {number} [anchor]
 * @property {number} [colorIndex]
 * @property {boolean} [visible]
 */

/**
 * @typedef {object} SessionDocument
 * @property {string} format
 * @property {string} [created]
 * @property {object} mesh              identity: numVertices, triangleHash, ...
 * @property {string} topologyKey       "<vertexCount>:<triangleHash>"
 * @property {SessionRoi[]} rois        in list order, i.e. priority order
 * @property {Array<{vertex: number, name?: string}>} points
 */

/**
 * Serialise the session. Only the definition fields are written — never a
 * mask, a chain or an error, which are derived and would be stale.
 *
 * @param {object} input
 * @param {Array<object>} input.rois   the app's ROI objects, list order
 * @param {Array<{vertex: number, name?: string}>} [input.points]
 * @param {object} input.mesh          MeshIdentity
 * @param {string} input.topologyKey
 * @param {string} [input.created]     ISO timestamp, supplied for determinism
 * @returns {string} JSON
 */
export function writeSession({ rois, points = [], mesh, topologyKey, created = null }) {
  const document = {
    format: SESSION_FORMAT,
    ...(created ? { created } : {}),
    mesh,
    topologyKey,
    rois: rois.map((roi) => ({
      name: roi.name,
      clicks: Array.from(roi.clicks),
      // The traced border: what makes the ROI the same vertices on any surface
      // sharing the indexing. Absent for an ROI saved before it was recorded;
      // such an ROI is re-traced from its clicks, as it always was.
      ...(roi.border && roi.border.length ? { border: Array.from(roi.border) } : {}),
      closure: roi.closure,
      ...(roi.regionIndex !== undefined && roi.regionIndex !== null
        ? { regionIndex: roi.regionIndex } : {}),
      includeBoundary: Boolean(roi.includeBoundary),
      ...(Number.isInteger(roi.anchor) && roi.anchor >= 0 ? { anchor: roi.anchor } : {}),
      ...(Number.isInteger(roi.colorIndex) ? { colorIndex: roi.colorIndex } : {}),
      visible: roi.visible !== false
    })),
    points: points.map((point) => ({
      vertex: point.vertex,
      ...(point.name ? { name: point.name } : {})
    }))
  };
  return JSON.stringify(document, null, 2) + '\n';
}

/**
 * Parse and check a session. Throws with a message meant for the status line.
 *
 * @param {string} text
 * @returns {SessionDocument}
 */
export function readSession(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('not a JSON file');
  }
  if (!document || document.format !== SESSION_FORMAT) {
    throw new Error(`not a SurfAnnotate session (expected format ${SESSION_FORMAT})`);
  }
  if (!Array.isArray(document.rois)) throw new Error('session has no ROI list');
  document.rois.forEach((roi, index) => {
    const label = roi && roi.name ? `ROI "${roi.name}"` : `ROI ${index + 1}`;
    if (!roi || typeof roi.name !== 'string') throw new Error(`${label} has no name`);
    if (!Array.isArray(roi.clicks) || !roi.clicks.every((v) => Number.isInteger(v) && v >= 0)) {
      throw new Error(`${label} has no valid border points`);
    }
    if (roi.closure !== 'loop' && roi.closure !== 'edge') {
      throw new Error(`${label} has an unknown closure "${roi.closure}"`);
    }
    if (roi.colorIndex !== undefined
      && (!Number.isSafeInteger(roi.colorIndex) || roi.colorIndex < 0)) {
      throw new Error(`${label} has an invalid colour index`);
    }
    if (roi.border !== undefined
      && (!Array.isArray(roi.border) || !roi.border.every((v) => Number.isInteger(v) && v >= 0))) {
      throw new Error(`${label} has an invalid border`);
    }
  });
  if (document.points !== undefined && !Array.isArray(document.points)) {
    throw new Error('session landmarks are not a list');
  }
  document.points = (document.points || []).filter(
    (point) => point && Number.isInteger(point.vertex) && point.vertex >= 0
  );
  return document;
}

/**
 * Whether a session can be laid onto a surface. The vertex count is a hard
 * requirement — every number in the file is a vertex index. The triangle
 * hash is what says the surface is the *same* topology; a mismatch with an
 * equal vertex count is almost certainly a different subject, so it is
 * refused too, but named separately so the message can say which it was.
 *
 * @param {SessionDocument} session
 * @param {{vertexCount: number, topologyKey: string}} surface
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function sessionFits(session, surface) {
  const [count] = String(session.topologyKey || '').split(':');
  const vertexCount = Number(count) || session.mesh?.numVertices;
  if (!Number.isFinite(vertexCount)) {
    return { ok: false, reason: 'the session does not say which surface it was drawn on' };
  }
  if (vertexCount !== surface.vertexCount) {
    return {
      ok: false,
      reason: `the session was drawn on a surface with ${vertexCount.toLocaleString()} ` +
        `vertices; this one has ${surface.vertexCount.toLocaleString()}`
    };
  }
  const outOfRange = session.rois.flatMap((roi) => roi.clicks.concat(roi.border || []))
    .concat(session.points.map((point) => point.vertex))
    .some((v) => v >= surface.vertexCount);
  if (outOfRange) return { ok: false, reason: 'the session refers to vertices this surface lacks' };
  if (session.topologyKey && surface.topologyKey && session.topologyKey !== surface.topologyKey) {
    return {
      ok: false,
      reason: 'the surface has the same number of vertices but a different triangulation, ' +
        'so it is not the surface the session was drawn on'
    };
  }
  return { ok: true };
}

/**
 * The session stored inside a .label.gii this app wrote, or null.
 *
 * A pattern match rather than an XML parser: the entry has the one shape the
 * writer emits, and DOMParser is not available under node --test. The value
 * is CDATA; a `]]>` inside it was written as a closed-and-reopened section,
 * which is undone here.
 *
 * @param {string} xml
 * @returns {string|null} the JSON text
 */
export function sessionFromGiftiMetadata(xml) {
  const pattern = new RegExp(
    '<MD>\\s*<Name>(?:<!\\[CDATA\\[)?' + SESSION_METADATA_KEY +
    '(?:\\]\\]>)?</Name>\\s*<Value>([\\s\\S]*?)</Value>\\s*</MD>'
  );
  const match = pattern.exec(xml);
  if (!match) return null;
  let value = match[1].trim();
  if (value.startsWith('<![CDATA[')) value = value.slice('<![CDATA['.length);
  if (value.endsWith(']]>')) value = value.slice(0, -']]>'.length);
  return value.replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
}
