import { createNiftiFromVolume } from '../file-io/NiftiUtils.js';
import { downloadArrayBuffer } from '../file-io/download.js';

export class ViewerController {
  constructor(options = {}) {
    this.nv = options.nv || null;
    this.updateOutput = options.updateOutput || (() => {});
    this.viewerConfig = options.viewerConfig || {};
    this.niivueFactory = options.niivueFactory || (config => new globalThis.niivue.Niivue(config));
    this.NVImage = options.NVImage || null;
    this.decodedUrls = new Map();
    this.insertedUrls = new Map();
    this.currentBaseFile = this.currentOverlayFile = this.currentFile = null;
    this.currentOverlayIndex = null;
    this.volumeStageIndices = new Map();
    this.stageVisibility = new Map();
    this.stageOpacity = new Map();
    this.registeredColormaps = new Set();
    this.sctColormapsRegistered = this.registeredColormaps;
    this.objectUrls = new Map();
    this.volumeFiles = [];
    this.stackFileIds = new WeakMap();
    this.nextStackFileId = 1;
    this.currentVolumeStackSignature = null;
    this.compareViewers = new Map();
  }

  isAvailable() { return Boolean(this.nv); }
  getObjectUrl(file) {
    if (!this.objectUrls.has(file)) this.objectUrls.set(file, URL.createObjectURL(file));
    return this.objectUrls.get(file);
  }
  getActiveObjectUrlFiles() {
    return new Set([
      ...this.volumeFiles.filter(Boolean),
      ...[...this.compareViewers.values()].map(entry => entry.file).filter(Boolean),
    ]);
  }
  releaseUnusedObjectUrls() {
    for (const [image, url] of this.insertedUrls) {
      if (this.nv?.volumes?.includes(image)) continue;
      URL.revokeObjectURL(url);
      this.insertedUrls.delete(image);
    }
    const activeFiles = this.getActiveObjectUrlFiles();
    for (const [file, url] of this.objectUrls) {
      if (activeFiles.has(file)) continue;
      URL.revokeObjectURL(url);
      this.objectUrls.delete(file);
    }
  }
  getStackFileId(file) { if (!this.stackFileIds.has(file)) this.stackFileIds.set(file, this.nextStackFileId++); return this.stackFileIds.get(file); }
  getVolumeStackSignature(entries) {
    return JSON.stringify(entries.map(e => ({ id: this.getStackFileId(e.file), stage: e.stage || null, colormap: e.colormap || null, opacity: e.opacity ?? null, visible: e.visible ?? null, labelMask: !!e.labelMask, scalar: !!e.scalar, symmetricCal: !!e.symmetricCal })));
  }
  isCurrentVolumeStack(entries) { return this.isAvailable() && this.currentVolumeStackSignature === this.getVolumeStackSignature(entries) && this.nv.volumes?.length === entries.length; }

  registerColormap(id, data) {
    if (!this.isAvailable() || !id || !data) return false;
    try { this.nv.addColormap(id, data); this.registeredColormaps.add(id); return true; }
    catch (error) { this.updateOutput(`Could not register colormap ${id}: ${error.message}`); return false; }
  }
  registerSctColormap(data, id = 'sct-spinalcord') { return this.registerColormap(id, data); }
  registerVesselColormap(data) { return this.registerColormap('vesselboost', data); }
  registerMuscleColormap(data) { return this.registerColormap('musclemap', data); }

