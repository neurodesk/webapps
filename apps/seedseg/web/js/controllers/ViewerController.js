/**
 * ViewerController
 *
 * Manages NiiVue visualization with support for base volume and segmentation overlays.
 */

export class ViewerController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.currentBaseFile = null;
    this.currentOverlayFile = null;
  }

  async loadBaseVolume(file) {
    try {
      this.updateOutput(`Loading ${file.name}...`);
      const url = URL.createObjectURL(file);
      await this.nv.loadVolumes([{ url: url, name: file.name }]);
      URL.revokeObjectURL(url);
      this.currentBaseFile = file;
      this.currentOverlayFile = null;
      this.updateOutput(`${file.name} loaded`);
    } catch (error) {
      this.updateOutput(`Error loading ${file.name}: ${error.message}`);
      console.error(error);
    }
  }

  async loadOverlay(file, colormap = 'red', opacity = 0.5) {
    try {
      const url = URL.createObjectURL(file);
      await this.nv.addVolumeFromUrl({ url: url, name: file.name, colormap: colormap });
      URL.revokeObjectURL(url);

      // Set overlay opacity
      if (this.nv.volumes.length > 1) {
        this.nv.setOpacity(1, opacity);
      }

      this.currentOverlayFile = file;
    } catch (error) {
      this.updateOutput(`Error loading overlay: ${error.message}`);
      console.error(error);
    }
  }

  async showResultAsOverlay(baseFile, overlayFile, colormap = 'red') {
    await this.loadBaseVolume(baseFile);
    if (overlayFile) {
      await this.loadOverlay(overlayFile, colormap);
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

  setOverlayOpacity(value) {
    if (this.nv.volumes.length > 1) {
      this.nv.setOpacity(1, value);
    }
  }

  setOverlayColormap(colormap) {
    if (this.nv.volumes.length > 1) {
      this.nv.volumes[1].colormap = colormap;
      this.nv.updateGLVolume();
    }
  }

  getCurrentFile() {
    return this.currentBaseFile;
  }
}
