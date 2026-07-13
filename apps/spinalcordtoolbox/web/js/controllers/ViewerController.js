/**
 * ViewerController
 *
 * Manages NiiVue visualization with support for base volume and segmentation overlays.
 * Manages SCT task colormaps.
 */

export class ViewerController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.viewerConfig = options.viewerConfig || {};
    this.niivueFactory = options.niivueFactory || ((config) => new niivue.Niivue(config));
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.volumeStageIndices = new Map();
    this.sctColormapsRegistered = new Set();
    this.objectUrls = new WeakMap();
    this.stackFileIds = new WeakMap();
    this.nextStackFileId = 1;
    this.currentVolumeStackSignature = null;
    this.compareViewers = new Map();
  }

  isAvailable() {
    return !!this.nv;
  }

  getObjectUrl(file) {
    if (!this.objectUrls.has(file)) {
      this.objectUrls.set(file, URL.createObjectURL(file));
    }
    return this.objectUrls.get(file);
  }

  getStackFileId(file) {
    if (!this.stackFileIds.has(file)) {
      this.stackFileIds.set(file, this.nextStackFileId++);
    }
    return this.stackFileIds.get(file);
  }

  getVolumeStackSignature(entries) {
    return JSON.stringify(entries.map(entry => ({
      fileId: this.getStackFileId(entry.file),
      stage: entry.stage || null,
      colormap: entry.colormap || null,
      opacity: entry.opacity ?? null,
      labelMask: !!entry.labelMask
    })));
  }

  isCurrentVolumeStack(entries) {
    if (!this.isAvailable()) return false;
    if (!this.currentVolumeStackSignature) return false;
    if (this.nv.volumes.length !== entries.length) return false;
    return this.currentVolumeStackSignature === this.getVolumeStackSignature(entries);
  }

  /**
   * Register an SCT discrete colormap with NiiVue.
   * @param {Object} colormapData - { R, G, B, A } arrays from labels.js
   */
  registerSctColormap(colormapData, colormapId = 'sct-spinalcord') {
    if (!this.isAvailable()) return;
    try {
      this.nv.addColormap(colormapId, colormapData);
      this.sctColormapsRegistered.add(colormapId);
    } catch (e) {
      console.warn(`Could not register ${colormapId} colormap:`, e);
    }
  }

  registerVesselColormap(colormapData) {
    this.registerSctColormap(colormapData, 'sct-spinalcord');
  }

  async loadBaseVolume(file, options = {}) {
    if (!this.isAvailable()) return;
    try {
      this.updateOutput(`Loading ${file.name}...`);
      const url = this.getObjectUrl(file);
      await this.nv.loadVolumes([{ url: url, name: file.name }]);
      this.currentBaseFile = file;
      this.currentOverlayFile = null;
      this.currentOverlayIndex = null;
      this.volumeStageIndices.clear();
      if (options.stage) this.volumeStageIndices.set(options.stage, 0);
      this.currentVolumeStackSignature = this.getVolumeStackSignature([{
        file,
        stage: options.stage || null
      }]);
      this.updateOutput(`${file.name} loaded`);
    } catch (error) {
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      console.error(error);
    }
  }

  async loadVolumeStack(entries) {
    if (!this.isAvailable()) return;
    if (!entries.length) {
      this.clearVolumes();
      return;
    }

    if (this.isCurrentVolumeStack(entries)) return;

    // NiiVue's `loadVolumes()` with multiple volumes calls `addVolume()` per
    // entry but the overlay paths (cal_min/cal_max, colormap LUT, opacity)
    // are only correctly initialised when overlays go through
    // `addVolumeFromUrl()` AFTER the base volume is already in place. We
    // therefore reuse the proven `loadBaseVolume` + `loadOverlay` flow here
    // so binary/label-mask overlays actually render. Replacing this with
    // `nv.loadVolumes([...])` silently produced no visible overlay in
    // 0.68.x — covered by `npm run test:viewer`.
    try {
      const [baseEntry, ...overlayEntries] = entries;

      await this.loadBaseVolume(baseEntry.file, { stage: baseEntry.stage });

      if (baseEntry.labelMask) {
        this.configureSegmentationVolume(0, baseEntry.colormap || 'sct-spinalcord');
        this.nv.updateGLVolume();
        this.nv.drawScene?.();
      }

      for (const entry of overlayEntries) {
        await this.loadOverlay(
          entry.file,
          entry.colormap || 'sct-spinalcord',
          entry.opacity ?? 0.5,
          { stage: entry.stage }
        );
      }

      this.currentVolumeStackSignature = this.getVolumeStackSignature(entries);
    } catch (error) {
      this.updateOutput(`Error loading viewer volumes: ${error.message}`);
      console.error(error);
    }
  }

  clearVolumes() {
    if (!this.isAvailable()) {
      this.currentBaseFile = null;
      this.currentOverlayFile = null;
      this.currentOverlayIndex = null;
      this.volumeStageIndices.clear();
      this.currentVolumeStackSignature = null;
      return;
    }
    this.nv.volumes = [];
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.volumeStageIndices.clear();
    this.currentVolumeStackSignature = null;
    this.nv.updateGLVolume();
    this.nv.drawScene?.();
  }

  clearOverlay() {
    if (!this.isAvailable()) return;
    const overlayIndex = this.getOverlayIndex();
    if (overlayIndex === null) return;

    if (typeof this.nv.removeVolumeByIndex === 'function') {
      this.nv.removeVolumeByIndex(overlayIndex);
    } else {
      this.nv.volumes.splice(overlayIndex, 1);
      this.nv.updateGLVolume();
      this.nv.drawScene?.();
    }

    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.currentVolumeStackSignature = null;
  }

  configureSegmentationVolume(index, colormap) {
    if (!this.isAvailable()) return;
    const volume = this.nv.volumes[index];
    if (!volume) return;

    volume.cal_min = 0;
    volume.cal_max = Math.max(1, this.getVolumeDataMax(volume));
    volume.colormap = colormap;
    // Binary/discrete segmentation: disable trilinear smoothing so thin
    // structures don't interpolate to fractional values that miss the LUT.
    volume.interpolation = false;
    if (typeof this.nv.setColormap === 'function' && volume.id) {
      this.nv.setColormap(volume.id, colormap);
    }
  }

  async loadOverlay(file, colormap = 'red', opacity = 0.5, options = {}) {
    if (!this.isAvailable()) return;
    try {
      const url = this.getObjectUrl(file);
      await this.nv.addVolumeFromUrl({
        url: url,
        name: file.name,
        colormap: colormap,
        opacity
      });

      const overlayIndex = this.nv.volumes.length - 1;
      if (overlayIndex > 0) {
        this.configureSegmentationVolume(overlayIndex, colormap);
        this.nv.setOpacity(overlayIndex, opacity);
        this.nv.updateGLVolume();
        this.nv.drawScene?.();
      }

      this.currentOverlayFile = file;
      this.currentOverlayIndex = overlayIndex > 0 ? overlayIndex : null;
      if (options.stage) this.volumeStageIndices.set(options.stage, overlayIndex);
      this.currentVolumeStackSignature = null;
    } catch (error) {
      this.updateOutput(`Error loading overlay: ${error.message}`);
      console.error(error);
    }
  }

  async loadSegmentationAsBase(file, colormap = 'sct-spinalcord', options = {}) {
    await this.loadBaseVolume(file, options);
    this.configureSegmentationVolume(0, colormap);
    this.currentBaseFile = file;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.currentVolumeStackSignature = this.getVolumeStackSignature([{
      file,
      stage: options.stage || null,
      colormap,
      labelMask: true
    }]);
    this.nv.updateGLVolume();
    this.nv.drawScene?.();
  }

  async showResultAsOverlay(baseFile, overlayFile, colormap = 'sct-spinalcord') {
    await this.loadBaseVolume(baseFile);
    if (overlayFile) {
      await this.loadOverlay(overlayFile, colormap);
    }
  }

  applyViewTypeToNv(nv, type) {
    if (!nv) return;
    const typeMap = {
      multiplanar: nv.sliceTypeMultiplanar,
      axial: nv.sliceTypeAxial,
      coronal: nv.sliceTypeCoronal,
      sagittal: nv.sliceTypeSagittal,
      render: nv.sliceTypeRender
    };
    if (typeMap[type] !== undefined) {
      nv.setSliceType(typeMap[type]);
    }
  }

  setViewType(type) {
    if (!this.isAvailable()) return;
    this.applyViewTypeToNv(this.nv, type);
  }

  async loadComparisonVolumes(sessions, options = {}) {
    if (!this.isAvailable()) return false;
    const container = options.container || (options.containerId ? document.getElementById(options.containerId) : null);
    if (!container) return false;

    this.clearComparisonView(container);

    const visibleSessions = sessions
      .filter(session => session?.file)
      .slice(0, options.maxSessions || 4);
    container.dataset.count = String(visibleSessions.length);
    if (!visibleSessions.length) return false;

    const viewType = options.viewType || 'multiplanar';
    const colormap = options.colormap || 'gray';
    const activeSessionId = options.activeSessionId || null;

    for (const session of visibleSessions) {
      const panel = document.createElement('div');
      panel.className = 'comparison-panel';
      if (session.id === activeSessionId) panel.classList.add('active');

      const label = document.createElement('div');
      label.className = 'comparison-label';
      label.textContent = session.name || session.file.name;
      panel.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.id = `comparisonCanvas-${session.id}`;
      panel.appendChild(canvas);
      container.appendChild(panel);

      const compareNv = this.niivueFactory({ ...this.viewerConfig });
      await compareNv.attachTo(canvas.id);
      if (!compareNv.gl) {
        throw new Error(`WebGL2 context unavailable for ${session.name || session.file.name}.`);
      }
      compareNv.setMultiplanarPadPixels?.(5);
      this.applyViewTypeToNv(compareNv, viewType);
      compareNv.setInterpolation?.(true);

      const url = this.getObjectUrl(session.file);
      await compareNv.loadVolumes([{ url, name: session.file.name }]);
      const volume = compareNv.volumes?.[0];
      if (volume) {
        volume.colormap = colormap;
        compareNv.updateGLVolume?.();
      }
      compareNv.drawScene?.();
      this.compareViewers.set(session.id, { nv: compareNv, file: session.file });
    }

    return true;
  }

  clearComparisonView(container = null) {
    for (const { nv } of this.compareViewers.values()) {
      try {
        nv.volumes = [];
        nv.updateGLVolume?.();
        nv.drawScene?.();
        nv.gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
      } catch (error) {
        console.warn('Could not clear comparison viewer:', error);
      }
    }
    this.compareViewers.clear();
    if (container) {
      container.innerHTML = '';
      container.dataset.count = '0';
    }
  }

  setComparisonViewType(type) {
    for (const { nv } of this.compareViewers.values()) {
      this.applyViewTypeToNv(nv, type);
      nv.drawScene?.();
    }
  }

  setComparisonColormap(colormap) {
    for (const { nv } of this.compareViewers.values()) {
      const volume = nv.volumes?.[0];
      if (!volume) continue;
      volume.colormap = colormap;
      nv.updateGLVolume?.();
      nv.drawScene?.();
    }
  }

  getComparisonViewerCount() {
    return this.compareViewers.size;
  }

  setBaseOpacity(value) {
    if (!this.isAvailable()) return;
    if (this.nv.volumes.length > 0) {
      this.nv.setOpacity(0, value);
      this.nv.updateGLVolume();
    }
  }

  setOverlayOpacity(value) {
    if (!this.isAvailable()) return;
    const overlayIndices = this.getOverlayIndices();
    if (overlayIndices.length) {
      overlayIndices.forEach(index => this.nv.setOpacity(index, value));
      this.nv.updateGLVolume();
    }
  }

  setOverlayColormap(colormap) {
    if (!this.isAvailable()) return;
    const overlayIndex = this.getOverlayIndex();
    if (overlayIndex !== null) {
      const overlay = this.nv.volumes[overlayIndex];
      overlay.colormap = colormap;
      if (typeof this.nv.setColormap === 'function' && overlay.id) {
        this.nv.setColormap(overlay.id, colormap);
      }
      this.nv.updateGLVolume();
    }
  }

  getOverlayIndex() {
    if (!this.isAvailable()) return null;
    if (this.currentOverlayIndex !== null && this.nv.volumes[this.currentOverlayIndex]) {
      return this.currentOverlayIndex;
    }
    return this.nv.volumes.length > 1 ? this.nv.volumes.length - 1 : null;
  }

  getOverlayIndices() {
    if (!this.isAvailable()) return [];
    return this.nv.volumes
      .map((_, index) => index)
      .filter(index => index > 0);
  }

  getVolumeIndexForStage(stage) {
    if (!this.isAvailable()) return null;
    const index = this.volumeStageIndices.get(stage);
    if (index === undefined || !this.nv.volumes[index]) return null;
    return index;
  }

  getVolumeDataMax(volume) {
    if (volume?.img?.length) {
      let maxValue = -Infinity;
      for (let i = 0; i < volume.img.length; i++) {
        const value = volume.img[i];
        if (Number.isFinite(value) && value > maxValue) maxValue = value;
      }
      if (Number.isFinite(maxValue)) return maxValue;
    }
    return volume?.global_max ?? 1;
  }

  getCurrentFile() {
    return this.currentBaseFile;
  }
}
