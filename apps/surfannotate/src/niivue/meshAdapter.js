// Every NiiVue mesh call in this app goes through here.
//
// NiiVue 1.0.0-rc.x is a ground-up rewrite: NVMesh stops being a class, `pts`
// and `tris` become `positions` and `indices`, layer fields switch to camelCase,
// and `indexNearestXYZmm` disappears. Keeping the surface area to this one file
// means that migration is a single-file change rather than a sweep.
//
// Pinned to 0.69.0, which is npm `latest`. Its mesh code is byte-identical to
// 0.68.x (the versions the rest of this monorepo pins), so nothing here
// conflicts with the shared runtime.

import {
  NVMesh, NVMeshLayerDefaults, NVMeshLoaders, NVMeshUtilities, cmapper
} from '@niivue/niivue';
import { niivueTranslation } from '../io/geometryOffset.js';

/** A miss returns a far-away vertex; anything past this is treated as no hit. */
const PICK_MAX_DISTANCE_MM = 3;

/**
 * @param {import('@niivue/niivue').Niivue} nv
 * @param {File|Blob} file
 * @returns {Promise<object>} the NVMesh that was added to the scene
 */
export async function loadMeshFromFile(nv, file) {
  const buffer = await file.arrayBuffer();
  const mesh = await loadMeshFromBuffer(nv, buffer, file.name);
  // Read from the same bytes NiiVue just parsed, so the correction is derived
  // from the file rather than guessed at. See io/geometryOffset.js.
  mesh.surfannotateTranslation = niivueTranslation(buffer);
  return mesh;
}

/**
 * NVMesh.readMesh dispatches on the extension and falls back to the FreeSurfer
 * binary reader for anything unrecognised, which is how lh.pial / lh.white /
 * lh.inflated load. Prefer it over nv.loadFromFile(), which gates on an
 * extension allow-list and sends anything unlisted to the volume loader.
 *
 * @param {import('@niivue/niivue').Niivue} nv
 * @param {ArrayBuffer} buffer
 * @param {string} name
 */
export async function loadMeshFromBuffer(nv, buffer, name) {
  const mesh = await NVMesh.readMesh(
    buffer, name, nv.gl, 1.0, new Uint8Array([200, 200, 200, 255]), true
  );
  nv.addMesh(mesh);
  return mesh;
}

/**
 * Geometry in world mm — no affine to apply.
 *
 * Note `mesh.vertexCount` is `pts.length`, i.e. three times the vertex count.
 * Always divide `pts.length` by 3 instead.
 *
 * @param {object} mesh
 * @returns {{positions: Float32Array, triangles: Uint32Array, vertexCount: number}}
 */
export function getGeometry(mesh) {
  const positions = mesh.pts;
  const triangles = mesh.tris;
  if (!positions || !triangles) throw new Error('mesh has no geometry (pts/tris missing)');
  return { positions, triangles, vertexCount: positions.length / 3 };
}

/**
 * Convert a canvas-relative click into a world-mm point on the rendered surface.
 *
 * NiiVue has no mesh vertex picking: the depth-picking shader packs depth only,
 * and `onLocationChange` reports mm with no vertex index. So we drive the pick
 * ourselves and resolve the vertex separately (see vertexLookup.js).
 *
 * Two quirks, both load-bearing:
 *  - `drawScene()` must run twice; NiiVue's own source says so.
 *  - do not touch `nv.scene.crosshairPos` immediately before the pick, or
 *    readPixels comes back empty and the pick silently no-ops.
 *
 * @returns {[number, number, number]|null} mm, or null when nothing was hit
 */
export function pickWorldMm(nv, offsetX, offsetY, memo = null) {
  const dpr = nv.uiData?.dpr || 1;
  const before = nv.scene.crosshairPos.slice();

  nv.mousePos = [offsetX * dpr, offsetY * dpr];
  nv.uiData.mouseDepthPicker = true;
  nv.drawScene();
  nv.drawScene();

  const after = nv.scene.crosshairPos;
  const moved = before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2];

  if (!moved) {
    // NiiVue gives no "nothing hit" signal — depthPicker just early-returns and
    // leaves the crosshair where it was. So an unchanged crosshair is ambiguous:
    // either the ray missed, or it landed exactly where the previous pick did.
    // Disambiguate on the screen position, otherwise clicking the same spot
    // twice reads as a miss and the click is silently dropped.
    const repeat = memo && Math.hypot(offsetX - memo.x, offsetY - memo.y) <= 3;
    if (!repeat) return null;
    return memo.mm;
  }

  const mm = nv.frac2mm(after, 0, true);
  const point = [mm[0], mm[1], mm[2]];
  if (memo) { memo.x = offsetX; memo.y = offsetY; memo.mm = point; }
  return point;
}

