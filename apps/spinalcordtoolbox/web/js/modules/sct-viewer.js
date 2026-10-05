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
 * `showComparison(sessions)` for the multi-session grid. Nothing else in the
 * app adds, removes or reorders NiiVue volumes.
 */

// The bundle is generated next to the app's other runtime files by
// `pnpm runtime-support`; it is never loaded from a CDN.
const VIEWER_MODULE_URL = new URL('../../freebrowse-viewer/index.js', import.meta.url).href;

export const DEFAULT_OVERLAY_OPACITY = 0.7;

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

  constructor({ module, handle, nv, niivueOptions = {}, onLocationChange, onStageVisibilityChange, updateOutput }) {
    this.module = module;
    this.handle = handle;
    this.nv = nv;
    this.niivueOptions = niivueOptions;
    this.onStageVisibilityChange = onStageVisibilityChange || (() => {});
    this.updateOutput = updateOutput || (() => {});
    this.tracked = new Map();
    this.stageOpacity = new Map();
    this.compareViewers = new Map();
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

  async applyVolumes(entries) {
    const nv = this.nv;
    if (!nv) return false;
    this.applying = true;
    try {
      if (!entries.length) {
        if (nv.volumes.length) await nv.removeAllVolumes();
        this.tracked.clear();
        nv.drawScene();
        return true;
      }

      const shown = this.getShownEntries();
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
        this.tracked.clear();
        await nv.loadVolumes([this.volumeOptions(entries[0])]);
        await this.trackVolume(0, entries[0]);
        keep = 1;
      } else {
        for (let index = nv.volumes.length - 1; index >= keep; index -= 1) {
          this.tracked.delete(nv.volumes[index].id);
          await nv.removeVolume(index);
        }
      }

      for (let index = keep; index < entries.length; index += 1) {
        await nv.addVolume(this.volumeOptions(entries[index]));
        await this.trackVolume(index, entries[index]);
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

  async trackVolume(index, entry) {
    const volume = this.nv.volumes[index];
    this.tracked.set(volume.id, { file: entry.file, stage: entry.stage, key: entryKey(entry) });
    if (entry.labelColormap) {
      // NiiVue clamps `I` in place, so it gets its own copy.
      await this.nv.setColormapLabel(index, { ...entry.labelColormap, I: [...entry.labelColormap.I] });
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
   * Show up to `maxSessions` input sessions side by side, each on its own
   * NiiVue canvas inside `container`. Panels start in the main viewer's
   * layout and drag mode, so zoom and pan work the same way in each.
   */
  async showComparison(sessions, { container, activeSessionId, maxSessions = 4 } = {}) {
    if (!container) return false;
    this.clearComparison(container);
    const visible = sessions.filter(session => session?.file).slice(0, maxSessions);
    container.dataset.count = String(visible.length);
    for (const session of visible) {
      const name = session.name || session.file.name;
      const panel = document.createElement('div');
      panel.className = 'comparison-panel';
      if (session.id === activeSessionId) panel.classList.add('active');
      const label = document.createElement('div');
      label.className = 'comparison-label';
      label.textContent = name;
      const canvas = document.createElement('canvas');
      canvas.id = `comparisonCanvas-${session.id}`;
      canvas.setAttribute('aria-label', `Comparison view of ${name}`);
      panel.append(label, canvas);
      container.appendChild(panel);

      const nv = new this.module.NiiVue({ ...this.niivueOptions });
      this.compareViewers.set(session.id, { nv, file: session.file });
      await nv.attachToCanvas(canvas);
      if (!nv.backend) throw new Error(`WebGL2 context unavailable for ${name}.`);
      nv.sliceType = this.nv.sliceType;
      nv.showRender = this.nv.showRender;
      nv.secondaryDragMode = this.nv.secondaryDragMode;
      await nv.loadVolumes([{ url: session.file, name: session.file.name }]);
      nv.drawScene();
    }
    return Boolean(visible.length);
  }

  clearComparison(container = null) {
    for (const { nv } of this.compareViewers.values()) nv.destroy();
    this.compareViewers.clear();
    if (container) {
      container.replaceChildren();
      container.dataset.count = '0';
    }
  }

  getComparisonViewerCount() {
    return this.compareViewers.size;
  }

  destroy() {
    this.clearComparison();
    this.handle?.destroy();
    this.tracked.clear();
    this.nv = null;
  }
}
