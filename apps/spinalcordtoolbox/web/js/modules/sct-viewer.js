/**
 * SctViewer
 *
 * The one owner of what the SCT viewer shows. It mounts the shared FreeBrowse
 * embedding (FreeBrowse UI around a NiiVue 1.0 instance) and turns a requested
 * volume stack into NiiVue calls. FreeBrowse supplies layout selection, zoom
 * and pan, the intensity window, per-volume opacity and colormap, and the
 * Drawing tab; this class only decides which volumes are loaded.
 *
 * `showVolumes(entries)` is the single entry point for the main viewer and
 * `showComparison(panels)` for the multi-session grid. Nothing else in the
 * app adds, removes or reorders NiiVue volumes.
 *
 * Comparison panels are plain NiiVue canvases from the same bundle, not
 * FreeBrowse embeds: each embed would add a second sidebar and toolbar per
 * panel, and its controls could not be linked. The main FreeBrowse stays
 * mounted (hidden) while comparing, so returning to Single keeps its state.
 */

// The bundle is generated next to the app's other runtime files by
// `pnpm runtime-support`; it is never loaded from a CDN.
const VIEWER_MODULE_URL = new URL('../../freebrowse-viewer/index.js', import.meta.url).href;

export const DEFAULT_OVERLAY_OPACITY = 0.7;

// Four panels plus the hidden main viewer is five live WebGL2 contexts,
// well under the 16 a page may hold in Chromium and WebKit.
export const MAX_COMPARISON_PANELS = 4;

// What linked panels share, through NiiVue's own sync: 2D zoom and pan, the
// 3D view, the crosshair in world (mm) coordinates, and the slice layout.
export const COMPARISON_SYNC = Object.freeze({ '2d': true, '3d': true, crosshair: true, sliceType: true });

// Axial, coronal, sagittal and multiplanar: the layouts a comparison offers.
const COMPARISON_SLICE_TYPES = [0, 1, 2, 3];

/** The panels to show: the first `max` sessions, always including the active one. */
export function selectComparisonPanels(panels, activeSessionId, max = MAX_COMPARISON_PANELS) {
  const candidates = panels.filter(panel => panel?.id && (panel.entries?.length || panel.file));
  const shown = candidates.slice(0, max);
  const active = candidates.find(panel => panel.id === activeSessionId);
  if (active && shown.length && !shown.includes(active)) shown[shown.length - 1] = active;
  return shown;
}

const entryKey = entry => `${entry.stage || ''}|${entry.colormapKey || ''}`;

export class SctViewer {
  /**
   * Mount FreeBrowse into `element` and wait for its canvas. Rejects when the
   * bundle cannot be loaded or NiiVue cannot create a WebGL2 context, so the
   * caller can fall back to the 2D preview.
   */
  static async mount({ element, niivueOptions = {}, canvasLabel, loadModule, ...callbacks }) {
    const module = await (loadModule ? loadModule() : import(VIEWER_MODULE_URL));
    const handle = module.mountViewer(element, niivueOptions, { canvasLabel });
    try {
      const nv = await handle.ready;
      // Belt-and-braces for a NiiVue that resolves without a rendering backend.
      if (!nv?.backend) throw new Error('WebGL2 context unavailable after attach.');
      nv.showRender = module.SHOW_RENDER.NEVER;
      return new SctViewer({ module, handle, nv, niivueOptions, ...callbacks });
    } catch (error) {
      handle.destroy();
      throw error;
    }
  }

