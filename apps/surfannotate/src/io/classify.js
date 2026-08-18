// Is a dropped file a surface or a per-vertex overlay?
//
// With one surface slot the app could get away with "the first drop is the
// surface, the rest are overlays". Once several surfaces can be loaded that
// rule stops working — there is no longer a first drop — so the file itself
// has to say what it is.
//
// Extensions alone are not enough: `.gii` covers both geometry and scalars, and
// FreeSurfer's surfaces have no extension at all (`lh.pial`, `lh.white`). So
// this reads the file's magic number where the format has one, and falls back
// to naming conventions where it does not.

/** Bytes of the file the caller needs to read for `head`. */
export const SNIFF_BYTES = 4096;

export const SURFACE = 'surface';
export const OVERLAY = 'overlay';
export const MASK = 'mask';
export const UNKNOWN = 'unknown';

/**
 * A mask announces itself in its name, and nothing else can tell.
 *
 * A vertex mask is a per-vertex file like any other — the same curv, .label,
 * .mgz or GIfTI formats — so no magic number distinguishes "where is there data"
 * from the data itself. The name is the only signal, and in practice it is a
 * reliable one: `lh.V1.mask`, `sub-01_desc-brain_mask.nii.gz`,
 * `lh.cortex_mask.gii`.
 *
 * Matched as a substring rather than a delimited token because BIDS runs the
 * word together — `desc-brainmask.nii.gz` is one word and a token match would
 * miss it. The `masked` exclusion is the one false positive worth guarding:
 * `lh.thickness.masked.gii` is an overlay that has *had* a mask applied, which
 * is the opposite of a mask.
 */
const MASK_NAME = /mask/i;
const MASKED_NAME = /masked/i;

/** Extensions that are only ever geometry. */
const SURFACE_EXT = /\.(mz3|obj|stl|ply|vtk|off|srf|byu|dfs|ico|tri|nv|wrl|x3d|asc)$/i;

/** Extensions that are only ever per-vertex data. */
const OVERLAY_EXT = new RegExp(
  '\\.(curv|thickness|sulc|area|annot|label|mgz|mgh|nii|nii\\.gz|dscalar\\.nii|dlabel\\.nii)$',
  'i'
);

/** GIfTI sub-types, which are conventional but reliable in practice. */
const GIFTI_SURFACE_EXT = /\.surf\.gii$/i;
const GIFTI_OVERLAY_EXT = /\.(shape|func|label|time)\.gii$/i;

/** FreeSurfer's standard geometry names, which carry no extension. */
const FREESURFER_SURFACE = new RegExp(
  '(^|[._])(pial|white|inflated|sphere|smoothwm|orig|midthickness|mid|graymid|' +
  'woT1|nofix|patch|flat)([._]|$)', 'i'
);

/**
 * Classify a file from its name and its first bytes.
 *
 * @param {string} filename
 * @param {ArrayBuffer|Uint8Array|null} head first `SNIFF_BYTES` of the file, or
 *   null to classify on the name alone
 * @returns {'surface'|'overlay'|'mask'|'unknown'}
 */
export function classifyFile(filename, head = null) {
  const name = String(filename || '');
  const kind = classifyData(name, head);
  // A mask is a *kind of* per-vertex file, so the question of whether this is
  // geometry is settled first and never overridden: a surface with "mask" in
  // its name is still a surface. Promoting UNKNOWN too is what recognises
  // `lh.V1.mask`, whose extension is in no list and whose curv magic number
  // says only "per-vertex data".
  if (kind === SURFACE) return SURFACE;
  if (MASK_NAME.test(name) && !MASKED_NAME.test(name)) return MASK;
  return kind;
}

/** Surface, overlay, or neither — everything except the mask question. */
function classifyData(name, head) {
  const bytes = head ? new Uint8Array(head instanceof Uint8Array ? head : head) : null;

  // 1. Unambiguous extensions win outright — no need to read anything.
  if (GIFTI_SURFACE_EXT.test(name)) return SURFACE;
  if (GIFTI_OVERLAY_EXT.test(name)) return OVERLAY;
  if (SURFACE_EXT.test(name)) return SURFACE;
  if (OVERLAY_EXT.test(name)) return OVERLAY;

  // 2. Otherwise ask the bytes.
  const sniffed = bytes ? sniff(bytes) : UNKNOWN;
  if (sniffed !== UNKNOWN) return sniffed;

  // 3. Fall back to FreeSurfer's naming, which is how `lh.pial` is recognised
  //    when the magic number was inconclusive.
  if (FREESURFER_SURFACE.test(name)) return SURFACE;
  return UNKNOWN;
}

/**
 * Read a format's magic number.
 * @param {Uint8Array} bytes
 * @returns {'surface'|'overlay'|'unknown'}
 */
function sniff(bytes) {
  if (bytes.length < 4) return UNKNOWN;

  // GIfTI is XML. The intent codes appear as plain attributes in the header, so
  // a geometry array is visible well inside the first few KB.
  if (bytes[0] === 0x3c) { // '<'
    const text = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES)));
    if (text.includes('NIFTI_INTENT_POINTSET') || text.includes('NIFTI_INTENT_TRIANGLE')) {
      return SURFACE;
    }
    if (/NIFTI_INTENT_(SHAPE|LABEL|TIME_SERIES|NONE|ZSCORE|TTEST)/.test(text)) return OVERLAY;
    return UNKNOWN;
  }

  // A FreeSurfer .label is ASCII with a fixed first line.
  if (bytes[0] === 0x23) { // '#'
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64));
    if (head.startsWith('#!ascii label')) return OVERLAY;
  }

  // FreeSurfer binaries lead with a 3-byte magic number.
  //   0xFFFFFE  TRIANGLE_FILE — a surface
  //   0xFFFFFF  shared by curv's NEW_VERSION_MAGIC_NUMBER and the long-obsolete
  //             QUAD_FILE surface. Curvature is what anyone actually has, and a
  //             quad surface would still be caught by its filename below.
  if (bytes[0] === 0xff && bytes[1] === 0xff) {
    if (bytes[2] === 0xfe) return SURFACE;
    if (bytes[2] === 0xff) return OVERLAY;
  }

  // MZ3 carries a bitfield saying what it holds: bit 0 faces, bit 1 vertices,
  // bit 3 scalars. A file with vertices is geometry; one with only scalars is
  // an overlay.
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) { // 'MZ'
    const attr = bytes[2] | (bytes[3] << 8);
    if (attr & 2) return SURFACE;
    if (attr & 8) return OVERLAY;
  }

  // NIfTI: 348-byte header, or 'n+1' at offset 344.
  if (bytes.length > 347) {
    const magic = String.fromCharCode(bytes[344], bytes[345], bytes[346]);
    if (magic === 'n+1' || magic === 'ni1') return OVERLAY;
  }
  // gzip — could be anything; leave it to the filename.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return UNKNOWN;

  return UNKNOWN;
}