  // Two-phase loading, for a caller that can be superseded while a file is
  // fetched and decoded. A load given `assertCurrent` decodes the file away
  // from the viewer, calls `assertCurrent()`, which throws when the load is no
  // longer wanted, and then puts the decoded image into NiiVue and into this
  // controller's record in one synchronous step, ending with `onCommit()`.
  // Nothing can run between the check and the commit, so a superseded load
  // never reaches the viewer. Without `assertCurrent` NiiVue fetches, decodes
  // and inserts in one call that cannot be stopped.
  //
  // A decode owns the object URL it creates. It releases that URL itself when
  // it fails or its image is not inserted, and hands it to the image when the
  // image is inserted, where it lives until the image leaves the viewer. No
  // decode shares a URL with another, so the end of one, however it ends,
  // cannot take the file away from another that is still fetching it.
  async decodeVolume(file, entry = {}) {
    const NVImage = this.NVImage || globalThis.niivue?.NVImage;
    if (!NVImage) throw new Error('ViewerController: NVImage is required for a load with assertCurrent');
    const url = URL.createObjectURL(file);
    try {
      const image = await NVImage.loadFromUrl({ url, name: file.name, ...entry });
      this.decodedUrls.set(image, url);
      return image;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  discardDecodedVolume(image) {
    const url = this.decodedUrls.get(image);
    if (!url) return;
    this.decodedUrls.delete(image);
    URL.revokeObjectURL(url);
  }

  // The caller's check decides first, also when a decode failed: whatever
  // `assertCurrent` throws leaves the load unchanged, so a superseded load is
  // inert however it ends and a refusal reaches the caller. Only a failure of
  // a load that is still wanted is reported (`failure`).
  async decodeCurrent(decodes, assertCurrent) {
    const settled = await Promise.allSettled(decodes);
    const images = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failed = settled.find(result => result.status === 'rejected');
    try {
      assertCurrent();
    } catch (error) {
      images.forEach(image => this.discardDecodedVolume(image));
      throw error;
    }
    if (!failed) return { images };
    images.forEach(image => this.discardDecodedVolume(image));
    return { failure: failed.reason };
  }

  // What NiiVue's addVolumeFromUrl does once the image is decoded.
  insertDecodedVolume(image, file) {
    const url = this.decodedUrls.get(image);
    this.decodedUrls.delete(image);
    this.insertedUrls.set(image, url);
    this.nv.document?.addImageOptions?.(image, { url, name: file.name });
    image.onColormapChange = this.nv.onColormapChange;
    this.nv.mediaUrlMap?.set(image, url);
    this.nv.addVolume(image);
  }

  decodeBaseVolume(file) {
    return this.decodeVolume(file, {
      trustCalMinMax: this.nv.opts?.trustCalMinMax,
      limitFrames4D: this.nv.opts?.limitFrames4D
    });
  }

  async loadCheckedBaseVolume(file, options) {
    this.updateOutput(`Loading ${file.name}...`);
    const { images, failure } = await this.decodeCurrent([this.decodeBaseVolume(file)], options.assertCurrent);
    if (failure) {
      this.updateOutput(`Error loading ${file.name}: ${failure.message}`);
      return false;
    }
    this.commitBaseVolume(images[0], file, options);
    options.onCommit?.();
    return true;
  }

  async loadBaseVolume(file, options = {}) {
    if (!this.isAvailable()) return false;
    if (options.assertCurrent) return this.loadCheckedBaseVolume(file, options);
    try {
      this.updateOutput(`Loading ${file.name}...`);
      await this.nv.loadVolumes([{ url: this.getObjectUrl(file), name: file.name }]);
      this.recordBaseVolume(file, options);
      return true;
    } catch (error) {
      this.releaseUnusedObjectUrls();
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      return false;
    }
  }

  commitBaseVolume(image, file, options = {}) {
    this.nv.volumes = [];
    this.nv.closePAQD?.();
    this.insertDecodedVolume(image, file);
    this.recordBaseVolume(file, options);
  }

  recordBaseVolume(file, options = {}) {
    this.currentBaseFile = this.currentFile = file;
    this.currentOverlayFile = null; this.currentOverlayIndex = null; this.volumeStageIndices.clear();
    this.stageVisibility.clear(); this.stageOpacity.clear(); this.volumeFiles = [file];
    if (options.stage) {
      this.volumeStageIndices.set(options.stage, 0);
      this.setStageOpacity(options.stage, options.opacity ?? 1);
      this.setStageVisibilityState(options.stage, options.visible !== false, options.visible !== undefined);
      this.applyStageOpacity(options.stage);
    }
    this.currentVolumeStackSignature = this.getVolumeStackSignature([{ file, ...options }]);
    if (options.releaseUnusedUrls !== false) this.releaseUnusedObjectUrls();
    this.updateOutput(`${file.name} loaded`);
  }

  overlayConfig(colormapOrOptions, opacity, options) {
    const config = typeof colormapOrOptions === 'object' ? { ...colormapOrOptions } : { ...options, colormap: colormapOrOptions, opacity };
    return { ...config, colormap: config.colormap || 'red', opacity: config.opacity ?? 0.5 };
  }

  // Every entry is decoded before the first one is inserted, so the viewer
  // goes from its previous volumes to the whole stack in one step.
  async loadCheckedVolumeStack(entries, options) {
    const [base, ...overlays] = entries;
    const configs = overlays.map(entry => this.overlayConfig(entry.colormap || 'labels', entry.opacity ?? 0.5, { ...entry, releaseUnusedUrls: false }));
    const { images, failure } = await this.decodeCurrent([
      this.decodeBaseVolume(base.file),
      ...overlays.map((entry, index) => this.decodeVolume(entry.file, { colormap: configs[index].colormap, opacity: configs[index].opacity }))
    ], options.assertCurrent);
    if (failure) {
      this.updateOutput(`Error loading viewer volumes: ${failure.message}`);
      return false;
    }
    this.commitBaseVolume(images[0], base.file, { ...base, releaseUnusedUrls: false });
    if (base.labelMask) this.configureSegmentationVolume(0, base.colormap || 'labels');
    overlays.forEach((entry, index) => this.commitOverlay(images[index + 1], entry.file, configs[index]));
    this.currentVolumeStackSignature = this.getVolumeStackSignature(entries);
    this.releaseUnusedObjectUrls();
    options.onCommit?.();
    return true;
  }

  async loadVolumeStack(entries = [], options = {}) {
    if (!this.isAvailable()) return false;
    if (!entries.length || this.isCurrentVolumeStack(entries)) {
      options.assertCurrent?.();
      if (!entries.length) this.clearVolumes();
      options.onCommit?.();
      return true;
    }
    if (options.assertCurrent) return this.loadCheckedVolumeStack(entries, options);
    try {
      const [base, ...overlays] = entries;
      if (!await this.loadBaseVolume(base.file, { ...base, releaseUnusedUrls: false })) {
        this.clearVolumes();
        return false;
      }
      if (base.labelMask) this.configureSegmentationVolume(0, base.colormap || 'labels');
      for (const entry of overlays) {
        const loaded = await this.loadOverlay(entry.file, entry.colormap || 'labels', entry.opacity ?? 0.5, {
          ...entry,
          releaseUnusedUrls: false,
        });
        if (!loaded) {
          this.clearVolumes();
          return false;
        }
      }
      this.currentVolumeStackSignature = this.getVolumeStackSignature(entries);
      this.releaseUnusedObjectUrls();
      return true;
    } catch (error) {
      this.clearVolumes();
      this.updateOutput(`Error loading viewer volumes: ${error.message}`);
      return false;
    }
  }

  async loadOverlay(file, colormapOrOptions = 'red', opacity = 0.5, options = {}) {
    if (!this.isAvailable()) return false;
    const config = this.overlayConfig(colormapOrOptions, opacity, options);
    if (config.assertCurrent) return this.loadCheckedOverlay(file, config);
    try {
      await this.nv.addVolumeFromUrl({ url: this.getObjectUrl(file), name: file.name, colormap: config.colormap, opacity: config.opacity });
      this.recordOverlay(file, config);
      return true;
    } catch (error) {
      this.releaseUnusedObjectUrls();
      this.updateOutput(`Error loading overlay: ${error.message}`);
      return false;
    }
  }

  async loadCheckedOverlay(file, config) {
    const decode = this.decodeVolume(file, { colormap: config.colormap, opacity: config.opacity });
    const { images, failure } = await this.decodeCurrent([decode], config.assertCurrent);
    if (failure) {
      this.updateOutput(`Error loading overlay: ${failure.message}`);
      return false;
    }
    this.commitOverlay(images[0], file, config);
    config.onCommit?.();
    return true;
  }

  commitOverlay(image, file, config) {
    this.insertDecodedVolume(image, file);
    this.recordOverlay(file, config);
  }

  recordOverlay(file, config) {
    const colormap = config.colormap;
    const appliedOpacity = config.opacity;
    const index = this.nv.volumes.length - 1;
    if (index > 0) {
      if (config.scalar) this.configureScalarVolume(index, colormap, config); else this.configureSegmentationVolume(index, colormap);
      this.nv.setOpacity?.(index, appliedOpacity); this.nv.updateGLVolume?.(); this.nv.drawScene?.();
    }
    this.volumeFiles[index] = file;
    this.currentOverlayFile = this.currentFile = file; this.currentOverlayIndex = index > 0 ? index : null;
    if (config.stage) {
      this.volumeStageIndices.set(config.stage, index); this.setStageOpacity(config.stage, appliedOpacity);
      this.setStageVisibilityState(config.stage, config.visible !== false, config.visible !== undefined); this.applyStageOpacity(config.stage);
    }
    this.currentVolumeStackSignature = null;
    if (config.releaseUnusedUrls !== false) this.releaseUnusedObjectUrls();
  }

  async replaceOverlayForStage(stage, file, colormap = 'red', opacity = 0.5, options = {}) { this.removeVolumeForStage(stage); return this.loadOverlay(file, colormap, opacity, { ...options, stage }); }
  async replaceOverlay(file, colormap = 'red', opacity = 0.5) { await this.clearOverlayVolumes(); return this.loadOverlay(file, colormap, opacity); }
  async loadSegmentationAsBase(file, colormapOrOptions = 'labels', options = {}) {
    const config = typeof colormapOrOptions === 'object' ? colormapOrOptions : { ...options, colormap: colormapOrOptions };
    if (!await this.loadBaseVolume(file, config)) return false;
    this.configureSegmentationVolume(0, config.colormap || 'labels');
    this.currentVolumeStackSignature = this.getVolumeStackSignature([{ file, ...config, labelMask: true }]);
    this.nv.updateGLVolume?.(); this.nv.drawScene?.(); return true;
  }
  async showResultAsOverlay(base, overlay, colormap = 'labels', options = {}) {
    if (!await this.loadBaseVolume(base, { opacity: options.baseOpacity ?? 1 })) return false;
    return overlay ? this.loadOverlay(overlay, colormap, options.overlayOpacity ?? 0.5) : true;
  }

  configureSegmentationVolume(index, colormap = 'labels') {
    const volume = this.nv?.volumes?.[index]; if (!volume) return;
    volume.cal_min = 0; volume.cal_max = Math.max(1, this.getVolumeDataMax(volume)); volume.colormap = colormap; volume.interpolation = false;
    if (volume.id) this.nv.setColormap?.(volume.id, colormap);
  }
  configureLabelVolume(index, colormap) { this.configureSegmentationVolume(index, colormap); }
  configureScalarVolume(index, colormap, options = {}) {
    const volume = this.nv?.volumes?.[index]; if (!volume) return; const range = this.getVolumeDataRange(volume);
    if (options.symmetricCal) { const limit = Math.max(range.maxAbs, 1e-6); volume.cal_min = -limit; volume.cal_max = limit; }
    else { volume.cal_min = range.min; volume.cal_max = range.max > range.min ? range.max : range.min + 1; }
    volume.colormap = colormap; volume.interpolation = true; if (volume.id) this.nv.setColormap?.(volume.id, colormap);
  }

  clearVolumes() {
    if (this.nv) { this.nv.volumes = []; this.nv.updateGLVolume?.(); this.nv.drawScene?.(); }
    this.currentBaseFile = this.currentOverlayFile = this.currentFile = null; this.currentOverlayIndex = null;
    this.volumeStageIndices.clear(); this.stageVisibility.clear(); this.stageOpacity.clear();
    this.volumeFiles = []; this.currentVolumeStackSignature = null; this.releaseUnusedObjectUrls();
  }
  clearOverlay() { const index = this.getOverlayIndex(); if (index !== null) this.removeVolumeAtIndex(index); this.currentOverlayFile = null; this.currentOverlayIndex = null; }
  async clearOverlayVolumes() { while ((this.nv?.volumes?.length || 0) > 1) this.removeVolumeAtIndex(this.nv.volumes.length - 1); this.currentOverlayFile = null; this.currentOverlayIndex = null; }
  removeVolumeAtIndex(index) {
    if (!this.nv?.volumes?.[index]) return false;
    if (this.nv.removeVolumeByIndex) this.nv.removeVolumeByIndex(index); else this.nv.volumes.splice(index, 1);
    this.volumeFiles.splice(index, 1);
    for (const [stage, mapped] of [...this.volumeStageIndices]) { if (mapped === index) this.volumeStageIndices.delete(stage); else if (mapped > index) this.volumeStageIndices.set(stage, mapped - 1); }
    if (this.currentOverlayIndex === index) this.currentOverlayIndex = null; else if (this.currentOverlayIndex > index) this.currentOverlayIndex -= 1;
    this.currentVolumeStackSignature = null; this.releaseUnusedObjectUrls(); this.nv.updateGLVolume?.(); this.nv.drawScene?.(); return true;
  }
  removeVolumeForStage(stage) { const index = this.getVolumeIndexForStage(stage); return index !== null && index !== 0 ? this.removeVolumeAtIndex(index) : false; }

  setStageOpacity(stage, opacity, options = {}) { this.stageOpacity.set(stage, Number(opacity)); if (options.apply) this.applyStageOpacity(stage, options.redraw); return this.getVolumeIndexForStage(stage) !== null; }
  setStageVisibilityState(stage, visible, force = false) { if (force || !this.stageVisibility.has(stage)) this.stageVisibility.set(stage, Boolean(visible)); }
  setStageVisible(stage, visible) { this.stageVisibility.set(stage, Boolean(visible)); return this.applyStageOpacity(stage, true); }
  isStageVisible(stage) { return this.stageVisibility.get(stage) !== false; }
  applyStageOpacity(stage, redraw = false) {
    const index = this.getVolumeIndexForStage(stage); if (index === null) return false;
    this.nv.setOpacity?.(index, this.isStageVisible(stage) ? (this.stageOpacity.get(stage) ?? 1) : 0); this.nv.updateGLVolume?.(); if (redraw) this.nv.drawScene?.(); return true;
  }

  applyViewTypeToNv(nv, type) { const value = nv && ({ multiplanar: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial, coronal: nv.sliceTypeCoronal, sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender })[type]; if (value !== undefined) nv.setSliceType(value); }
  setViewType(type) { this.applyViewTypeToNv(this.nv, type); }
  setBaseOpacity(value) { if (this.nv?.volumes?.length) { this.nv.setOpacity?.(0, Number(value)); this.nv.updateGLVolume?.(); } }
  setOverlayOpacity(value) {
    for (const index of this.getOverlayIndices()) {
      const stage = this.getStageForVolumeIndex(index);
      if (stage) {
        this.stageOpacity.set(stage, Number(value));
        this.nv.setOpacity?.(index, this.isStageVisible(stage) ? Number(value) : 0);
      } else {
        this.nv.setOpacity?.(index, Number(value));
      }
    }
    this.nv?.updateGLVolume?.();
  }
  setOverlayColormap(colormap) { for (const index of this.getOverlayIndices()) { const volume = this.nv.volumes[index]; volume.colormap = colormap; if (volume.id) this.nv.setColormap?.(volume.id, colormap); } this.nv?.updateGLVolume?.(); }
  setWindowLevel(min, max, index = 0) { const volume = this.nv?.volumes?.[index]; if (!volume) return false; volume.cal_min = Number(min); volume.cal_max = Number(max); this.nv.updateGLVolume?.(); this.nv.drawScene?.(); return true; }
  setInterpolation(enabled) { for (const volume of this.nv?.volumes || []) volume.interpolation = Boolean(enabled); this.nv?.updateGLVolume?.(); }
  setColorbarVisible(visible) { if (this.nv) { this.nv.opts ||= {}; this.nv.opts.isColorbar = Boolean(visible); this.nv.drawScene?.(); } }
  setCrosshairVisible(visible, width = 0.75) { if (this.nv) { this.nv.opts ||= {}; this.nv.opts.crosshairWidth = visible ? width : 0; this.nv.drawScene?.(); } }
  getOverlayIndex() { return this.currentOverlayIndex !== null && this.nv?.volumes?.[this.currentOverlayIndex] ? this.currentOverlayIndex : (this.nv?.volumes?.length > 1 ? this.nv.volumes.length - 1 : null); }
  getOverlayIndices() { return (this.nv?.volumes || []).map((_, i) => i).filter(i => i > 0); }
  getVolumeIndexForStage(stage) { const index = this.volumeStageIndices.get(stage); return index !== undefined && this.nv?.volumes?.[index] ? index : null; }
  getStageForVolumeIndex(index) { for (const [stage, mapped] of this.volumeStageIndices) if (mapped === index) return stage; return null; }
  getCurrentFile() { return this.currentFile || this.currentBaseFile; }
  getVolumeDataRange(volume) { let min = Infinity; let max = -Infinity; for (const value of volume?.img || []) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); } if (!Number.isFinite(min)) min = volume?.global_min ?? 0; if (!Number.isFinite(max)) max = volume?.global_max ?? 1; return { min, max, maxAbs: Math.max(Math.abs(min), Math.abs(max)) }; }
  getVolumeDataMax(volume) { return this.getVolumeDataRange(volume).max; }