/**
 * The matrices NiiVue is about to draw the 3D view with.
 *
 * Taken from NiiVue rather than rebuilt, so a marker drawn from them cannot
 * drift from the surface it is meant to sit on: `drawMesh3D` calls this same
 * method with these same arguments when no matrix is handed to it. The
 * viewport defaults to the whole canvas in device pixels, which is what the
 * render view occupies.
 *
 * @param {import('@niivue/niivue').Niivue} nv
 * @returns {{mvp: Float32Array, model: Float32Array, normal: Float32Array}}
 *   all column-major mat4
 */
export function renderMatrices(nv) {
  const [mvp, model, normal] = nv.calculateMvpMatrix(
    null, undefined, nv.scene.renderAzimuth, nv.scene.renderElevation
  );
  return { mvp, model, normal };
}

/**
 * Per-vertex normals for a loaded mesh.
 *
 * NiiVue generates these inside `updateMesh` and packs them straight into the
 * vertex buffer, so there is no array on the mesh to read back — but the
 * generator itself is exported, and calling it gives exactly the normals the
 * shader is shading with. Costly enough on a 160k-vertex hemisphere to be
 * worth caching per surface; it does not change unless the geometry does.
 *
 * @param {object} mesh
 * @returns {Float32Array} 3 per vertex
 */
export function vertexNormals(mesh) {
  return NVMeshUtilities.generateNormals(mesh.pts, mesh.tris);
}

/**
 * Resolve a pick to a vertex, rejecting hits that land too far from any vertex.
 *
 * @param {ReturnType<import('../surface/vertexLookup.js').buildVertexIndex>} index
 * @param {[number, number, number]|null} mm
 * @param {number} [maxDistanceMm]
 * @returns {number} vertex index, or -1
 */
export function resolveVertex(index, mm, maxDistanceMm = PICK_MAX_DISTANCE_MM) {
  if (!mm) return -1;
  const { vertex, distance } = index.nearest(mm[0], mm[1], mm[2]);
  return distance <= maxDistanceMm ? vertex : -1;
}

/**
 * Attach a per-vertex label layer backed by a Float32Array we own.
 *
 * Deliberately Float32 + colormapLabel rather than the packed-RGBA Uint8Array
 * layer path: in 0.69.0 that path renders nothing, because `opaque` is only
 * populated when `outlineBorder !== 0` and the composite loop then reads every
 * vertex as fully transparent.
 *
 * @param {object} mesh
 * @param {Float32Array} values one entry per vertex; 0 means unlabelled
 * @param {Array<{key: number, name: string, rgba: number[]}>} entries
 * @returns {number} index of the new layer
 */
export function attachLabelLayer(mesh, values, entries) {
  const lut = makeLabelLut(entries);
  const maxKey = entries.reduce((max, entry) => Math.max(max, entry.key), 0);

  mesh.layers.push({
    ...NVMeshLayerDefaults,
    name: 'surfannotate-roi',
    values,
    nFrame4D: 1,
    frame4D: 0,
    global_min: 0,
    global_max: maxKey,
    cal_min: 0,
    cal_max: maxKey,
    cal_minNeg: NaN,
    cal_maxNeg: NaN,
    opacity: 1.0,
    colormap: 'warm',
    colormapNegative: '',
    useNegativeCmap: false,
    colormapLabel: lut,
    outlineBorder: 0,
    isTransparentBelowCalMin: true,
    isAdditiveBlend: false,
    colorbarVisible: false,
    showLegend: false
  });
}

/**
 * Build the discrete LUT. Key 0 is forced transparent so unlabelled cortex
 * shows the underlying surface colour.
 */
