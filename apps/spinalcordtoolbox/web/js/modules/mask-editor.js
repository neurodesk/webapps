/**
 * Manual mask editing on NiiVue's drawing layer.
 *
 * NiiVue 1.0.0-rc.13 holds a drawing as one Uint8Array (`nv.drawingVolume.img`)
 * in the background volume's RAS voxel order: dimensions `dimsRAS[1..3]`, x
 * fastest, one byte per voxel, the value being the label. A mask file stores
 * its voxels in the file's own (native) order. The background volume's
 * `img2RASstart`/`img2RASstep` map RAS voxel (x, y, z) to the native index
 *
 *   start[0] + x * step[0] + start[1] + y * step[1] + start[2] + z * step[2]
 *
 * which is exactly what NiiVue's own drawing export (`saveVolume` with
 * `isSaveDrawing`) uses. NiiVue's `loadDrawing`, which FreeBrowse's "Edit as
 * drawing" calls, is not the inverse of that export for a permuted orientation
 * (it walks the native voxels as if they were in RAS-sized order), so this
 * module fills the bitmap itself with the inverse map above. The round trip
 * native -> drawing -> native is then the identity for every orientation.
 *
 * The editor does not draw its own tools: FreeBrowse's Drawing tab (pen,
 * erase, pen fill, undo) drives NiiVue. The editor puts a mask into the
 * drawing layer, colours it with the stage's label colormap, and reads it
 * back when the user applies the edit.
 */

/** Geometry of the drawing layer for background volume `volume` (an NVImage). */
export function drawingGeometry(volume) {
  const dims = volume?.dimsRAS;
  const start = volume?.img2RASstart;
  const step = volume?.img2RASstep;
  if (!dims || !start || !step) throw new Error('The viewer has no RAS geometry for the image.');
  const size = [dims[1], dims[2], dims[3]];
  return { start: [...start], step: [...step], dims: size, count: size[0] * size[1] * size[2] };
}

function eachVoxel(geometry, visit) {
  const { start, step, dims } = geometry;
  let index = 0;
  for (let z = 0; z < dims[2]; z += 1) {
    const zOffset = start[2] + z * step[2];
    for (let y = 0; y < dims[1]; y += 1) {
      const yzOffset = start[1] + y * step[1] + zOffset;
      for (let x = 0; x < dims[0]; x += 1) {
        visit(index, start[0] + x * step[0] + yzOffset);
        index += 1;
      }
    }
  }
}

/** A mask in its file's voxel order -> NiiVue drawing bitmap (RAS order). */
export function nativeToDrawing(native, geometry) {
  if (native.length !== geometry.count) {
    throw new Error(`The mask has ${native.length} voxels; the image has ${geometry.count}.`);
  }
  const bitmap = new Uint8Array(geometry.count);
  eachVoxel(geometry, (index, nativeIndex) => {
    bitmap[index] = native[nativeIndex];
  });
  return bitmap;
}

/** NiiVue drawing bitmap (RAS order) -> a mask in the image file's voxel order. */
export function drawingToNative(bitmap, geometry) {
  if (bitmap.length !== geometry.count) {
    throw new Error(`The drawing has ${bitmap.length} voxels; the image has ${geometry.count}.`);
  }
  const native = new Uint8Array(geometry.count);
  eachVoxel(geometry, (index, nativeIndex) => {
    native[nativeIndex] = bitmap[index];
  });
  return native;
}

/** Number of voxels whose value differs. */
export function countChanged(a, b) {
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) changed += 1;
  return changed;
}