  constructor({ module, handle, nv, niivueOptions = {}, onLocationChange, onStageVisibilityChange, onComparisonActivate, onComparisonLocation, updateOutput }) {
    this.module = module;
    this.handle = handle;
    this.nv = nv;
    this.niivueOptions = niivueOptions;
    this.onStageVisibilityChange = onStageVisibilityChange || (() => {});
    this.updateOutput = updateOutput || (() => {});
    this.tracked = new Map();
    this.stageOpacity = new Map();
    this.compareViewers = new Map();
    this.compareContainer = null;
    this.compareActiveId = null;
    this.compareLinked = true;
    this.compareSliceType = null;
    this.onComparisonActivate = onComparisonActivate || (() => {});
    this.onComparisonLocation = onComparisonLocation || (() => {});
    this.applying = false;
    this.queue = Promise.resolve();

    nv.addEventListener('locationChange', event => onLocationChange?.(event.detail));
    nv.addEventListener('volumeUpdated', event => this.handleVolumeUpdated(event.detail));
    // NiiVue reports a removal before it mutates its volume list.
    nv.addEventListener('volumeRemoved', () => queueMicrotask(() => this.handleVolumeRemoved()));
  }

  isAvailable() {
    return Boolean(this.nv);
  }

  // ==================== Main viewer stack ====================

  /**
   * Show exactly `entries`, bottom to top. Each entry is
   * `{ file, stage, visible, colormapKey, labelColormap }`; an entry with a
   * `labelColormap` is a label mask. Requests are applied in order, and only
   * the part of the stack that changed is reloaded, so the user's zoom, pan,
   * layout and intensity window survive result updates and eye toggles.
   */
  showVolumes(entries = []) {
    const request = this.queue.then(() => this.applyVolumes(entries));
    this.queue = request.catch(() => {});
    return request;
  }

  getShownEntries() {
    return (this.nv?.volumes || []).map(volume => this.tracked.get(volume.id) || null);
  }

  getVolumeIndexForStage(stage) {
    const index = this.getShownEntries().findIndex(entry => entry?.stage === stage);
    return index < 0 ? null : index;
  }

  getStageOpacity(stage, isLabelMask) {
    return this.stageOpacity.get(stage) ?? (isLabelMask ? DEFAULT_OVERLAY_OPACITY : 1);
  }

  applyVolumes(entries) {
    return this.applyStack(this, entries);
  }

  // `target` is the main viewer (`this`) or a comparison panel record; both
  // carry `nv` and `tracked` (NiiVue volume id → shown entry).
  async applyStack(target, entries) {
    const nv = target.nv;
    if (!nv) return false;
    this.applying = true;
    try {
      if (!entries.length) {
        if (nv.volumes.length) await nv.removeAllVolumes();
        target.tracked.clear();
        nv.drawScene();
        return true;
      }

      const shown = nv.volumes.map(volume => target.tracked.get(volume.id) || null);
      let keep = 0;
      if (shown.every(Boolean)) {
        while (
          keep < shown.length
          && keep < entries.length
          && shown[keep].file === entries[keep].file
          && shown[keep].key === entryKey(entries[keep])
        ) keep += 1;
      }

      if (keep === 0) {
        target.tracked.clear();
        await nv.loadVolumes([this.volumeOptions(entries[0])]);
        await this.trackVolume(target, 0, entries[0]);
        keep = 1;
      } else {
        for (let index = nv.volumes.length - 1; index >= keep; index -= 1) {
          target.tracked.delete(nv.volumes[index].id);
          await nv.removeVolume(index);
        }
      }

      for (let index = keep; index < entries.length; index += 1) {
        await nv.addVolume(this.volumeOptions(entries[index]));
        await this.trackVolume(target, index, entries[index]);
      }

      for (let index = 0; index < entries.length; index += 1) {
        const opacity = this.entryOpacity(entries[index]);
        if (nv.volumes[index].opacity !== opacity) await nv.setVolume(index, { opacity });
      }
      nv.drawScene();
      return true;
    } catch (error) {
      this.updateOutput(`Error loading viewer volumes: ${error.message}`);
      return false;
    } finally {
      this.applying = false;
    }
  }

  entryOpacity(entry) {
    return entry.visible === false ? 0 : this.getStageOpacity(entry.stage, Boolean(entry.labelColormap));
  }

  volumeOptions(entry) {
    return { url: entry.file, name: entry.file.name, opacity: this.entryOpacity(entry) };
  }