export function makeLabelLut(entries) {
  const sorted = [...entries].sort((a, b) => a.key - b.key);
  const colormap = {
    R: sorted.map((e) => Math.round(e.rgba[0] * 255)),
    G: sorted.map((e) => Math.round(e.rgba[1] * 255)),
    B: sorted.map((e) => Math.round(e.rgba[2] * 255)),
    A: sorted.map((e) => (e.key === 0 ? 0 : Math.round((e.rgba[3] ?? 1) * 255))),
    I: sorted.map((e) => e.key),
    labels: sorted.map((e) => e.name)
  };
  const maxKey = sorted.length ? sorted[sorted.length - 1].key : 0;
  return cmapper.makeLabelLut(colormap, 255, maxKey);
}

/**
 * Full resync: recomposites layers on the CPU and re-uploads the vertex buffer.
 * Costs ~24 ms on a 163k-vertex mesh because it regenerates normals for
 * geometry that never changed — so call it on stroke end, undo, or a
 * layer-property change, not on every mouse move.
 */
export function commitLayer(nv, mesh) {
  mesh.updateMesh(nv.gl);
  nv.drawScene();
}

/**
 * Load a scalar or label overlay (.curv, .annot, .shape.gii, .label.gii, .mgz,
 * CIFTI .dscalar.nii) onto an existing mesh.
 *
 * Caveat worth surfacing to users: NiiVue's .curv reader min-max normalises to
 * [0,1] AND inverts, so displayed curvature/thickness values are not the file's
 * real units.
 */
export async function loadOverlay(nv, mesh, file, options = {}) {
  const buffer = await file.arrayBuffer();

  // NVMesh.loadLayer is STATIC and takes a layer descriptor, not a file — calling
  // it as an instance method silently throws. NVMeshLoaders.readLayer is the
  // buffer-level parser, and returns a layer we push ourselves.
  const layer = await NVMeshLoaders.readLayer(
    file.name,
    buffer,
    mesh,
    options.opacity ?? 0.7,
    options.colormap || 'gray',
    options.colormapNegative || 'winter',
    options.useNegativeCmap ?? false
  );

  if (!layer) {
    throw new Error(
      'NiiVue could not read this as a surface overlay. Supported: .curv, .sulc, ' +
      '.thickness, .area, .annot, .shape.gii, .func.gii, .label.gii, .mgh/.mgz, ' +
      '.mz3, and CIFTI .dscalar.nii.'
    );
  }
  if (layer.values && layer.values.length !== mesh.pts.length / 3) {
    throw new Error(
      `overlay has ${layer.values.length} values but the surface has ` +
      `${mesh.pts.length / 3} vertices — it belongs to a different mesh`
    );
  }

  // Default the window to a robust percentile range. NiiVue sets cal_min/cal_max
  // to the full data range, and for FreeSurfer curvature — which it also
  // min-max normalises into [0,1], clustering values around the middle — that
  // maps almost every vertex to the same mid-grey and the overlay looks like it
  // never loaded.
  const range = robustRange(layer.values);
  layer.cal_min = range.low;
  layer.cal_max = range.high;
  layer.isTransparentBelowCalMin = false;
  layer.opacity = options.opacity ?? 1.0;

  mesh.layers.push(layer);
  commitLayer(nv, mesh);
  return layer;
}

/**
 * Read a file's per-vertex values without attaching anything to the mesh.
 *
 * For a mask, which is read for its numbers rather than to be drawn. Note that
 * FreeSurfer curv-format files must NOT come through here — `readLayer` sniffs
 * the magic bytes and sends them to `readCURV`, which min-max normalises and
 * inverts. See io/freesurferCurv.js.
 *
 * @param {object} mesh
 * @param {File|Blob} file
 * @returns {Promise<Float32Array>} one value per vertex
 */
export async function readLayerValues(mesh, file) {
  const layer = await NVMeshLoaders.readLayer(
    file.name, await file.arrayBuffer(), mesh, 1.0, 'gray', 'winter', false
  );
  if (!layer?.values) {
    throw new Error(
      'NiiVue could not read this as per-vertex data. Supported: .curv, .annot, ' +
      '.shape.gii, .func.gii, .label.gii, .mgh/.mgz, .mz3, CIFTI .dscalar.nii, ' +
      'and FreeSurfer .label.'
    );
  }
  const vertexCount = mesh.pts.length / 3;
  if (layer.values.length !== vertexCount) {
    throw new Error(
      `it has ${layer.values.length} values but the surface has ${vertexCount} ` +
      'vertices — it belongs to a different mesh'
    );
  }
  return layer.values;
}