/** Labelled voxel count per label value, label 0 excluded. */
export function labelCounts(mask) {
  const counts = new Map();
  for (const value of mask) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

/** `_sct_lesion`: drawing colormaps are NiiVue's `_`-prefixed lookup tables. */
export function drawingColormapName(labelSetId) {
  return `_sct_${labelSetId}`;
}

/**
 * One edit session at a time on NiiVue `nv`. Callbacks:
 * - `onAdopt({ action, stage })`: FreeBrowse opened a drawing layer itself
 *   (Create empty drawing layer, or Edit as drawing on stage `stage`); return
 *   a begin() request to take it over, or null to leave it alone.
 * - `onAdopted(request)`: the adopted layer now holds the stage's mask.
 * - `onClosedByViewer(native, stage)`: FreeBrowse closed the layer during a session
 *   (its Save Drawing); `native` is the mask as it was.
 * - `onPenValue(value)`: the pen value changed in FreeBrowse.
 */
export class MaskEditor {
  constructor({ nv, showDrawingTools, setPenField, onAdopt, onAdopted, onClosedByViewer, onPenValue } = {}) {
    this.nv = nv;
    this.showDrawingTools = showDrawingTools || (async () => false);
    this.setPenField = setPenField || (() => false);
    this.onAdopt = onAdopt || (() => null);
    this.onAdopted = onAdopted || (() => {});
    this.onClosedByViewer = onClosedByViewer || (() => {});
    this.onPenValue = onPenValue || (() => {});
    this.session = null;
    this.ownChange = false;
    this.lastRemovedStage = null;
    this.pendingLabel = null;
    nv.addEventListener('drawingChanged', event => this.handleDrawingChanged(event.detail || {}));
    nv.addEventListener('penValueChanged', event => this.handlePenValue(event.detail?.penValue));
    // NiiVue's stroke start merges the previous undo snapshot back into the
    // bitmap when fills do not overwrite, which brings erased voxels back.
    nv.addEventListener('change', event => {
      if (this.session && event.detail?.property === 'drawIsFillOverwriting' && event.detail.value === false) {
        nv.drawIsFillOverwriting = true;
      }
    });
  }

  isActive() {
    return Boolean(this.session);
  }

  get stage() {
    return this.session?.stage || null;
  }

  /** The viewer just removed stage `stage` (FreeBrowse's Edit as drawing does that first). */
  noteStageRemoved(stage) {
    this.lastRemovedStage = { stage, at: Date.now() };
  }

  /**
   * Put `native` (mask voxels in the image file's order, or null for an empty
   * mask) into the drawing layer over background volume 0.
   * `labelColormap` is the stage's NiiVue label colormap.
   */
  async begin({ stage, native = null, labelSetId, labelColormap, label = 1, opacity = 0.7, keepTool = false }) {
    const nv = this.nv;
    if (this.session) this.discard();
    const geometry = drawingGeometry(nv.volumes[0]);
    const bitmap = native ? nativeToDrawing(native, geometry) : new Uint8Array(geometry.count);
    this.ownChange = true;
    try {
      if (!nv.drawingVolume) nv.createEmptyDrawing();
      const volume = nv.drawingVolume;
      if (!volume || volume.img?.length !== geometry.count) throw new Error('The viewer could not open a drawing layer.');
      volume.img.set(bitmap);
      const colormap = drawingColormapName(labelSetId);
      nv.addColormap(colormap, { ...labelColormap, I: [...labelColormap.I] });
      nv.drawColormap = colormap;
      nv.drawOpacity = opacity;
      nv.drawIsFillOverwriting = true;
      nv.drawPenValue = label;
      // A layer SCT opens starts with no tool, as FreeBrowse's own Create does;
      // the user picks Pen there. An adopted layer keeps FreeBrowse's tool.
      if (!keepTool) nv.drawIsEnabled = false;
      this.session = { stage, geometry, volume, original: bitmap.slice(), label };
      nv.refreshDrawing();
    } finally {
      this.ownChange = false;
    }
    this.pushPenField(label);
    await this.showDrawingTools();
    return this.session;
  }

  /** The current drawing as a mask in the image file's voxel order. */
  currentNative() {
    if (!this.session) return null;
    return drawingToNative(this.session.volume.img, this.session.geometry);
  }

  changedVoxels() {
    if (!this.session) return 0;
    return countChanged(this.session.volume.img, this.session.original);
  }

  isDirty() {
    return this.changedVoxels() > 0;
  }

  /** Close the drawing layer and return the edited mask (file voxel order). */
  apply() {
    const native = this.currentNative();
    this.close();
    return native;
  }

  /** Close the drawing layer without keeping the edit. */
  discard() {
    this.close();
  }

  close() {
    if (!this.session) return;
    this.session = null;
    this.pendingLabel = null;
    this.ownChange = true;
    try {
      this.nv.drawIsEnabled = false;
      this.nv.closeDrawing();
    } finally {
      this.ownChange = false;
    }
  }

  /** Paint label `value`; erasing stays erasing until FreeBrowse turns it off. */
  setLabel(value) {
    if (!this.session) return;
    this.session.label = value;
    if (this.nv.drawPenValue !== 0) {
      this.ownChange = true;
      try {
        this.nv.drawPenValue = value;
      } finally {
        this.ownChange = false;
      }
    }
    this.pushPenField(value);
  }

  // FreeBrowse keeps its own pen value and re-applies it whenever a tool is
  // chosen; its field only exists while the pen is selected. Until the field
  // has taken `value`, a stale pen value from FreeBrowse is replaced.
  pushPenField(value) {
    this.pendingLabel = value;
    if (this.setPenField(value)) this.pendingLabel = null;
  }

  retryPenField() {
    let frames = 0;
    const attempt = () => {
      if (this.pendingLabel === null || !this.session) return;
      if (this.setPenField(this.pendingLabel)) {
        this.pendingLabel = null;
      } else if (frames < 30) {
        frames += 1;
        (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 16)))(attempt);
      }
    };
    attempt();
  }

  handlePenValue(value) {
    if (!this.session || this.ownChange || !Number.isFinite(value) || value === 0) return;
    if (this.pendingLabel !== null && value !== this.pendingLabel) {
      this.ownChange = true;
      try {
        this.nv.drawPenValue = this.pendingLabel;
      } finally {
        this.ownChange = false;
      }
      // The field appears once FreeBrowse renders the pen controls.
      this.retryPenField();
      return;
    }
    this.pendingLabel = null;
    this.session.label = value;
    this.onPenValue(value);
  }

  handleDrawingChanged({ action }) {
    if (this.ownChange) return;
    if (this.session && action === 'close') {
      const { stage, geometry, volume } = this.session;
      this.session = null;
      this.pendingLabel = null;
      this.onClosedByViewer(drawingToNative(volume.img, geometry), stage);
      return;
    }
    if (this.session || (action !== 'create' && action !== 'load')) return;
    const removed = this.lastRemovedStage;
    const stage = action === 'load' && removed && Date.now() - removed.at < 10000 ? removed.stage : null;
    this.lastRemovedStage = null;
    this.adoption = Promise.resolve(this.onAdopt({ action, stage })).then(async request => {
      if (!request || !this.nv.drawingVolume || this.session) return null;
      await this.begin({ ...request, keepTool: true });
      this.onAdopted(request);
      return request;
    }).catch(() => null);
  }
}