  async trackVolume(target, index, entry) {
    const volume = target.nv.volumes[index];
    target.tracked.set(volume.id, { file: entry.file, stage: entry.stage, key: entryKey(entry) });
    if (entry.labelColormap) {
      // NiiVue clamps `I` in place, so it gets its own copy.
      await target.nv.setColormapLabel(index, { ...entry.labelColormap, I: [...entry.labelColormap.I] });
    }
  }

  // FreeBrowse's own opacity slider and eye write straight to NiiVue. Mirror
  // them so the Results eye buttons and FreeBrowse never disagree.
  handleVolumeUpdated({ volume, changes } = {}) {
    if (this.applying || changes?.opacity === undefined) return;
    const entry = this.tracked.get(volume?.id);
    if (!entry?.stage) return;
    if (changes.opacity > 0) this.stageOpacity.set(entry.stage, changes.opacity);
    this.onStageVisibilityChange(entry.stage, changes.opacity > 0);
  }

  handleVolumeRemoved() {
    if (this.applying) return;
    const present = new Set(this.nv.volumes.map(volume => volume.id));
    for (const [id, entry] of [...this.tracked]) {
      if (present.has(id)) continue;
      this.tracked.delete(id);
      if (entry.stage) this.onStageVisibilityChange(entry.stage, false);
    }
  }

  // ==================== Export ====================

  async saveScreenshot(filename) {
    return this.nv.saveBitmap(filename);
  }

  async downloadVolume(index, filename) {
    return this.nv.saveVolume({ filename, volumeByIndex: index });
  }

  // ==================== Multi-session comparison ====================

  /**
   * Show input sessions side by side, one plain NiiVue canvas per session in
   * `container`. `panels` is `[{ id, name, entries }]`, where `entries` is the
   * stack `showVolumes()` takes: that session's input, then its own label
   * masks. Panels persist between calls and only a changed stack reloads, so
   * zoom, pan and crosshair survive new results and session switches. At most
   * `maxPanels` are shown, always including the active session.
   */
  showComparison(panels, options = {}) {
    const request = this.queue.then(() => this.applyComparison(panels, options));
    this.queue = request.catch(() => {});
    return request;
  }

  async applyComparison(panels = [], { container, activeSessionId = null, maxPanels = MAX_COMPARISON_PANELS } = {}) {
    if (!container || !this.nv) return false;
    this.compareContainer = container;
    const shown = selectComparisonPanels(panels, activeSessionId, maxPanels);
    const wanted = new Set(shown.map(panel => panel.id));
    for (const id of [...this.compareViewers.keys()]) {
      if (!wanted.has(id)) this.releaseComparisonPanel(id);
    }
    if (this.compareSliceType === null) this.compareSliceType = this.defaultComparisonSliceType();

    let created = false;
    for (const [index, panel] of shown.entries()) {
      let record = this.compareViewers.get(panel.id);
      if (!record) {
        record = await this.createComparisonPanel(panel);
        created = true;
      }
      const anchor = container.children[index] || null;
      if (anchor !== record.element) container.insertBefore(record.element, anchor);
      this.labelComparisonPanel(record, panel, panel.id === activeSessionId);
      await this.applyStack(record, panel.entries || [{ file: panel.file, stage: 'input' }]);
    }
    container.dataset.count = String(shown.length);
    const activeChanged = this.compareActiveId !== activeSessionId;
    this.compareActiveId = activeSessionId;
    if (created || activeChanged) this.setComparisonLinked(this.compareLinked);
    return shown.length > 0;
  }

  defaultComparisonSliceType() {
    const sliceType = this.nv?.sliceType;
    return COMPARISON_SLICE_TYPES.includes(sliceType) ? sliceType : this.module.SLICE_TYPE.MULTIPLANAR;
  }

