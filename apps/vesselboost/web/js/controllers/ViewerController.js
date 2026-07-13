import { assertSameSpace, assertVolumeStackSpaces } from '../modules/spatial-file.js';

/**
 * ViewerController
 *
 * Manages NiiVue visualization with stage-aware base volumes and overlays.
 * Stage visibility is applied through opacity so toggles do not destroy
 * the active volume stack or silently shift overlay indices.
 */
export class ViewerController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.vesselColormapRegistered = false;
    this.volumeStageIndices = new Map();
    this.stageVisibility = new Map();
    this.stageOpacity = new Map();
  }

  /**
   * Register the VesselBoost discrete colormap with NiiVue.
   * @param {Object} colormapData - { R, G, B, A } arrays from labels.js
   */
  registerVesselColormap(colormapData) {
    try {
      this.nv.addColormap('vesselboost', colormapData);
      this.vesselColormapRegistered = true;
    } catch (e) {
      console.warn('Could not register vesselboost colormap:', e);
    }
  }

  async loadBaseVolume(file, options = {}) {
    try {
      this.updateOutput(`Loading ${file.name}...`);
      const url = URL.createObjectURL(file);
      await this.nv.loadVolumes([{ url: url, name: file.name }]);
      URL.revokeObjectURL(url);
      this.currentBaseFile = file;
      this.currentOverlayFile = null;
      this.currentOverlayIndex = null;
      this.volumeStageIndices.clear();
      if (options.stage) {
        this.volumeStageIndices.set(options.stage, 0);
        this.setStageOpacity(options.stage, options.opacity ?? 1);
        this.setStageVisibilityState(options.stage, options.visible !== false, options.visible !== undefined);
        this.applyStageOpacity(options.stage);
      }
      this.updateOutput(`${file.name} loaded`);
      return true;
    } catch (error) {
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      console.error(error);
      return false;
    }
  }

  async loadVolumeStack(entries) {
    if (!entries?.length) {
      this.clearVolumes();
      return true;
    }

    try {
      assertVolumeStackSpaces(entries, 'Viewer volume stack');
      const [baseEntry, ...overlayEntries] = entries;
      await this.loadBaseVolume(baseEntry.file, {
        stage: baseEntry.stage,
        visible: baseEntry.visible,
        opacity: baseEntry.opacity
      });
      if (baseEntry.labelMask) {
        this.configureSegmentationVolume(0, baseEntry.colormap || 'vesselboost');
      }
      for (const entry of overlayEntries) {
        await this.loadOverlay(
          entry.file,
          entry.colormap || 'vesselboost',
          entry.opacity ?? 0.5,
          {
            stage: entry.stage,
            scalar: entry.scalar,
            visible: entry.visible
          }
        );
      }
      return true;
    } catch (error) {
      this.updateOutput(`Error loading viewer volumes: ${error.message}`);
      console.error(error);
      return false;
    }
  }

  async loadOverlay(file, colormap = 'vesselboost', opacity = 0.5, options = {}) {
    try {
      if (this.currentBaseFile) {
        assertSameSpace(this.currentBaseFile, file, `${options.stage || file.name} overlay`);
      }
      const url = URL.createObjectURL(file);
      await this.nv.addVolumeFromUrl({ url: url, name: file.name, colormap: colormap, opacity });
      URL.revokeObjectURL(url);

      const overlayIndex = this.nv.volumes.length - 1;
      if (overlayIndex > 0) {
        if (options.scalar) this.configureScalarVolume(overlayIndex, colormap);
        else this.configureSegmentationVolume(overlayIndex, colormap);
        this.nv.setOpacity(overlayIndex, opacity);
        this.nv.updateGLVolume();
        this.nv.drawScene?.();
      }

      this.currentOverlayFile = file;
      this.currentOverlayIndex = overlayIndex > 0 ? overlayIndex : null;
      if (options.stage) {
        this.volumeStageIndices.set(options.stage, overlayIndex);
        this.setStageOpacity(options.stage, opacity);
        this.setStageVisibilityState(options.stage, options.visible !== false, options.visible !== undefined);
        this.applyStageOpacity(options.stage);
      }
      return true;
    } catch (error) {
      this.updateOutput(`Error loading overlay: ${error.message}`);
      console.error(error);
      return false;
    }
  }

  async replaceOverlayForStage(stage, file, colormap = 'vesselboost', opacity = 0.5, options = {}) {
    this.removeVolumeForStage(stage);
    return this.loadOverlay(file, colormap, opacity, { ...options, stage });
  }

  async showResultAsOverlay(baseFile, overlayFile, colormap = 'vesselboost') {
    await this.loadBaseVolume(baseFile);
    if (overlayFile) {
      await this.loadOverlay(overlayFile, colormap);
    }
  }

  clearVolumes() {
    this.nv.volumes = [];
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
    this.currentOverlayIndex = null;
    this.volumeStageIndices.clear();
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
  }

  removeVolumeAtIndex(index) {
    if (index === null || index === undefined || index < 0 || !this.nv.volumes[index]) return false;
    if (typeof this.nv.removeVolumeByIndex === 'function') {
      this.nv.removeVolumeByIndex(index);
    } else {
      this.nv.volumes.splice(index, 1);
      this.nv.updateGLVolume?.();
      this.nv.drawScene?.();
    }

    for (const [stage, mappedIndex] of [...this.volumeStageIndices.entries()]) {
      if (mappedIndex === index) this.volumeStageIndices.delete(stage);
      else if (mappedIndex > index) this.volumeStageIndices.set(stage, mappedIndex - 1);
    }
    if (this.currentOverlayIndex !== null) {
      if (this.currentOverlayIndex === index) this.currentOverlayIndex = null;
      else if (this.currentOverlayIndex > index) this.currentOverlayIndex -= 1;
    }
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
    return true;
  }

  removeVolumeForStage(stage) {
    const index = this.getVolumeIndexForStage(stage);
    if (index === null || index === 0) return false;
    return this.removeVolumeAtIndex(index);
  }

  configureSegmentationVolume(index, colormap) {
    const volume = this.nv.volumes[index];
    if (!volume) return;
    volume.cal_min = 0;
    volume.cal_max = Math.max(1, this.getVolumeDataMax(volume));
    volume.colormap = colormap;
    volume.interpolation = false;
    if (typeof this.nv.setColormap === 'function' && volume.id) {
      this.nv.setColormap(volume.id, colormap);
    }
  }

  configureScalarVolume(index, colormap) {
    const volume = this.nv.volumes[index];
    if (!volume) return;
    const range = this.getVolumeDataRange(volume);
    volume.cal_min = range.min;
    volume.cal_max = range.max > range.min ? range.max : range.min + 1;
    volume.colormap = colormap;
    volume.interpolation = true;
    if (typeof this.nv.setColormap === 'function' && volume.id) {
      this.nv.setColormap(volume.id, colormap);
    }
  }

  setViewType(type) {
    const typeMap = {
      multiplanar: this.nv.sliceTypeMultiplanar,
      axial: this.nv.sliceTypeAxial,
      coronal: this.nv.sliceTypeCoronal,
      sagittal: this.nv.sliceTypeSagittal,
      render: this.nv.sliceTypeRender
    };
    if (typeMap[type] !== undefined) {
      this.nv.setSliceType(typeMap[type]);
    }
  }

  setBaseOpacity(value) {
    if (this.nv.volumes.length > 0) {
      const stage = this.getStageForVolumeIndex(0);
      if (stage) this.setStageOpacity(stage, value);
      this.nv.setOpacity(0, this.isStageVisible(stage) ? value : 0);
      this.nv.updateGLVolume();
    }
  }

  setOverlayOpacity(value) {
    const overlayIndices = this.getOverlayIndices();
    if (overlayIndices.length) {
      overlayIndices.forEach(index => {
        const stage = this.getStageForVolumeIndex(index);
        if (stage) this.setStageOpacity(stage, value);
        this.nv.setOpacity(index, this.isStageVisible(stage) ? value : 0);
      });
      this.nv.updateGLVolume();
    }
  }

  setStageOpacity(stage, opacity, options = {}) {
    if (!stage || !Number.isFinite(opacity)) return false;
    this.stageOpacity.set(stage, opacity);
    if (!options.apply) return true;
    const applied = this.applyStageOpacity(stage);
    if (applied && options.redraw) {
      this.nv.updateGLVolume?.();
      this.nv.drawScene?.();
    }
    return applied;
  }

  setStageVisibilityState(stage, visible, force = false) {
    if (!stage) return;
    if (force || !this.stageVisibility.has(stage)) {
      this.stageVisibility.set(stage, visible);
    }
  }

  setStageVisible(stage, visible) {
    if (!stage) return false;
    this.stageVisibility.set(stage, !!visible);
    const applied = this.applyStageOpacity(stage);
    if (applied) {
      this.nv.updateGLVolume?.();
      this.nv.drawScene?.();
    }
    return applied;
  }

  isStageVisible(stage) {
    if (!stage) return true;
    return this.stageVisibility.get(stage) !== false;
  }

  applyStageOpacity(stage) {
    const index = this.getVolumeIndexForStage(stage);
    if (index === null) return false;
    const opacity = this.isStageVisible(stage)
      ? (this.stageOpacity.get(stage) ?? (index === 0 ? 1 : 0.5))
      : 0;
    if (this.nv.volumes?.[index]) this.nv.volumes[index].opacity = opacity;
    this.nv.setOpacity(index, opacity);
    return true;
  }

  setOverlayColormap(colormap) {
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

  getStageForVolumeIndex(index) {
    for (const [stage, mappedIndex] of this.volumeStageIndices.entries()) {
      if (mappedIndex === index) return stage;
    }
    return null;
  }

  getVolumeIndexForStage(stage) {
    const index = this.volumeStageIndices.get(stage);
    if (index === undefined || !this.nv.volumes[index]) return null;
    return index;
  }

  getOverlayIndex() {
    if (this.currentOverlayIndex !== null && this.nv.volumes[this.currentOverlayIndex]) {
      return this.currentOverlayIndex;
    }
    return this.nv.volumes.length > 1 ? this.nv.volumes.length - 1 : null;
  }

  getOverlayIndices() {
    return this.nv.volumes
      .map((_, index) => index)
      .filter(index => index > 0);
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

  getVolumeDataRange(volume) {
    let minValue = Infinity;
    let maxValue = -Infinity;
    if (volume?.img?.length) {
      for (let i = 0; i < volume.img.length; i++) {
        const value = volume.img[i];
        if (!Number.isFinite(value)) continue;
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
      }
    }
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      minValue = Number.isFinite(volume?.global_min) ? volume.global_min : 0;
      maxValue = Number.isFinite(volume?.global_max) ? volume.global_max : 1;
    }
    return { min: minValue, max: maxValue };
  }

  getCurrentFile() {
    return this.currentBaseFile;
  }
}
