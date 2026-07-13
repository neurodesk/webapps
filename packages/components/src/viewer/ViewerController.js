import { createNiftiFromVolume } from '../file-io/NiftiUtils.js';
import { downloadArrayBuffer } from '../file-io/download.js';

export class ViewerController {
  constructor(options = {}) {
    this.nv = options.nv;
    if (!this.nv) throw new Error('ViewerController requires a NiiVue instance');
    this.updateOutput = options.updateOutput || (() => {});
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.currentFile = null;
    this.currentStage = null;
    this.volumeStageIndices = new Map();
    this.registeredColormaps = new Set();
  }

  registerColormap(colormapId, colormapData) {
    if (!colormapId || !colormapData) return false;
    try {
      this.nv.addColormap(colormapId, colormapData);
      this.registeredColormaps.add(colormapId);
      return true;
    } catch (error) {
      this.updateOutput(`Could not register colormap ${colormapId}: ${error.message}`);
      return false;
    }
  }

  async loadBaseVolume(file, options = {}) {
    const url = URL.createObjectURL(file);
    try {
      this.updateOutput(`Loading ${file.name}...`);
      await this.nv.loadVolumes([{ url, name: file.name }]);
      this.currentBaseFile = file;
      this.currentFile = file;
      this.currentOverlayFile = null;
      this.currentOverlayIndex = null;
      this.currentStage = options.stage || null;
      this.volumeStageIndices.clear();
      if (options.stage) this.volumeStageIndices.set(options.stage, 0);
      this.updateOutput(`${file.name} loaded`);
      return true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async loadOverlay(file, options = {}) {
    const colormap = options.colormap || 'red';
    const opacity = options.opacity ?? 0.5;
    const url = URL.createObjectURL(file);
    try {
      await this.nv.addVolumeFromUrl({ url, name: file.name, colormap, opacity });
      const overlayIndex = this.nv.volumes.length - 1;
      if (overlayIndex > 0) {
        this.configureLabelVolume(overlayIndex, colormap);
        this.nv.setOpacity?.(overlayIndex, opacity);
        this.nv.updateGLVolume?.();
        this.nv.drawScene?.();
      }
      this.currentOverlayFile = file;
      this.currentOverlayIndex = overlayIndex > 0 ? overlayIndex : null;
      this.currentFile = file;
      if (options.stage) this.volumeStageIndices.set(options.stage, overlayIndex);
      return overlayIndex;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async loadSegmentationAsBase(file, options = {}) {
    await this.loadBaseVolume(file, options);
    this.configureLabelVolume(0, options.colormap || 'labels');
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  async loadVolumeStack(entries = []) {
    if (!entries.length) {
      this.clearVolumes();
      return;
    }
    const [base, ...overlays] = entries;
    await this.loadBaseVolume(base.file, { stage: base.stage });
    if (base.labelMask) this.configureLabelVolume(0, base.colormap || 'labels');
    for (const entry of overlays) {
      await this.loadOverlay(entry.file, {
        stage: entry.stage,
        colormap: entry.colormap || 'labels',
        opacity: entry.opacity ?? 0.5
      });
    }
  }

  configureLabelVolume(index, colormap = 'labels') {
    const volume = this.nv.volumes[index];
    if (!volume) return;
    volume.cal_min = 0;
    volume.cal_max = Math.max(1, this.getVolumeDataMax(volume));
    volume.colormap = colormap;
    volume.interpolation = false;
    if (typeof this.nv.setColormap === 'function' && volume.id) this.nv.setColormap(volume.id, colormap);
  }

  setViewType(type) {
    const typeMap = {
      multiplanar: this.nv.sliceTypeMultiplanar,
      axial: this.nv.sliceTypeAxial,
      coronal: this.nv.sliceTypeCoronal,
      sagittal: this.nv.sliceTypeSagittal,
      render: this.nv.sliceTypeRender
    };
    if (typeMap[type] !== undefined) this.nv.setSliceType(typeMap[type]);
  }

  setBaseOpacity(value) {
    if (this.nv.volumes.length) {
      this.nv.setOpacity?.(0, Number(value));
      this.nv.updateGLVolume?.();
    }
  }

  setOverlayOpacity(value) {
    for (const index of this.getOverlayIndices()) this.nv.setOpacity?.(index, Number(value));
    this.nv.updateGLVolume?.();
  }

  setOverlayColormap(colormap) {
    for (const index of this.getOverlayIndices()) {
      const volume = this.nv.volumes[index];
      if (!volume) continue;
      volume.colormap = colormap;
      if (typeof this.nv.setColormap === 'function' && volume.id) this.nv.setColormap(volume.id, colormap);
    }
    this.nv.updateGLVolume?.();
  }

  setInterpolation(enabled) {
    for (const volume of this.nv.volumes || []) volume.interpolation = Boolean(enabled);
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  setColorbarVisible(visible) {
    this.nv.opts = this.nv.opts || {};
    this.nv.opts.isColorbar = Boolean(visible);
    this.nv.drawScene?.();
  }

  setCrosshairVisible(visible, width = 0.75) {
    this.nv.opts = this.nv.opts || {};
    this.nv.opts.crosshairWidth = visible ? width : 0;
    this.nv.drawScene?.();
  }

  setWindowLevel(min, max, volumeIndex = 0) {
    const volume = this.nv.volumes?.[volumeIndex];
    if (!volume) return;
    volume.cal_min = Number(min);
    volume.cal_max = Number(max);
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  clearVolumes() {
    this.nv.volumes = [];
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.currentFile = null;
    this.currentStage = null;
    this.volumeStageIndices.clear();
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  clearOverlay() {
    const index = this.getOverlayIndex();
    if (index === null) return;
    if (typeof this.nv.removeVolumeByIndex === 'function') this.nv.removeVolumeByIndex(index);
    else this.nv.volumes.splice(index, 1);
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  getOverlayIndex() {
    if (this.currentOverlayIndex !== null && this.nv.volumes[this.currentOverlayIndex]) return this.currentOverlayIndex;
    return this.nv.volumes.length > 1 ? this.nv.volumes.length - 1 : null;
  }

  getOverlayIndices() {
    return (this.nv.volumes || []).map((_, index) => index).filter(index => index > 0);
  }

  getVolumeIndexForStage(stage) {
    const index = this.volumeStageIndices.get(stage);
    return index !== undefined && this.nv.volumes[index] ? index : null;
  }

  getCurrentFile() {
    return this.currentFile || this.currentBaseFile;
  }

  getVolumeDataMax(volume) {
    if (volume?.img?.length) {
      let max = -Infinity;
      for (const value of volume.img) if (Number.isFinite(value) && value > max) max = value;
      if (Number.isFinite(max)) return max;
    }
    return volume?.global_max ?? 1;
  }

  saveScreenshot(filename = `viewer-${new Date().toISOString().replace(/[:.]/g, '-')}.png`) {
    this.nv.saveScene?.(filename);
    this.updateOutput(`Screenshot saved: ${filename}`);
  }

  downloadCurrentVolume(filename = null) {
    const volume = this.nv.volumes?.[this.nv.volumes.length - 1];
    if (!volume) {
      this.updateOutput('No volume available for download');
      return false;
    }
    const buffer = createNiftiFromVolume(volume);
    const name = filename || `${volume.name || 'volume'}.nii`;
    downloadArrayBuffer(buffer, name);
    return true;
  }
}