  async createComparisonPanel(panel) {
    const element = document.createElement('div');
    element.className = 'nd-compare-panel';
    element.dataset.sessionId = panel.id;
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'nd-compare-title';
    const canvas = document.createElement('canvas');
    canvas.id = `comparisonCanvas-${panel.id}`;
    element.append(title, canvas);
    // NiiVue sizes its canvas from layout, so the panel joins the grid first.
    this.compareContainer.appendChild(element);

    const nv = new this.module.NiiVue({ ...this.niivueOptions });
    const record = { id: panel.id, nv, element, title, canvas, tracked: new Map() };
    this.compareViewers.set(panel.id, record);
    try {
      await nv.attachToCanvas(canvas);
      if (!nv.backend) throw new Error(`WebGL2 context unavailable for ${panel.name || panel.id}.`);
    } catch (error) {
      this.releaseComparisonPanel(panel.id);
      throw error;
    }
    nv.sliceType = this.compareSliceType;
    nv.showRender = this.nv.showRender;
    nv.secondaryDragMode = this.nv.secondaryDragMode;
    // A label legend takes a third of a half-width panel; the info bar under
    // the viewer names the label at the crosshair instead.
    nv.isLegendVisible = false;
    nv.addEventListener('locationChange', event => this.onComparisonLocation(panel.id, event.detail));
    // Pointer users pick a panel by working in it, keyboard users by its title.
    element.addEventListener('pointerdown', () => this.onComparisonActivate(panel.id));
    title.addEventListener('click', () => this.onComparisonActivate(panel.id));
    return record;
  }

  labelComparisonPanel(record, panel, active) {
    const name = panel.name || panel.id;
    record.title.textContent = active ? `${name} · active` : name;
    record.title.title = active ? `${name} is used for processing` : `Use ${name} for processing`;
    record.title.setAttribute('aria-pressed', String(active));
    record.element.setAttribute('aria-current', String(active));
    record.canvas.setAttribute('aria-label', `Comparison view of ${name}`);
  }

  /**
   * Link or unlink the panels. Linked panels follow each other through
   * NiiVue's own `broadcastTo`, which maps the crosshair through world (mm)
   * coordinates; on linking, the active panel leads.
   */
  setComparisonLinked(linked) {
    this.compareLinked = Boolean(linked);
    const viewers = [...this.compareViewers.values()].map(record => record.nv);
    for (const nv of viewers) {
      const others = viewers.filter(other => other !== nv);
      if (this.compareLinked && others.length) nv.broadcastTo(others, COMPARISON_SYNC);
      else nv.broadcastTo();
    }
    if (this.compareLinked) this.compareViewers.get(this.compareActiveId)?.nv.drawScene();
  }

  isComparisonLinked() {
    return this.compareLinked;
  }

  setComparisonSliceType(sliceType) {
    this.compareSliceType = sliceType;
    for (const { nv } of this.compareViewers.values()) nv.sliceType = sliceType;
  }

  getComparisonSliceType() {
    return this.compareSliceType ?? this.defaultComparisonSliceType();
  }

  async saveComparisonScreenshot(sessionId, filename) {
    const record = this.compareViewers.get(sessionId);
    if (!record) return false;
    return record.nv.saveBitmap(filename);
  }

  releaseComparisonPanel(id) {
    const record = this.compareViewers.get(id);
    if (!record) return;
    this.compareViewers.delete(id);
    record.nv.broadcastTo?.();
    record.nv.destroy();
    record.element.remove?.();
  }

  clearComparison(container = this.compareContainer) {
    for (const id of [...this.compareViewers.keys()]) this.releaseComparisonPanel(id);
    this.compareActiveId = null;
    if (container) {
      container.replaceChildren();
      container.dataset.count = '0';
    }
  }

  getComparisonViewerCount() {
    return this.compareViewers.size;
  }

  getComparisonViewer(sessionId) {
    return this.compareViewers.get(sessionId)?.nv || null;
  }

  destroy() {
    this.clearComparison();
    this.compareContainer = null;
    this.handle?.destroy();
    this.tracked.clear();
    this.nv = null;
  }
}
