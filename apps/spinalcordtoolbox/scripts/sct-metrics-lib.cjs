'use strict';

/*
 * Shared by the SCT metric tests: loads the browser metric modules in Node
 * and reads a NIfTI fixture into the RPI layout those modules measure.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const loadClassicScript = require('./load-classic-script.cjs');

const MODULES = path.join(__dirname, '../web/js/modules');
const SHARED = path.join(__dirname, '../../../packages/components/src');

// Order matters: the centerline module is the base of the other two.
const centerline = loadClassicScript(path.join(MODULES, 'sct-centerline.js'));
const morphometry = loadClassicScript(path.join(MODULES, 'sct-morphometry.js'));
const lesionAnalysis = loadClassicScript(path.join(MODULES, 'lesion-analysis.js'));

let sharedModules;
function loadShared() {
  sharedModules ||= Promise.all([
    import(pathToFileURL(path.join(SHARED, 'file-io/NiftiUtils.js')).href),
    import(pathToFileURL(path.join(SHARED, 'worker/index.js')).href),
    import(pathToFileURL(path.join(SHARED, 'volume/geometry.js')).href)
  ]).then(([nifti, worker, geometry]) => ({ ...nifti, ...worker, ...geometry }));
  return sharedModules;
}

function readNiftiBuffer(filePath) {
  const raw = fs.readFileSync(filePath);
  const bytes = filePath.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * The same path the worker takes: parse, reorient to RAS with the shared
 * helper, flip x to RPI. `nativeFlips` tells the modules how the stored axes
 * run, which SCT uses when it rounds and reports coordinates.
 */
async function loadRpiVolume(filePath, { OutputCtor = Float64Array } = {}) {
  const { parseNiftiVolume, prepareRasWorkerInput } = await loadShared();
  const ras = prepareRasWorkerInput(parseNiftiVolume(readNiftiBuffer(filePath), { OutputCtor }));
  return {
    data: centerline.rasToRpi(ras.rasData, ras.rasDims),
    dims: ras.rasDims,
    spacing: ras.rasSpacing,
    nativeFlips: centerline.nativeFlipsFromRas(ras.flip),
    perm: ras.perm,
    flip: ras.flip,
    origDims: ras.origDims
  };
}

/** A mask given as stored-order voxel indices, on the grid of `like`. */
async function rpiFromStoredIndices(indices, like) {
  const { orientToRAS } = await loadShared();
  const stored = new Uint8Array(like.origDims[0] * like.origDims[1] * like.origDims[2]);
  for (const index of indices) stored[index] = 1;
  const isIdentity = like.perm.every((axis, index) => axis === index && !like.flip[index]);
  const ras = isIdentity ? stored : orientToRAS(stored, like.origDims, like.perm, like.flip).data;
  return centerline.rasToRpi(ras, like.dims);
}

/** Per RPI axis, whether an image stored in SCT orientation `code` runs the other way. */
function nativeFlipsForOrientation(code) {
  return [code.includes('L'), code.includes('A'), code.includes('S')];
}

/** RFC 4180 parser; keeps whether a field was quoted. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const pushField = () => {
    row.push({ text: field, quoted: wasQuoted });
    field = '';
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushField();
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    pushField();
    rows.push(row);
  }
  return rows;
}

module.exports = {
  centerline,
  morphometry,
  lesionAnalysis,
  loadRpiVolume,
  rpiFromStoredIndices,
  nativeFlipsForOrientation,
  parseCsv
};
