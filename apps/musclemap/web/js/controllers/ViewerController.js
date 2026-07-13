/**
 * ViewerController
 *
 * Manages NiiVue visualization with support for base volume and segmentation overlays.
 * Adapted for MuscleMap's discrete 100-class colormap.
 */

import { createUint8PreviewNiftiFile } from '../modules/file-io/NiftiUtils.js?v=1.2.35';

const LARGE_VOLUME_DISPLAY_LIMIT_BYTES = 256 * 1024 ** 2;
const COMPRESSED_NIFTI_DISPLAY_LIMIT_BYTES = 100 * 1024 ** 2;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';

  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export class ViewerController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.currentBaseFile = null;
    this.currentBaseDisplayFile = null;
    this.currentOverlayFile = null;
    this.currentBaseDisplayMode = 'original';
    this.muscleColormapRegistered = false;
  }

  isAvailable() {
    return !!this.nv;
  }

  /**
   * Register the MuscleMap discrete colormap with NiiVue.
   * @param {Object} colormapData - { R, G, B, A } arrays from labels.js
   */
  registerMuscleColormap(colormapData) {
    if (!this.isAvailable()) return;
    try {
      this.nv.addColormap('musclemap', colormapData);
      this.muscleColormapRegistered = true;
    } catch (e) {
      console.warn('Could not register musclemap colormap:', e);
    }
  }

  async loadBaseVolume(file, { opacity = 1 } = {}) {
    if (!this.isAvailable()) return false;
    let displayFile = null;
    try {
      displayFile = await this._createBaseDisplayFile(file);
      let loaded = await this._tryLoadDisplayFile(displayFile, { opacity });

      if (!loaded && displayFile === file && this._isNiftiFile(file)) {
        this.updateOutput('Retrying viewer load with an 8-bit display preview...');
        displayFile = await this._createBaseDisplayFile(file, { forcePreview: true });
        loaded = await this._tryLoadDisplayFile(displayFile, { opacity });
      }

      if (!loaded) return false;

      this.currentBaseFile = file;
      this.currentBaseDisplayFile = displayFile;
      this.currentOverlayFile = null;
      this.updateOutput(`${displayFile.name} loaded`);
      return true;
    } catch (error) {
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      console.error(error);
      this.currentBaseFile = null;
      this.currentBaseDisplayFile = null;
      this.currentOverlayFile = null;
      return false;
    }
  }

  async _tryLoadDisplayFile(displayFile, { opacity = 1 } = {}) {
    this.updateOutput(`Loading ${displayFile.name}...`);
    try {
      await this._withNiivueErrorCapture(async () => {
        const url = URL.createObjectURL(displayFile);
        try {
          await this.nv.loadVolumes([{ url: url, name: displayFile.name }]);
          if (this.nv.volumes.length > 0) {
            this.nv.setOpacity(0, opacity);
          }
          this.nv.drawScene?.();
          await this._nextFrame();
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      return true;
    } catch (error) {
      this.updateOutput(`Viewer load failed for ${displayFile.name}: ${error.message}`);
      console.error(error);
      return false;
    }
  }

  async _withNiivueErrorCapture(action) {
    const capturedErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => {
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ');
      if (message.includes('niivue-error')) capturedErrors.push(message);
      originalConsoleError.apply(console, args);
    };

    try {
      const result = await action();
      if (capturedErrors.length > 0) {
        throw new Error(capturedErrors[0]);
      }
      return result;
    } finally {
      console.error = originalConsoleError;
    }
  }

  _nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async _createBaseDisplayFile(file, { forcePreview = false } = {}) {
    this.currentBaseDisplayMode = 'original';
    if (!forcePreview && !this._shouldUseUint8Preview(file)) return file;

    if (forcePreview) {
      this.updateOutput('Preparing an 8-bit downsampled preview for display; segmentation will use the original NIfTI data.');
    } else {
      this.updateOutput(
        `Warning: ${file.name} is ${formatBytes(file.size)}, which can exceed browser GPU texture limits. ` +
        'Displaying an 8-bit downsampled preview; segmentation will use the original NIfTI data.'
      );
    }

    try {
      const preview = await createUint8PreviewNiftiFile(file);
      this.currentBaseDisplayMode = 'uint8-preview';
      const dimensionSummary = preview.originalDims?.join('x') === preview.dims.join('x')
        ? preview.dims.join('x')
        : `${preview.originalDims.join('x')} -> ${preview.dims.join('x')}`;
      this.updateOutput(
        `Prepared 8-bit display preview (${dimensionSummary}, ` +
        `${formatBytes(preview.previewBytes)}, intensity ${preview.sourceMin.toPrecision(4)}..${preview.sourceMax.toPrecision(4)}).`
      );
      return preview.file;
    } catch (error) {
      this.currentBaseDisplayMode = 'original';
      if (forcePreview) {
        this.updateOutput(`Warning: 8-bit display preview failed: ${error.message}. Falling back to 2D preview.`);
        throw error;
      }
      this.updateOutput(`Warning: 8-bit display preview failed: ${error.message}. Trying the original volume.`);
      return file;
    }
  }

  _shouldUseUint8Preview(file) {
    if (!this._isNiftiFile(file)) return false;
    const size = file?.size || 0;
    return size >= this._displayPreviewThresholdBytes(file);
  }

  _displayPreviewThresholdBytes(file) {
    const name = file?.name?.toLowerCase?.() || '';
    return name.endsWith('.nii.gz')
      ? COMPRESSED_NIFTI_DISPLAY_LIMIT_BYTES
      : LARGE_VOLUME_DISPLAY_LIMIT_BYTES;
  }

  _isNiftiFile(file) {
    const name = file?.name?.toLowerCase?.() || '';
    return name.endsWith('.nii') || name.endsWith('.nii.gz');
  }

  async loadOverlay(file, colormap = 'musclemap', opacity = 0.5) {
    if (!this.isAvailable()) return;
    try {
      const url = URL.createObjectURL(file);
      await this.nv.addVolumeFromUrl({ url: url, name: file.name, colormap: colormap });
      URL.revokeObjectURL(url);

      if (this.nv.volumes.length > 1) {
        // Force display range so uint8 label values map 1:1 to colormap indices.
        // NiiVue auto-detects range from data (e.g. 0-8), which compresses all
        // labels into the first few % of the LUT. Setting cal_max=255 ensures
        // value N maps to colormap entry N.
        this.nv.volumes[1].cal_min = 0;
        this.nv.volumes[1].cal_max = 255;
        this.nv.setOpacity(1, opacity);
        this.nv.updateGLVolume();
      }

      this.currentOverlayFile = file;
    } catch (error) {
      this.updateOutput(`Error loading overlay: ${error.message}`);
      console.error(error);
    }
  }

  async replaceOverlay(file, colormap = 'musclemap', opacity = 0.5) {
    if (!this.isAvailable()) return false;
    if (!this.nv.volumes?.length) return false;

    await this.clearOverlayVolumes();
    await this.loadOverlay(file, colormap, opacity);
    return true;
  }

  async clearOverlayVolumes() {
    if (!this.isAvailable() || !this.nv.volumes?.length) return;

    while (this.nv.volumes.length > 1) {
      const overlay = this.nv.volumes[this.nv.volumes.length - 1];
      if (typeof this.nv.removeVolume === 'function') {
        const before = this.nv.volumes.length;
        try {
          await this.nv.removeVolume(overlay);
        } catch {
          this.nv.volumes.pop();
        }
        if (this.nv.volumes.length === before) this.nv.volumes.pop();
      } else {
        this.nv.volumes.pop();
      }
    }
    this.currentOverlayFile = null;
    this.nv.updateGLVolume?.();
  }

  async showResultAsOverlay(baseFile, overlayFile, colormap = 'musclemap', { baseOpacity = 1, overlayOpacity = 0.5 } = {}) {
    await this.loadBaseVolume(baseFile, { opacity: baseOpacity });
    if (overlayFile) {
      await this.loadOverlay(overlayFile, colormap, overlayOpacity);
    }
  }

  setViewType(type) {
    if (!this.isAvailable()) return;
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
    if (!this.isAvailable()) return;
    if (this.nv.volumes.length > 0) {
      this.nv.setOpacity(0, value);
      this.nv.updateGLVolume();
    }
  }

  setOverlayOpacity(value) {
    if (!this.isAvailable()) return;
    if (this.nv.volumes.length > 1) {
      this.nv.setOpacity(1, value);
      this.nv.updateGLVolume();
    }
  }

  setOverlayColormap(colormap) {
    if (!this.isAvailable()) return;
    if (this.nv.volumes.length > 1) {
      this.nv.volumes[1].colormap = colormap;
      this.nv.updateGLVolume();
    }
  }

  getCurrentFile() {
    return this.currentBaseFile;
  }

  isBasePreviewActive() {
    return this.currentBaseDisplayMode !== 'original' &&
      !!this.currentBaseFile &&
      !!this.currentBaseDisplayFile &&
      this.currentBaseDisplayFile !== this.currentBaseFile;
  }
}