/**
 * 2nd–98th percentile, so a handful of outliers cannot flatten the display.
 * Sampled rather than fully sorted: 20k samples is plenty to place a percentile
 * and keeps this well under a millisecond on a 160k-vertex overlay.
 */
function robustRange(values, lowPercentile = 0.02, highPercentile = 0.98) {
  const total = values.length;
  if (!total) return { low: 0, high: 1 };

  const stride = Math.max(1, Math.floor(total / 20000));
  const sample = [];
  for (let i = 0; i < total; i += stride) {
    const value = values[i];
    if (Number.isFinite(value)) sample.push(value);
  }
  if (!sample.length) return { low: 0, high: 1 };
  sample.sort((a, b) => a - b);

  const low = sample[Math.floor(lowPercentile * (sample.length - 1))];
  const high = sample[Math.floor(highPercentile * (sample.length - 1))];
  // A constant overlay would give a zero-width window and render as one colour.
  return high > low ? { low, high } : { low, high: low + 1e-6 };
}

/** Change how an already-loaded overlay is displayed. */
export function setOverlayDisplay(nv, mesh, layer, { colormap, opacity } = {}) {
  if (colormap) layer.colormap = colormap;
  if (opacity !== undefined) layer.opacity = Number(opacity);
  commitLayer(nv, mesh);
}

/**
 * Attach a per-vertex array we parsed ourselves as an overlay layer.
 *
 * NiiVue's readLayer has no case for a FreeSurfer `.label` — the extension falls
 * through to its curvature reader, which cannot parse ASCII and leaves the drop
 * looking like nothing happened. A `.label` is a sparse vertex list rather than
 * a dense array anyway, so it has to be expanded before it can be shown; once it
 * is, the layer is built from NiiVue's own defaults so the renderer sees exactly
 * what it would have from readLayer.
 *
 * @param {import('@niivue/niivue').Niivue} nv
 * @param {object} mesh
 * @param {Float32Array} values one per vertex
 * @param {object} [options]
 * @param {number} [options.opacity]
 * @param {string} [options.colormap]
 * @returns {object} the layer
 */
export function attachValueLayer(nv, mesh, values, options = {}) {
  const vertexCount = mesh.pts.length / 3;
  if (values.length !== vertexCount) {
    throw new Error(
      `overlay has ${values.length} values but the surface has ${vertexCount} vertices`
    );
  }

  let low = Infinity;
  let high = -Infinity;
  let smallestAbove = Infinity;
  for (let v = 0; v < values.length; v++) {
    const value = values[v];
    if (value < low) low = value;
    if (value > high) high = value;
    if (value > 0 && value < smallestAbove) smallestAbove = value;
  }
  if (!Number.isFinite(low)) { low = 0; high = 1; }

  const layer = {
    ...NVMeshLayerDefaults,
    name: options.name || 'overlay',
    values,
    global_min: low,
    global_max: high,
    // A mask is mostly zeros, so a window over the full range would render the
    // whole surface in the colour map's low end and the region would not stand
    // out. Window from just under the smallest marked value instead, and let
    // everything below it fall through to the surface.
    cal_min: Number.isFinite(smallestAbove) ? smallestAbove * 0.5 : low,
    cal_max: high > low ? high : low + 1,
    cal_minNeg: NaN,
    cal_maxNeg: NaN,
    isTransparentBelowCalMin: true,
    isAdditiveBlend: false,
    // MUST be 1. The defaults leave it 0, and NiiVue computes the frame as
    // min(max(frame4D, 0), nFrame4D - 1) = -1, so it reads values[j - nvtx],
    // gets undefined, and every colour lookup lands on NaN and writes black
    // over the whole surface.
    nFrame4D: 1,
    frame4D: 0,
    colorbarVisible: true,
    colormapInvert: false,
    colormapType: 0,
    colormapLabel: null,
    colormap: options.colormap || 'warm',
    colormapNegative: 'winter',
    useNegativeCmap: false,
    opacity: options.opacity ?? 1.0
  };

  mesh.layers.push(layer);
  commitLayer(nv, mesh);
  return layer;
}