  async loadComparisonVolumes(sessions, options = {}) {
    const container = options.container || (options.containerId ? document.getElementById(options.containerId) : null); if (!container) return false;
    this.clearComparisonView(container); const visible = sessions.filter(s => s?.file).slice(0, options.maxSessions || 4); container.dataset.count = String(visible.length);
    for (const session of visible) {
      const panel = document.createElement('div'); panel.className = 'comparison-panel'; if (session.id === options.activeSessionId) panel.classList.add('active');
      const label = document.createElement('div'); label.className = 'comparison-label'; label.textContent = session.name || session.file.name;
      const canvas = document.createElement('canvas'); canvas.id = `comparisonCanvas-${session.id}`; panel.appendChild(label); panel.appendChild(canvas); container.appendChild(panel);
      const nv = this.niivueFactory({ ...this.viewerConfig }); await nv.attachTo(canvas.id); if (!nv.gl) throw new Error(`WebGL2 context unavailable for ${session.name || session.file.name}.`);
      nv.setMultiplanarPadPixels?.(5); this.applyViewTypeToNv(nv, options.viewType || 'multiplanar'); nv.setInterpolation?.(true);
      try {
        await nv.loadVolumes([{ url: this.getObjectUrl(session.file), name: session.file.name }]);
      } catch (error) {
        this.releaseUnusedObjectUrls();
        throw error;
      }
      if (nv.volumes?.[0]) nv.volumes[0].colormap = options.colormap || 'gray';
      nv.updateGLVolume?.(); nv.drawScene?.(); this.compareViewers.set(session.id, { nv, file: session.file });
    }
    return Boolean(visible.length);
  }
  clearComparisonView(container = null) { for (const { nv } of this.compareViewers.values()) { nv.volumes = []; nv.gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.(); } this.compareViewers.clear(); this.releaseUnusedObjectUrls(); if (container) { container.innerHTML = ''; container.dataset.count = '0'; } }
  setComparisonViewType(type) { for (const { nv } of this.compareViewers.values()) { this.applyViewTypeToNv(nv, type); nv.drawScene?.(); } }
  setComparisonColormap(colormap) { for (const { nv } of this.compareViewers.values()) { if (nv.volumes?.[0]) nv.volumes[0].colormap = colormap; nv.updateGLVolume?.(); nv.drawScene?.(); } }
  getComparisonViewerCount() { return this.compareViewers.size; }
  saveScreenshot(filename = `viewer-${new Date().toISOString().replace(/[:.]/g, '-')}.png`) { this.nv?.saveScene?.(filename); }
  downloadCurrentVolume(filename = null) { const volume = this.nv?.volumes?.at(-1); if (!volume) return false; downloadArrayBuffer(createNiftiFromVolume(volume), filename || `${volume.name || 'volume'}.nii`); return true; }
  dispose() { this.clearComparisonView(); this.clearVolumes(); for (const url of this.objectUrls.values()) URL.revokeObjectURL(url); this.objectUrls.clear(); this.nv = null; }
}
