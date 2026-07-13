/**
 * FileIOController
 *
 * Handles single T1-weighted MRI file input for prostate segmentation.
 * Unified input — accepts NIfTI or converted DICOM.
 */

export class FileIOController {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});

    this.activeFile = null;
  }

  getActiveFile() {
    return this.activeFile;
  }

  hasValidData() {
    return this.activeFile !== null;
  }

  setFile(file) {
    this.activeFile = file;
    this.onFileLoaded(file);
  }

  clearFile() {
    this.activeFile = null;
  }
}
